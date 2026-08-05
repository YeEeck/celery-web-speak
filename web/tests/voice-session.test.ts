import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, type Ref } from 'vue'
import { RoomEvent } from 'livekit-client'
import { useVoiceSession, type VoiceSessionContext } from '../src/stores/voice-session.ts'
import type { Channel, User, VoiceCredentials } from '../src/types.ts'

const memoryStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => memoryStore.get(k) ?? null,
    setItem: (k: string, v: string) => void memoryStore.set(k, v),
    removeItem: (k: string) => void memoryStore.delete(k),
    clear: () => memoryStore.clear(),
    key: () => null,
    length: 0,
  },
  configurable: true,
  writable: true,
})
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

class FakeParticipant {
  identity: string
  name: string
  isMicrophoneEnabled = true
  attributes: Record<string, string> = {}
  connectionQuality = 3
  joinedAt = new Date()
  setMicrophoneCalls: Array<boolean | undefined> = []
  publishCalls: Array<{ track: unknown; options: unknown }> = []
  unpublishCalls: Array<{ track: unknown; stopOnUnpublish?: boolean }> = []
  publishError: Error | null = null
  publishTrackError: Error | null = null
  processor: unknown = null
  getProcessor: unknown = null
  setProcessorError: Error | null = null
  microphoneTrack: FakeMicrophoneTrack | null = null
  microphoneUnpublished = false
  microphonePublishOptions: unknown = undefined

  constructor(identity: string, name: string) {
    this.identity = identity
    this.name = name
  }

  getTrackPublication() {
    if (!this.microphoneTrack || this.microphoneUnpublished) return null
    return { audioTrack: this.microphoneTrack, options: this.microphonePublishOptions }
  }

  async setMicrophoneEnabled(enabled: boolean, _captureOptions?: unknown, publishOptions?: unknown) {
    this.setMicrophoneCalls.push(enabled)
    if (this.publishError) throw this.publishError
    this.isMicrophoneEnabled = enabled
    if (enabled) {
      this.microphoneUnpublished = false
      this.microphonePublishOptions = publishOptions
    }
  }

  async unpublishTrack(track: unknown, stopOnUnpublish?: boolean) {
    this.unpublishCalls.push({ track, stopOnUnpublish })
    if (this.publishError) throw this.publishError
    this.microphoneUnpublished = true
    this.isMicrophoneEnabled = false
    return undefined
  }

  async publishTrack(track: unknown, options?: unknown) {
    this.publishCalls.push({ track, options })
    if (this.publishTrackError) {
      const error = this.publishTrackError
      this.publishTrackError = null
      throw error
    }
    if (this.publishError) throw this.publishError
    this.microphoneTrack = track as FakeMicrophoneTrack
    this.microphoneUnpublished = false
    this.isMicrophoneEnabled = true
    this.microphonePublishOptions = options
    return { track, audioTrack: this.microphoneTrack, options }
  }
}

class FakeMicrophoneTrack {
  constraints: MediaTrackConstraints = { noiseSuppression: false }
  mediaStreamTrack = {} as MediaStreamTrack
  restartCalls: unknown[] = []
  setProcessorCalls = 0
  stopProcessorCalls = 0
  processor: unknown = null
  audioContextForProcessor: FakeAudioContext | null = null

  getProcessor() {
    return this.processor
  }

  async setProcessor(processor: unknown) {
    this.setProcessorCalls += 1
    this.processor = processor
    // LiveKit 在 setProcessor 内调用 processor.init；这里模拟之，
    // 让回退编排（节点创建失败→onRnnoiseUnavailable）可以跑通。
    if (processor && this.audioContextForProcessor) {
      const init = (processor as { init?: (options: unknown) => Promise<void> }).init
      await init?.call(processor, {
        audioContext: this.audioContextForProcessor,
        track: this.mediaStreamTrack,
      })
    }
    return undefined
  }

  async stopProcessor() {
    this.stopProcessorCalls += 1
    this.processor = null
  }

  async restartTrack(options: unknown) {
    this.restartCalls.push(options)
    this.constraints = options as MediaTrackConstraints
  }
}

class FakeRoom {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  connectCalls = 0
  disconnectCalls = 0
  startAudioCalls = 0
  connectError: Error | null = null
  localParticipant = new FakeParticipant('user-1', 'me')
  remoteParticipants = new Map<string, FakeParticipant>()

  on(event: string, callback: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(callback)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    for (const callback of this.listeners.get(event) ?? []) callback(...args)
  }

