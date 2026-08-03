import assert from 'node:assert/strict'
import test from 'node:test'
import { MicrophonePipelineProcessor } from '../src/audio/MicrophonePipelineProcessor.ts'

// 处理器编排缝：选项→管线图形态（直通/增强）、补益常量与传值、能力未就绪回退。
// RNNoise worklet 本体与真实降噪效果不在本缝覆盖范围（见 spec.md 测试决策）。

Object.defineProperty(globalThis, 'MediaStream', {
  value: class MediaStream {
    tracks: MediaStreamTrack[]
    constructor(tracks: MediaStreamTrack[]) {
      this.tracks = tracks
    }
    getAudioTracks() {
      return this.tracks
    }
  },
  configurable: true,
})

class FakeNode {
  connectCalls: unknown[] = []
  disconnectCalls = 0
  destroyCalls = 0
  gain = { value: 1, setTargetAtTime: () => undefined }
  gainSetters: Array<[number, number]> = []
  channelCount = 2
  channelCountMode = 'max'

  connect(target: unknown) {
    this.connectCalls.push(target)
  }

  disconnect() {
    this.disconnectCalls += 1
  }

  destroy() {
    this.destroyCalls += 1
    this.disconnectCalls += 1
  }
}

class FakeAudioContext {
  readonly sampleRate: number
  readonly source = new FakeNode()
  // 首个 createGain 调用即用户增益节点（connect 时先创建）。
  readonly gain = new FakeNode()
  readonly makeupGains: FakeNode[] = []
  readonly destination = new FakeNode() as FakeNode & { stream: { getAudioTracks(): unknown[] } }
  currentTime = 0
  state: AudioContextState = 'running'
  private createGainCalls = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    const processedTrack = { stop: () => undefined, label: 'fake-processed' }
    this.destination.stream = {
      getAudioTracks: () => [processedTrack],
    }
  }

  setState(state: AudioContextState) {
    this.state = state
  }

  createMediaStreamSource() {
    return this.source
  }

  createGain() {
    this.createGainCalls += 1
    if (this.createGainCalls === 1) return this.gain
    const node = new FakeNode()
    this.makeupGains.push(node)
    return node
  }

  createMediaStreamDestination() {
    return this.destination
  }
}

const fakeTrack = { kind: 'audio', label: 'fake-mic' } as unknown as MediaStreamTrack

interface Harness {
  context: FakeAudioContext
  processor: MicrophonePipelineProcessor
}

function makeHarness(options: {
  noiseSuppression: 'off' | 'webrtc' | 'rnnoise'
  loadRnnoiseBinary?: () => Promise<ArrayBuffer | null>
  sampleRate?: number
  rnnoiseCaptureAllowed?: boolean
  createRnnoiseNode?: (context: AudioContext, binary: ArrayBuffer) => Promise<FakeNode | null>
  onRnnoiseUnavailable?: () => void | Promise<void>
}) {
  const context = new FakeAudioContext(options.sampleRate ?? 48_000)
  const processor = new MicrophonePipelineProcessor({
    gain: 1,
    noiseSuppression: options.noiseSuppression,
    loadRnnoiseBinary: options.loadRnnoiseBinary ?? (async () => new ArrayBuffer(1)),
    createRnnoiseNode: options.createRnnoiseNode
      ? async (context, binary) => options.createRnnoiseNode!(context, binary) as never
      : async () => new FakeNode() as never,
    onRnnoiseUnavailable: options.onRnnoiseUnavailable,
    rnnoiseCaptureAllowed: options.rnnoiseCaptureAllowed,
  })
  return { context, processor }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('init 建立 source→gain→destination 直通图并产出处理轨', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'webrtc' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  assert.equal(context.source.connectCalls[0], context.gain)
  assert.equal(context.gain.connectCalls[0], context.destination)
  assert.equal(processor.processedTrack, context.destination.stream.getAudioTracks()[0])
})

test('降噪选项切换到关闭/系统降噪保持直通且不创建降噪节点', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  const initialGainConnections = context.gain.connectCalls.length
  await processor.setNoiseSuppression('off')
  assert.equal(context.source.connectCalls.at(-1), context.gain)
  assert.equal(context.gain.connectCalls.length, initialGainConnections + 1)
  await processor.setNoiseSuppression('webrtc')
  assert.equal(context.source.connectCalls.at(-1), context.gain)
  assert.equal(context.gain.connectCalls.length, initialGainConnections + 2)
})

