import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MicrophonePublishOrchestrator,
  type MicrophonePublishTarget,
} from '../src/audio/MicrophonePublishOrchestrator.ts'
import type { NoiseSuppressionOption, VoiceTransmissionMode } from '../src/stores/voice-utils.ts'

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

class FakeAudioContext {
  state: AudioContextState = 'running'
  sampleRate = 48_000
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined }
  }
  createGain() {
    return { connect: () => undefined, disconnect: () => undefined, gain: { value: 1, setTargetAtTime: () => undefined } }
  }
  createMediaStreamDestination() {
    return {
      connect: () => undefined,
      disconnect: () => undefined,
      stream: { getAudioTracks: () => [{ stop: () => undefined }] },
    }
  }
}

class FakeTrack {
  constraints: MediaTrackConstraints = { noiseSuppression: true }
  processor: unknown = null
  restartCalls: Array<{ noiseSuppression: boolean }> = []
  setProcessorCalls = 0
  stopProcessorCalls = 0

  getProcessor() {
    return this.processor
  }

  // LiveKit 在 setProcessor 内调用 processor.init；这里模拟之，让回退编排
  // （节点创建失败 → onRnnoiseUnavailable）可以跑通。
  async setProcessor(processor: unknown) {
    this.setProcessorCalls += 1
    this.processor = processor
    const init = (processor as { init?: (options: unknown) => Promise<void> }).init
    await init?.call(processor, {
      audioContext: new FakeAudioContext(),
      track: { mediaStreamTrack: {} },
    })
  }

  async stopProcessor() {
    this.stopProcessorCalls += 1
    this.processor = null
  }

  async restartTrack(options: unknown) {
    this.restartCalls.push(options as { noiseSuppression: boolean })
    this.constraints = options as MediaTrackConstraints
  }
}

class FakeParticipant {
  isMicrophoneEnabled = true
  microphoneTrack: FakeTrack | null = null
  microphoneUnpublished = false
  publishOptions: unknown = undefined
  publishTrackError: Error | null = null
  calls: string[] = []

  getTrackPublication() {
    if (!this.microphoneTrack || this.microphoneUnpublished) return undefined
    return { audioTrack: this.microphoneTrack, options: this.publishOptions }
  }

  async setMicrophoneEnabled(enabled: boolean, _captureOptions?: unknown, publishOptions?: unknown) {
    this.calls.push(`setMicrophoneEnabled:${enabled}`)
    this.isMicrophoneEnabled = enabled
    if (enabled) {
      this.microphoneUnpublished = false
      this.publishOptions = publishOptions
    }
  }

  async unpublishTrack(_track: unknown, stopOnUnpublish?: boolean) {
    this.calls.push(`unpublishTrack:${stopOnUnpublish}`)
    this.microphoneUnpublished = true
    this.isMicrophoneEnabled = false
  }

  async publishTrack(track: unknown, options?: unknown) {
    this.calls.push(`publishTrack:${(options as { dtx?: boolean })?.dtx ?? ''}`)
    if (this.publishTrackError) {
      const error = this.publishTrackError
      this.publishTrackError = null
      throw error
    }
    this.microphoneTrack = track as FakeTrack
    this.microphoneUnpublished = false
    this.isMicrophoneEnabled = true
    this.publishOptions = options
  }
}