  async connect() {
    this.connectCalls += 1
    if (this.connectError) throw this.connectError
    return this
  }

  disconnect() {
    this.disconnectCalls += 1
  }

  async startAudio() {
    this.startAudioCalls += 1
    return this
  }
}

class FakeSpeechDetectionEngine {
  startCalls: Array<string | undefined> = []
  stopCalls = 0
  resetFailureCalls = 0
  listeners = new Set<(speaking: boolean, frameDurationMs: number) => void>()

  subscribe(listener: (speaking: boolean, frameDurationMs: number) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(deviceId?: string) {
    this.startCalls.push(deviceId)
    return true
  }

  stop() {
    this.stopCalls += 1
  }

  resetFailure() {
    this.resetFailureCalls += 1
  }

  emitSpeech(speaking: boolean, frameDurationMs = 20) {
    for (const listener of this.listeners) listener(speaking, frameDurationMs)
  }
}

function fakeElement() {
  return {
    dataset: {} as Record<string, string>,
    autoplay: false,
    style: {},
    remove() {},
  } as unknown as HTMLAudioElement
}

class FakeAudioContext extends EventTarget {
  state: AudioContextState = 'running'
  closeCalls = 0
  sampleRate = 48_000

  async close() {
    this.closeCalls += 1
    this.setState('closed')
  }