test('增强降噪资源未就绪时保持直通（回退系统降噪，设置不变）', async () => {
  const { context, processor } = makeHarness({
    noiseSuppression: 'rnnoise',
    loadRnnoiseBinary: async () => null,
  })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('资源就绪且上下文为 48kHz 时启用降噪路径（source→降噪→补益→gain）', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const rnnoiseNode = context.source.connectCalls.at(-1) as FakeNode
  assert.notEqual(rnnoiseNode, context.gain)
  const makeupNode = rnnoiseNode.connectCalls[0] as FakeNode
  assert.notEqual(makeupNode, context.gain)
  assert.equal(makeupNode.connectCalls[0], context.gain)
  assert.equal(context.gain.connectCalls[0], context.destination)
  assert.equal(makeupNode.gain.value, 1.41)
  assert.equal(rnnoiseNode.channelCount, 1)
  assert.equal(rnnoiseNode.channelCountMode, 'explicit')
  // 用户增益调节只作用于用户增益节点，补益保持固定常量。
  processor.setGain(0.5)
  assert.equal(makeupNode.gain.value, 1.41)
})

test('切走系统降噪再切回增强降噪时重新创建降噪节点并保持单声道', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  const firstNode = context.source.connectCalls.at(-1) as FakeNode
  const firstMakeup = firstNode.connectCalls[0] as FakeNode
  assert.notEqual(firstNode, context.gain)
  assert.equal(firstMakeup.connectCalls[0], context.gain)
  await processor.setNoiseSuppression('webrtc')
  processor.setCaptureNoiseSuppression(true)
  assert.equal(context.source.connectCalls.at(-1), context.gain)
  // 补益节点随降噪节点一并销毁。
  assert.ok(firstMakeup.disconnectCalls >= 1)
  processor.setCaptureNoiseSuppression(false)
  await processor.setNoiseSuppression('rnnoise')
  await flushPromises()
  const secondNode = context.source.connectCalls.at(-1) as FakeNode
  assert.notEqual(secondNode, context.gain)
  assert.notEqual(secondNode, firstNode)
  const secondMakeup = secondNode.connectCalls[0] as FakeNode
  assert.notEqual(secondMakeup, firstMakeup)
  assert.equal(secondMakeup.connectCalls[0], context.gain)
  assert.equal(secondMakeup.gain.value, 1.41)
  assert.equal(secondNode.channelCount, 1)
  assert.equal(secondNode.channelCountMode, 'explicit')
})

test('销毁时补益节点随降噪节点一并断开', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  const rnnoiseNode = context.source.connectCalls.at(-1) as FakeNode
  const makeupNode = rnnoiseNode.connectCalls[0] as FakeNode
  // 重建路径时补益节点会被断开一次（与降噪节点同模式），以销毁前为基准。
  const disconnectsBeforeDestroy = makeupNode.disconnectCalls
  await processor.destroy()
  assert.ok(makeupNode.disconnectCalls > disconnectsBeforeDestroy)
})

test('非 48kHz 上下文下增强降噪保持直通', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise', sampleRate: 44_100 })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('采集约束已启用 WebRTC 时，能力后来就绪也不补挂 RNNoise', async () => {
  const { context, processor } = makeHarness({
    noiseSuppression: 'rnnoise',
    rnnoiseCaptureAllowed: false,
  })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('RNNoise 节点创建失败时通知回退并保持直通', async () => {
  let unavailable = 0
  const { context, processor } = makeHarness({
    noiseSuppression: 'rnnoise',
    createRnnoiseNode: async () => null,
    onRnnoiseUnavailable: () => { unavailable += 1 },
  })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  assert.equal(unavailable, 1)
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('RNNoise 二进制加载抛错时通知回退并保持直通', async () => {
  let unavailable = 0
  const { context, processor } = makeHarness({
    noiseSuppression: 'rnnoise',
    loadRnnoiseBinary: async () => { throw new Error('load failed') },
    onRnnoiseUnavailable: () => { unavailable += 1 },
  })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  assert.equal(unavailable, 1)
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('销毁期间迟到的 RNNoise 节点会被释放且不会重新接图', async () => {
  let resolveNode: (node: FakeNode) => void = () => undefined
  const lateNodePromise = new Promise<FakeNode>((resolve) => { resolveNode = resolve })
  const { processor } = makeHarness({
    noiseSuppression: 'rnnoise',
    createRnnoiseNode: async () => lateNodePromise,
  })
  await processor.init({ audioContext: new FakeAudioContext(48_000) as unknown as AudioContext, track: fakeTrack } as never)
  await Promise.resolve()
  const lateNode = new FakeNode()
  await processor.destroy()
  resolveNode(lateNode)
  await flushPromises()
  assert.equal(lateNode.destroyCalls, 1)
  assert.equal(processor.processedTrack, undefined)
})

test('切换降噪选项期间迟到的 RNNoise 节点会被释放', async () => {
  let resolveNode: (node: FakeNode) => void = () => undefined
  const lateNodePromise = new Promise<FakeNode>((resolve) => { resolveNode = resolve })
  const { context, processor } = makeHarness({
    noiseSuppression: 'rnnoise',
    createRnnoiseNode: async () => lateNodePromise,
  })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await Promise.resolve()
  await processor.setNoiseSuppression('off')
  const lateNode = new FakeNode()
  resolveNode(lateNode)
  await flushPromises()
  assert.equal(lateNode.destroyCalls, 1)
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('setGain 传递到增益节点', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'off' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  context.gain.gain.setTargetAtTime = (value: number, time: number) => {
    context.gain.gainSetters.push([value, time])
  }
  processor.setGain(0.5)
  assert.equal(context.gain.gainSetters[0]?.[0], 0.5)
})

test('音频上下文关闭后清理不再连接节点（不触发浏览器告警）', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await flushPromises()
  const connects = context.source.connectCalls.length
  assert.ok(connects > 0)
  context.setState('closed')
  await processor.destroy()
  assert.equal(context.source.connectCalls.length, connects)
})

test('destroy 释放处理轨与节点', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'off' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await processor.destroy()
  assert.equal(processor.processedTrack, undefined)
})
