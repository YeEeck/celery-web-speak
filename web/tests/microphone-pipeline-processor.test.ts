import assert from 'node:assert/strict'
import test from 'node:test'
import { MicrophonePipelineProcessor } from '../src/audio/MicrophonePipelineProcessor.ts'

// 处理器编排缝：选项→管线图形态（直通/增强）、增益传值、能力未就绪回退。
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
  gain = { value: 1, setTargetAtTime: () => undefined }
  gainSetters: Array<[number, number]> = []

  connect(target: unknown) {
    this.connectCalls.push(target)
  }

  disconnect() {
    this.disconnectCalls += 1
  }

  destroy() {
    this.disconnectCalls += 1
  }
}

class FakeAudioContext {
  readonly sampleRate: number
  readonly source = new FakeNode()
  readonly gain = new FakeNode()
  readonly destination = new FakeNode() as FakeNode & { stream: { getAudioTracks(): unknown[] } }
  currentTime = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    const processedTrack = { stop: () => undefined, label: 'fake-processed' }
    this.destination.stream = {
      getAudioTracks: () => [processedTrack],
    }
  }

  createMediaStreamSource() {
    return this.source
  }

  createGain() {
    return this.gain
  }

  createMediaStreamDestination() {
    return this.destination
  }
}

const fakeTrack = { kind: 'audio', label: 'fake-mic' } as unknown as MediaStreamTrack

interface Harness {
  context: FakeAudioContext
  processor: MicrophonePipelineProcessor
  state: { capable: boolean }
}

function makeHarness(options: {
  noiseSuppression: 'off' | 'webrtc' | 'rnnoise'
  rnnoiseCapable?: boolean
  sampleRate?: number
}) {
  const context = new FakeAudioContext(options.sampleRate ?? 48_000)
  const state = { capable: options.rnnoiseCapable ?? false }
  const processor = new MicrophonePipelineProcessor({
    gain: 1,
    noiseSuppression: options.noiseSuppression,
    rnnoiseCapable: () => state.capable,
    loadRnnoiseBinary: async () => (state.capable ? new ArrayBuffer(1) : null),
    createRnnoiseNode: async () => new FakeNode() as never,
  })
  return { context, processor, state }
}

test('init 建立 source→gain→destination 直通图并产出处理轨', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'webrtc' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  assert.equal(context.source.connectCalls[0], context.gain)
  assert.equal(context.gain.connectCalls[0], context.destination)
  assert.equal(processor.processedTrack, context.destination.stream.getAudioTracks()[0])
})

test('降噪选项切换到关闭/系统降噪保持直通且不创建降噪节点', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise', rnnoiseCapable: true })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await processor.setNoiseSuppression('off')
  assert.equal(context.source.connectCalls.at(-1), context.gain)
  await processor.setNoiseSuppression('webrtc')
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('增强降噪能力未就绪时保持直通（回退系统降噪，设置不变）', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise', rnnoiseCapable: false })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(context.source.connectCalls.at(-1), context.gain)
})

test('能力就绪且上下文为 48kHz 时启用降噪路径（source→降噪→gain）', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise', rnnoiseCapable: true })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const rnnoiseNode = context.source.connectCalls.at(-1)
  assert.notEqual(rnnoiseNode, context.gain)
  assert.equal((rnnoiseNode as FakeNode).connectCalls[0], context.gain)
  assert.equal(context.gain.connectCalls[0], context.destination)
})

test('非 48kHz 上下文下增强降噪保持直通', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'rnnoise', rnnoiseCapable: true, sampleRate: 44_100 })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
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

test('destroy 释放处理轨与节点', async () => {
  const { context, processor } = makeHarness({ noiseSuppression: 'off' })
  await processor.init({ audioContext: context as unknown as AudioContext, track: fakeTrack } as never)
  await processor.destroy()
  assert.equal(processor.processedTrack, undefined)
})