  setState(state: AudioContextState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }

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

const CHANNEL: Channel = {
  id: 7,
  type: 'voice',
  name: '语音频道',
  audioBitrateKbps: 96,
  backgroundAudioBitrateKbps: 128,
  audioRedEnabled: true,
  backgroundAudioRedEnabled: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

interface HarnessState {
  channel: Channel | null
  guild: { id: number; name: string } | null
  user: { id: number; voiceMuted: boolean } | null
  users: User[]
  muted: Ref<boolean>
  deafened: Ref<boolean>
  guildMuted: Ref<boolean>
  microphoneEnabledPreference: Ref<boolean>
  deafenedPreference: Ref<boolean>
  muteChanging: Ref<boolean>
  deafenChanging: Ref<boolean>
  inputDeviceId: string
  outputDeviceId: string
  activeOutputDeviceId: string | null
  devicePermissionState: 'idle' | 'requesting' | 'granted' | 'denied'
  reminderAudible: boolean
  echoCancellation: boolean
  noiseSuppression: boolean
  applyConnectionPreferencesCalls: number
  connectionResetCalls: number
  transportRecoveredCalls: number
  notifyPreferenceChangeCalls: number
  requestVoiceRoomsRefreshCalls: number
  initializeDevicesCalls: number
  refreshDevicesCalls: number
  applyPreferredDevicesCalls: number
  microphoneGain: number
  mutedValue: boolean
}

interface Harness {
  state: HarnessState
  ctx: VoiceSessionContext
  session: ReturnType<typeof useVoiceSession>
  room: FakeRoom
  monitor: FakeSpeechDetectionEngine
  signals: string[]
  beacons: string[]
  followPlaybackCalls: Array<{ deafened: boolean; outputDeviceId: string }>
  pageHideCallbacks: Array<() => void>
  appendedElements: Array<{ userId: string }>
  removeAllCalls: number
  audioSinks: Array<{ deviceId: string }>
  audioContexts: FakeAudioContext[]
  voiceTokenCalls: number
  voiceLeaveCalls: number
  pendingTokens: Array<{ resolve: (value: VoiceCredentials) => void }>
}

function makeHarness(): Harness {
  memoryStore.clear()
  const state: HarnessState = {
    channel: CHANNEL,
    guild: { id: 3, name: '测试服务器' },
    user: { id: 1, voiceMuted: false },
    users: [],
    muted: ref(false),
    deafened: ref(false),
    guildMuted: ref(false),
    microphoneEnabledPreference: ref(true),
    deafenedPreference: ref(false),
    muteChanging: ref(false),
    deafenChanging: ref(false),
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    activeOutputDeviceId: null,
    devicePermissionState: 'granted',
    reminderAudible: true,
    echoCancellation: true,
    noiseSuppression: true,
    applyConnectionPreferencesCalls: 0,
    connectionResetCalls: 0,
    transportRecoveredCalls: 0,
    notifyPreferenceChangeCalls: 0,
    requestVoiceRoomsRefreshCalls: 0,
    initializeDevicesCalls: 0,
    refreshDevicesCalls: 0,
    applyPreferredDevicesCalls: 0,
    microphoneGain: 100,
    mutedValue: false,
  }
  const signals: string[] = []
  const beacons: string[] = []
  const followPlaybackCalls: Harness['followPlaybackCalls'] = []
  const pageHideCallbacks: Array<() => void> = []
  const appendedElements: Array<{ userId: string }> = []
  const audioSinks: Array<{ deviceId: string }> = []
  const audioContexts: FakeAudioContext[] = []
  const pendingTokens: Array<{ resolve: (value: VoiceCredentials) => void }> = []
  const room = new FakeRoom()
  const monitor = new FakeSpeechDetectionEngine()
  const harness: Harness = {
    state,
    room,
    monitor,
    signals,
    beacons,
    followPlaybackCalls,
    pageHideCallbacks,
    appendedElements,
    audioSinks,
    audioContexts,
    voiceTokenCalls: 0,
    voiceLeaveCalls: 0,
    removeAllCalls: 0,
    pendingTokens,
    ctx: {} as VoiceSessionContext,
    session: null as unknown as ReturnType<typeof useVoiceSession>,
  }
  harness.ctx = {
    findChannel: () => state.channel ?? undefined,
    activeGuildInfo: () => state.guild,
    currentUser: () => state.user,
    connectedUsers: () => state.users,
    requestVoiceRoomsRefresh: () => { state.requestVoiceRoomsRefreshCalls += 1 },
    muted: () => state.muted.value || state.mutedValue,
    deafened: () => state.deafened.value,
    guildMuted: () => state.guildMuted.value,
    microphoneEnabledPreference: () => state.microphoneEnabledPreference.value,
    deafenedPreference: () => state.deafenedPreference.value,
    muteChanging: () => state.muteChanging.value,
    deafenChanging: () => state.deafenChanging.value,
    refreshGuildMuted: () => { state.guildMuted.value = state.user?.voiceMuted ?? false },
    setMuted: (value) => { state.mutedValue = value },
    applyConnectionPreferences: async () => { state.applyConnectionPreferencesCalls += 1 },
    connectionReset: () => { state.connectionResetCalls += 1 },
    transportRecovered: async () => { state.transportRecoveredCalls += 1 },
    notifyPreferenceChange: () => { state.notifyPreferenceChangeCalls += 1 },
    resolvedPreferredInputDeviceId: () => state.inputDeviceId,
    resolvedPreferredOutputDeviceId: () => state.outputDeviceId,
    activeOutputDeviceId: () => state.activeOutputDeviceId,
    devicePermissionState: () => state.devicePermissionState,
    supportsOutputSelection: () => true,
    initializeDevices: async () => { state.initializeDevicesCalls += 1 },
    refreshDevices: async () => { state.refreshDevicesCalls += 1 },
    applyPreferredDevicesToRoom: async () => { state.applyPreferredDevicesCalls += 1 },
    stopApplicationAudio: async () => undefined,
    republishBackgroundAudio: async () => undefined,
    applicationAudioHasActiveTrack: () => false,
    applyAllVolumes: () => undefined,
    applyVolume: () => undefined,
    signal: (occurrence) => { signals.push(occurrence) },
    followPlayback: (options) => { followPlaybackCalls.push(options) },
    mutedSpeakingReminderAudible: () => state.reminderAudible,
    microphoneGainInitial: () => state.microphoneGain,
    echoCancellation: () => state.echoCancellation,
    noiseSuppression: () => state.noiseSuppression,
    noiseSuppressionOption: () => 'rnnoise',
    loadRnnoiseBinary: async () => null,
    fetchVoiceToken: async () => {
      harness.voiceTokenCalls += 1
      if (harness.pendingTokens.length > 0) {
        const pending = harness.pendingTokens.shift()!
        return new Promise((resolve) => pending.resolve(resolve))
      }
      return { url: 'ws://fake', token: 'token', roomName: 'guild-3-channel-7', channelId: 7 }
    },
    postVoiceLeave: async () => { harness.voiceLeaveCalls += 1 },
    createRoom: () => room as unknown as ReturnType<VoiceSessionContext['createRoom']>,
    createAudioContext: () => {
      const context = new FakeAudioContext()
      audioContexts.push(context)
      return context as unknown as AudioContext
    },
    audioInteractionTarget: () => new EventTarget(),
    createSpeechDetectionEngine: () => monitor as never,
    appendAudioElement: (element) => { appendedElements.push({ userId: element.dataset.userId }) },
    removeAllAudioElements: () => { harness.removeAllCalls += 1 },
    applyAudioSink: (_element, deviceId) => { audioSinks.push({ deviceId }) },
    subscribePageHide: (callback) => { pageHideCallbacks.push(callback) },
    sendBeacon: (url) => { beacons.push(url) },
  }
  harness.session = useVoiceSession(harness.ctx)
  return harness
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function makeRemoteParticipant(identity: string, name: string): FakeParticipant {
  const participant = new FakeParticipant(identity, name)
  participant.attributes.user_id = String(Number(identity.replace('user-', '')) || 0)
  return participant
}

test('join connects, applies preferences and reaches connected', async () => {
  const h = makeHarness()
  await h.session.join(7)
  assert.equal(h.room.connectCalls, 1)
  assert.equal(h.voiceTokenCalls, 1)
  assert.equal(h.state.applyConnectionPreferencesCalls, 1)
  assert.equal(h.state.initializeDevicesCalls, 1)
  assert.equal(h.session.status.value, 'connected')
  assert.equal(h.session.connectedGuildId.value, 3)
  assert.equal(h.session.connectedChannelId.value, 7)
  assert.equal(h.session.connectedChannelName.value, '语音频道')
  assert.equal(h.session.connectedGuildName.value, '测试服务器')
  assert.ok(h.signals.includes('voice-self-joined'))
  assert.equal(h.state.guildMuted.value, false)
})

test('join skips when already connecting to the same channel', async () => {
  const h = makeHarness()
  await h.session.join(7)
  await h.session.join(7)
  assert.equal(h.room.connectCalls, 1)
})

test('join failure disconnects the room and reports the error', async () => {
  const h = makeHarness()
  h.room.connectError = new Error('connect failed')
  await assert.rejects(h.session.join(7), /connect failed/)
  assert.equal(h.session.status.value, 'error')
  assert.equal(h.session.errorMessage.value, 'connect failed')
  assert.equal(h.room.disconnectCalls, 1)
  assert.equal(h.session.joined.value, false)
  assert.equal(h.session.connectedChannelId.value, null)
})

test('join aborts when the session changes mid-flight', async () => {
  const h = makeHarness()
  let release: (value: VoiceCredentials) => void = () => undefined
  const gate = new Promise<VoiceCredentials>((resolve) => { release = resolve })
  h.ctx.fetchVoiceToken = async () => gate
  const joinPromise = h.session.join(7)
  await flushPromises()
  await h.session.leave()
  release({ url: 'ws://fake', token: 'token', roomName: 'guild-3-channel-7', channelId: 7 })
  await joinPromise
  assert.equal(h.session.status.value, 'idle')
  assert.equal(h.room.connectCalls, 0)
})

test('leave disconnects, clears state and notifies the guild', async () => {
  const h = makeHarness()
  await h.session.join(7)
  await h.session.leave({ intent: 'active' })
  assert.equal(h.room.disconnectCalls, 1)
  assert.equal(h.session.status.value, 'idle')
  assert.equal(h.session.participantStates.value.length, 0)
  assert.equal(h.session.connectedChannelId.value, null)
  assert.equal(h.voiceLeaveCalls, 1)
  assert.equal(h.removeAllCalls, 1)
  assert.ok(h.signals.includes('voice-self-left'))
  assert.ok(h.followPlaybackCalls.some((call) => call.deafened === false))
})

test('disconnected event ends the session locally', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.room.emit(RoomEvent.Disconnected)
  await flushPromises()
  assert.equal(h.session.status.value, 'idle')
  assert.equal(h.session.connectedChannelId.value, null)
  assert.equal(h.session.participantStates.value.length, 0)
  assert.equal(h.voiceLeaveCalls, 0)
  assert.equal(h.state.requestVoiceRoomsRefreshCalls, 2)
})

test('reconnecting and reconnected transition through the event loop', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.room.emit(RoomEvent.Reconnecting)
  assert.equal(h.session.status.value, 'reconnecting')
  h.room.emit(RoomEvent.Reconnected)
  await flushPromises()
  assert.equal(h.session.status.value, 'connected')
  assert.equal(h.state.transportRecoveredCalls, 1)
})

test('toggleTransmissionMode republishes the microphone and flips the mode', async () => {
  const h = makeHarness()
  await h.session.join(7)
  assert.equal(h.session.transmissionMode.value, 'voice-activity')
  h.room.localParticipant.setMicrophoneCalls = []
  await h.session.toggleTransmissionMode()
  assert.equal(h.session.transmissionMode.value, 'continuous')
  assert.deepEqual(h.room.localParticipant.setMicrophoneCalls, [false, true])
  assert.equal(h.state.notifyPreferenceChangeCalls, 1)
})


test('toggleTransmissionMode republishes existing publication with the new DTX option', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.room.localParticipant.microphoneTrack = new FakeMicrophoneTrack()

  await h.session.toggleTransmissionMode()

  assert.equal(h.session.transmissionMode.value, 'continuous')
  assert.equal(h.room.localParticipant.publishCalls.length, 1)
  assert.equal((h.room.localParticipant.publishCalls[0]?.options as { dtx: boolean }).dtx, false)
})


test('toggleTransmissionMode rolls back to the previous mode on failure', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.room.localParticipant.publishError = new Error('publish failed')
  await h.session.toggleTransmissionMode()
  assert.equal(h.session.transmissionMode.value, 'voice-activity')
  assert.match(h.session.transmissionModeError.value, /无法切换传输模式/)
  assert.equal(h.session.transmissionModeChanging.value, false)
})