function makeOrchestrator(initial: {
  noiseSuppressionOption?: () => NoiseSuppressionOption
  webRtcNoiseSuppression?: () => boolean
  isAudioContextAvailable?: () => boolean
  transmissionMode?: () => VoiceTransmissionMode
  loadRnnoiseBinary?: () => Promise<ArrayBuffer | null>
  publishSettings?: () => { audioBitrateKbps: number; audioRedEnabled: boolean }
  isSessionLive?: () => boolean
  onError?: (message: string, error?: unknown) => void
} = {}) {
  const defaults = {
    noiseSuppressionOption: () => 'rnnoise' as NoiseSuppressionOption,
    webRtcNoiseSuppression: () => true,
    isAudioContextAvailable: () => true,
    transmissionMode: () => 'voice-activity' as VoiceTransmissionMode,
    loadRnnoiseBinary: async () => null as ArrayBuffer | null,
    publishSettings: () => ({ audioBitrateKbps: 96, audioRedEnabled: true }),
    isSessionLive: () => true,
  }
  const options = { ...defaults, ...initial }
  const orchestrator = new MicrophonePublishOrchestrator({
    gain: 1,
    noiseSuppressionOption: options.noiseSuppressionOption,
    webRtcNoiseSuppression: options.webRtcNoiseSuppression,
    resolvedPreferredInputDeviceId: () => 'default',
    echoCancellation: () => true,
    publishSettings: options.publishSettings,
    isAudioContextAvailable: options.isAudioContextAvailable,
    transmissionMode: options.transmissionMode,
    isSessionLive: options.isSessionLive,
    loadRnnoiseBinary: options.loadRnnoiseBinary,
    onError: options.onError,
  })
  const target: MicrophonePublishTarget = {
    localParticipant: new FakeParticipant(),
  }
  return { orchestrator, target, participant: target.localParticipant as unknown as FakeParticipant }
}

function attachTrack(participant: FakeParticipant) {
  participant.microphoneTrack = new FakeTrack()
  return participant.microphoneTrack
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('静音翻转只 setMicrophoneEnabled，不重发布', async () => {
  const { orchestrator, target } = makeOrchestrator()
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ enabled: false })
  const participant = target.localParticipant as unknown as FakeParticipant
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:false'])
  assert.equal(participant.isMicrophoneEnabled, false)
  assert.equal(participant.microphoneTrack, null)
})

test('解除静音且约束未变时不 restartTrack', async () => {
  const { orchestrator, target } = makeOrchestrator({ noiseSuppressionOption: () => 'webrtc' })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  participant.isMicrophoneEnabled = false
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ enabled: true })
  assert.deepEqual(track.restartCalls, [])
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:true'])
  assert.equal(participant.isMicrophoneEnabled, true)
})

test('解除静音且约束过期时先 restartTrack 再 setMicrophoneEnabled', async () => {
  const { orchestrator, target } = makeOrchestrator({
    noiseSuppressionOption: () => 'rnnoise',
    webRtcNoiseSuppression: () => false,
  })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  // rnnoise 且 48k 能力就绪 → 约束合成 noiseSuppression: false，与 track 当前 true 不同。
  participant.isMicrophoneEnabled = false
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ enabled: true })
  assert.equal(track.restartCalls.length, 1)
  assert.equal(track.restartCalls[0].noiseSuppression, false)
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:true'])
  assert.equal(participant.isMicrophoneEnabled, true)
})

test('传输模式变化触发完整重发布（restart → 挂处理器 → unpublish/publish）', async () => {
  const { orchestrator, target } = makeOrchestrator({ noiseSuppressionOption: () => 'webrtc' })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ transmissionMode: 'continuous' })
  assert.deepEqual(track.restartCalls.map((call) => call.noiseSuppression), [true])
  assert.equal(track.setProcessorCalls, 1)
  assert.deepEqual(participant.calls, ['unpublishTrack:false', 'publishTrack:false'])
  // 已应用模式推进：再次声明同一模式不再重发布。
  await orchestrator.applyMicrophoneState({ transmissionMode: 'continuous' })
  assert.deepEqual(participant.calls, ['unpublishTrack:false', 'publishTrack:false'])
})