test('toggleTransmissionMode stays silent while a mute change is in flight', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.state.muteChanging.value = true
  h.room.localParticipant.setMicrophoneCalls = []
  await h.session.toggleTransmissionMode()
  assert.equal(h.room.localParticipant.setMicrophoneCalls.length, 0)
  assert.equal(h.session.transmissionMode.value, 'voice-activity')
})

test('syncParticipants merges local and remote participants', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.room.remoteParticipants.set('user-9', makeRemoteParticipant('user-9', '远端用户'))
  h.session.syncParticipants()
  assert.equal(h.session.participantStates.value.length, 2)
  const local = h.session.participantStates.value.find((p) => p.isLocal)!
  assert.equal(local.userId, 1)
  const remote = h.session.participantStates.value.find((p) => !p.isLocal)!
  assert.equal(remote.userId, 9)
  assert.equal(remote.name, '远端用户')
  assert.equal(remote.isSpeaking, false)
})

test('participant join event refreshes rooms and plays the sound', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.room.remoteParticipants.set('user-9', makeRemoteParticipant('user-9', '远端用户'))
  h.room.emit(RoomEvent.ParticipantConnected)
  await flushPromises()
  assert.equal(h.session.participantStates.value.length, 2)
  assert.ok(h.signals.includes('voice-participant-joined'))
})