test('降噪切换到 webrtc：先拆 → 重发布（新约束）→ 后挂', async () => {
  const { orchestrator, target } = makeOrchestrator({ noiseSuppressionOption: () => 'rnnoise' })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ noiseSuppression: 'webrtc' })
  // 新约束 noiseSuppression: true（webrtc），重发布经 restartTrack 生效。
  assert.deepEqual(track.restartCalls.map((call) => call.noiseSuppression), [true])
  assert.equal(track.setProcessorCalls, 1)
  assert.deepEqual(participant.calls, ['unpublishTrack:false', 'publishTrack:true'])
})

test('切回增强降噪重新尝试 RNNoise，加载失败逐次回退到系统降噪', async () => {
  const { orchestrator, target } = makeOrchestrator({
    noiseSuppressionOption: () => 'rnnoise',
    webRtcNoiseSuppression: () => false,
  })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ noiseSuppression: 'rnnoise' })
  // 第一次按增强降噪合成（约束 false）→ attach 时节点创建失败 → 回退：
  // 粘滞生效，重发布按系统降噪（约束 true）。
  assert.ok(track.restartCalls.some((call) => call.noiseSuppression === false), '应先按增强降噪尝试')
  await tick()
  assert.equal(track.restartCalls.at(-1)?.noiseSuppression, true)
})

test('未接入会话时降噪切换只落处理器级，不触碰发布', async () => {
  const { orchestrator, target } = makeOrchestrator()
  await orchestrator.applyMicrophoneState({ noiseSuppression: 'webrtc' })
  const participant = target.localParticipant as unknown as FakeParticipant
  assert.deepEqual(participant.calls, [])
})

test('endSession 后迟到的操作静默作废', async () => {
  const { orchestrator, target } = makeOrchestrator()
  const participant = target.localParticipant as unknown as FakeParticipant
  orchestrator.beginSession(target)
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  participant.calls = []
  const original = participant.setMicrophoneEnabled.bind(participant)
  participant.setMicrophoneEnabled = async (enabled: boolean) => {
    await gate
    return original(enabled, undefined, undefined) as Promise<unknown>
  }
  const applying = orchestrator.applyMicrophoneState({ enabled: false })
  await tick()
  orchestrator.endSession()
  release!()
  await applying
  // setMicrophoneEnabled 已发出（挂在 gate 上），但其后步骤全部被会话守卫拦下。
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:false'])
})

test('并发 apply 串行执行，互不交错', async () => {
  const { orchestrator, target } = makeOrchestrator()
  const participant = target.localParticipant as unknown as FakeParticipant
  orchestrator.beginSession(target)
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  participant.calls = []
  const original = participant.setMicrophoneEnabled.bind(participant)
  participant.setMicrophoneEnabled = async (enabled: boolean) => {
    await gate
    return original(enabled, undefined, undefined) as Promise<unknown>
  }
  const first = orchestrator.applyMicrophoneState({ enabled: false })
  await tick()
  // 第一次挂起期间，第二次只排队、不执行。
  const second = orchestrator.applyMicrophoneState({ enabled: true })
  await tick()
  assert.deepEqual(participant.calls, [])
  release!()
  await Promise.all([first, second])
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:false', 'setMicrophoneEnabled:true'])
})

test('重发布失败时恢复旧发布并向上抛错', async () => {
  const { orchestrator, target } = makeOrchestrator({ noiseSuppressionOption: () => 'webrtc' })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  participant.publishTrackError = new Error('publish failed')
  orchestrator.beginSession(target)
  await assert.rejects(orchestrator.applyMicrophoneState({ transmissionMode: 'continuous' }), /publish failed/)
  assert.equal(participant.isMicrophoneEnabled, true)
  assert.equal(participant.microphoneUnpublished, false)
  // 失败后恢复：unpublish 之后 publish 失败，恢复路径再 publish 一次。
  assert.equal(participant.calls.filter((call) => call.startsWith('publishTrack')).length, 2)
})

test('上下文不可用时摘下处理器并按回退约束重建采集', async () => {
  let contextAvailable = true
  const { orchestrator, target } = makeOrchestrator({
    noiseSuppressionOption: () => 'rnnoise',
    webRtcNoiseSuppression: () => false,
    isAudioContextAvailable: () => contextAvailable,
  })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  // 麦克风未启用 + 约束过期（track true vs 合成 false）→ 解除静音时重建采集。
  participant.isMicrophoneEnabled = false
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ enabled: true })
  assert.deepEqual(track.restartCalls.map((call) => call.noiseSuppression), [false])
  assert.equal(track.setProcessorCalls, 1)
  // 上下文随后关闭：再次收敛时摘下已挂的处理器，约束已回退故不再重启采集。
  contextAvailable = false
  await orchestrator.applyMicrophoneState({ enabled: true })
  assert.equal(track.stopProcessorCalls, 1)
  assert.equal(track.processor, null)
  assert.equal(track.setProcessorCalls, 1)
})

test('forceRepublish 按当前状态重发布（频道发布设置变化）', async () => {
  const { orchestrator, target } = makeOrchestrator({ noiseSuppressionOption: () => 'webrtc' })
  const participant = target.localParticipant as unknown as FakeParticipant
  const track = attachTrack(participant)
  orchestrator.beginSession(target)
  await orchestrator.applyMicrophoneState({ forceRepublish: true })
  assert.equal(track.restartCalls.length, 1)
  assert.deepEqual(participant.calls, ['unpublishTrack:false', 'publishTrack:true'])
})

test('buildCaptureOptions 按降噪选项与回退状态合成约束', async () => {
  // rnnoise + 48k 能力就绪（webRtcNoiseSuppression false）→ 增强降噪约束 false。
  const ready = makeOrchestrator({ noiseSuppressionOption: () => 'rnnoise', webRtcNoiseSuppression: () => false })
  assert.equal(ready.orchestrator.buildCaptureOptions().noiseSuppression, false)
  // rnnoise + 能力未就绪 → 回退系统降噪约束 true。
  const degraded = makeOrchestrator({ noiseSuppressionOption: () => 'rnnoise', webRtcNoiseSuppression: () => true })
  assert.equal(degraded.orchestrator.buildCaptureOptions().noiseSuppression, true)
  // webrtc → 系统降噪约束 true。
  const webrtc = makeOrchestrator({ noiseSuppressionOption: () => 'webrtc', webRtcNoiseSuppression: () => true })
  assert.equal(webrtc.orchestrator.buildCaptureOptions().noiseSuppression, true)
  // off → false。
  const off = makeOrchestrator({ noiseSuppressionOption: () => 'off', webRtcNoiseSuppression: () => false })
  assert.equal(off.orchestrator.buildCaptureOptions().noiseSuppression, false)
  // override 优先于合成。
  assert.equal(webrtc.orchestrator.buildCaptureOptions(true).noiseSuppression, true)
  assert.equal(webrtc.orchestrator.buildCaptureOptions(false).noiseSuppression, false)
})

test('invalidate 后旧会话的 apply 不再触碰新会话的发布', async () => {
  const { orchestrator, target } = makeOrchestrator()
  const participant = target.localParticipant as unknown as FakeParticipant
  orchestrator.beginSession(target)
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = participant.setMicrophoneEnabled.bind(participant)
  participant.setMicrophoneEnabled = async (enabled: boolean) => {
    await gate
    return original(enabled, undefined, undefined) as Promise<unknown>
  }
  const applying = orchestrator.applyMicrophoneState({ enabled: false })
  await tick()
  orchestrator.invalidate()
  release!()
  await applying
  // 会话守卫拦在 setMicrophoneEnabled 之后：旧会话不再有后续步骤。
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:false'])
  // 新会话的 apply 正常生效（麦克风已关闭，解除静音走到发布）。
  orchestrator.beginSession(target)
  participant.calls = []
  await orchestrator.applyMicrophoneState({ enabled: true })
  assert.deepEqual(participant.calls, ['setMicrophoneEnabled:true'])
})