test('updateConnectedChannelSettings detects microphone-affecting changes', async () => {
  const h = makeHarness()
  await h.session.join(7)
  const result = h.session.updateConnectedChannelSettings({ ...CHANNEL, audioBitrateKbps: 128 })
  assert.equal(result.microphoneChanged, true)
  assert.equal(result.backgroundAudioChanged, false)
})

test('handleModeratorDisconnect matches the current session and signals', async () => {
  const h = makeHarness()
  await h.session.join(7)
  assert.equal(h.session.handleModeratorDisconnect(3, 7), true)
  assert.ok(h.signals.includes('voice-moderator-disconnected'))
  assert.equal(h.session.handleModeratorDisconnect(3, 7), true)
  assert.equal(h.session.handleModeratorDisconnect(9, 7), false)
})

test('muted speaking reminder policy does not start the shared engine', async () => {
  const h = makeHarness()
  h.state.microphoneEnabledPreference.value = false
  await h.session.join(7)
  await flushPromises()
  assert.equal(h.monitor.startCalls.length, 0)
})

test('leaving voice while the reminder policy is on does not stop the shared engine', async () => {
  const h = makeHarness()
  h.state.microphoneEnabledPreference.value = false
  await h.session.join(7)
  await flushPromises()
  await h.session.leave()
  assert.equal(h.monitor.stopCalls, 0)
})

test('setMutedSpeakingReminderEnabled persists the preference', () => {
  const h = makeHarness()
  h.session.setMutedSpeakingReminderEnabled(false)
  assert.equal(h.session.mutedSpeakingReminderEnabled.value, false)
  assert.equal(memoryStore.get('cws.mutedSpeakingReminder.enabled'), 'false')
})

test('pagehide sends a leave beacon while joined', async () => {
  const h = makeHarness()
  await h.session.join(7)
  h.pageHideCallbacks[0]()
  assert.equal(h.beacons.length, 1)
  assert.match(h.beacons[0], /\/guilds\/3\/voice\/leave/)
})

test('pagehide stays silent when not joined', async () => {
  const h = makeHarness()
  h.pageHideCallbacks[0]()
  assert.equal(h.beacons.length, 0)
})
