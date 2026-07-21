import { computed, markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  ConnectionQuality,
  LocalAudioTrack,
  type LocalTrackPublication,
  Participant,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import { request } from '../api'
import { ApplicationAudioPipeline } from '../audio/ApplicationAudioPipeline'
import { MicrophoneActivityMonitor } from '../audio/MicrophoneActivityMonitor'
import { MicrophoneGainProcessor } from '../audio/MicrophoneGainProcessor'
import {
  connectApplicationAudioBridge,
  isApplicationAudioSnapshot,
  onApplicationAudioPcmPort,
  type ApplicationAudioError,
  type ApplicationAudioSnapshot,
  type ApplicationAudioState,
  type DesktopApplicationAudioBridge,
} from '../audio/applicationAudioBridge'
import type { Role, User, VoiceCredentials } from '../types'
import { useAppStore } from './app'
import { useSoundStore } from './sounds'

const DEFAULT_VOLUME = 1
const MAX_VOLUME = 3
const MICROPHONE_GAIN_KEY = 'cws.microphoneGain'
const OUTPUT_VOLUME_KEY = 'cws.outputVolume'
const DEAFENED_ATTRIBUTE = 'deafened'
const ECHO_CANCELLATION_KEY = 'cws.echoCancellation'
const NOISE_SUPPRESSION_KEY = 'cws.noiseSuppression'
const APPLICATION_AUDIO_VOLUME_KEY = 'cws.applicationAudioVolume'
const APPLICATION_AUDIO_DEFAULT_VOLUME = 0.5
const APPLICATION_AUDIO_PORT_TIMEOUT_MS = 10_000

export interface VoiceParticipant {
  identity: string
  userId: number
  name: string
  isLocal: boolean
  isSpeaking: boolean
  microphoneEnabled: boolean
  backgroundAudioPlaying: boolean
  deafened: boolean
  quality: ConnectionQuality
  volume: number
  role: Role
  joinedAt: number | null
}

export const useVoiceStore = defineStore('voice', () => {
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const connectedChannelId = ref<number | null>(null)
  const errorMessage = ref('')
  const muted = ref(false)
  const deafened = ref(false)
  const deafenChanging = ref(false)
  const deafenedSyncError = ref('')
  const participantStates = ref<VoiceParticipant[]>([])
  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const activeInputId = ref('')
  const activeOutputId = ref('')
  const microphoneGain = ref(getSavedLevel(MICROPHONE_GAIN_KEY))
  const outputVolume = ref(getSavedLevel(OUTPUT_VOLUME_KEY))
  const echoCancellation = ref(getSavedBoolean(ECHO_CANCELLATION_KEY, true))
  const noiseSuppression = ref(getSavedBoolean(NOISE_SUPPRESSION_KEY, true))
  const applicationAudioSupported = ref(false)
  const applicationAudioState = ref<ApplicationAudioState | 'unsupported'>('unsupported')
  const applicationAudioError = ref('')
  const applicationAudioVolume = ref(getSavedApplicationAudioVolume())
  const applicationAudioOperating = ref(false)
  const microphoneGainProcessor = new MicrophoneGainProcessor(microphoneGain.value)
  const microphoneActivity = new MicrophoneActivityMonitor((identity, speaking) => {
    const participant = participantStates.value.find((item) => item.identity === identity)
    if (participant) participant.isSpeaking = speaking
  })
  let room: Room | null = null
  let participantSoundsReady = false
  let microphoneBeforeDeafen = false
  let pendingDeafenedSync: boolean | null = null
  let deafenedSyncSession: number | null = null
  let voiceSession = 0
  let applicationAudioBridge: DesktopApplicationAudioBridge | null = null
  const applicationAudioSessionId = ref<string | null>(null)
  let applicationAudioRevision = -1
  let applicationAudioGeneration = 0
  let applicationAudioPipeline: ApplicationAudioPipeline | null = null
  let applicationAudioTrack: LocalAudioTrack | null = null
  let applicationAudioPublication: LocalTrackPublication | null = null
  let applicationAudioAutoPaused = false
  let applicationAudioInitialized = false
  let removeApplicationAudioSnapshotListener: (() => void) | null = null
  let removeApplicationAudioPcmListener: (() => void) | null = null
  let pendingApplicationAudioPort: { sessionId: string; port: MessagePort } | null = null
  let pendingApplicationAudioPortWaiter: {
    sessionId: string
    resolve: (port: MessagePort) => void
    reject: (error: Error) => void
    timer: number
  } | null = null

  const joined = computed(() => status.value !== 'idle' && status.value !== 'error')
  const applicationAudioActive = computed(() => applicationAudioSessionId.value !== null && ['playing', 'paused'].includes(applicationAudioState.value))
  const applicationAudioPlaying = computed(() => applicationAudioState.value === 'playing')
  const applicationAudioChanging = computed(() => applicationAudioOperating.value || ['selecting', 'starting', 'stopping'].includes(applicationAudioState.value))
  const participants = computed(() => {
    const app = useAppStore()
    return [...participantStates.value].sort((a, b) => compareParticipants(a, b, app.users))
  })

  async function join(channelId: number) {
    if (room && connectedChannelId.value === channelId) return
    if (status.value === 'connecting') return
    if (room) await leave()
    voiceSession += 1
    const app = useAppStore()
    status.value = 'connecting'
    errorMessage.value = ''
    deafenedSyncError.value = ''
    pendingDeafenedSync = null
    microphoneBeforeDeafen = false
    try {
      const channel = app.voiceChannels.find((item) => item.id === channelId)
      if (!channel) throw new Error('语音频道不存在')
      const credentials = await request<VoiceCredentials>(`/api/channels/${channelId}/voice/token`, { method: 'POST' })
      const nextRoom = markRaw(new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: true,
        audioCaptureDefaults: {
          echoCancellation: echoCancellation.value,
          noiseSuppression: noiseSuppression.value,
          autoGainControl: true,
          channelCount: 1,
        },
        publishDefaults: {
          audioPreset: { maxBitrate: (channel.audioBitrateKbps ?? 64) * 1000 },
          dtx: true,
          red: true,
          forceStereo: false,
        },
      }))
      room = nextRoom
      connectedChannelId.value = channelId
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token, { autoSubscribe: true, maxRetries: 5 })
      await nextRoom.startAudio()
      if (!app.user?.voiceMuted) {
        await nextRoom.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
        await attachMicrophoneGain(nextRoom)
      }
      muted.value = app.user?.voiceMuted ?? false
      status.value = 'connected'
      await refreshDevices(true)
      syncParticipants()
      participantSoundsReady = true
      useSoundStore().play('join')
      app.requestVoiceRoomsRefresh()
    } catch (error) {
      participantSoundsReady = false
      room?.disconnect()
      room = null
      connectedChannelId.value = null
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : '无法连接语音频道'
      throw error
    }
  }

  async function leave() {
    const app = useAppStore()
    const wasJoined = room !== null
    await stopApplicationAudio()
    voiceSession += 1
    participantSoundsReady = false
    if (room) {
      room.disconnect()
      room = null
    }
    connectedChannelId.value = null
    document.querySelectorAll('#voice-audio-root audio').forEach((element) => element.remove())
    participantStates.value = []
    status.value = 'idle'
    muted.value = false
    deafened.value = false
    microphoneBeforeDeafen = false
    pendingDeafenedSync = null
    deafenedSyncError.value = ''
    microphoneActivity.destroy()
    useSoundStore().setSuppressed(false)
    if (wasJoined) app.requestVoiceRoomsRefresh()
  }

  async function toggleMute() {
    if (!room || deafened.value || deafenChanging.value) return
    const app = useAppStore()
    if (app.user?.voiceMuted) return
    const enabled = muted.value
    await room.localParticipant.setMicrophoneEnabled(enabled, undefined, publishOptions())
    if (enabled) await attachMicrophoneGain(room)
    muted.value = !enabled
    syncParticipants()
  }

  async function toggleDeafen() {
    if (!room || deafenChanging.value) return
    const target = room
    const session = voiceSession
    const app = useAppStore()
    const previousDeafened = deafened.value
    const previousMuted = muted.value
    const previousMicrophoneBeforeDeafen = microphoneBeforeDeafen
    const nextDeafened = !deafened.value
    deafenChanging.value = true
    errorMessage.value = ''
    try {
      if (nextDeafened) {
        microphoneBeforeDeafen = !muted.value && !app.user?.voiceMuted
        if (microphoneBeforeDeafen) {
          await target.localParticipant.setMicrophoneEnabled(false)
          if (session !== voiceSession || room !== target) return
          muted.value = true
        }
        if (applicationAudioState.value === 'playing') await pauseApplicationAudio(true)
        deafened.value = true
        useSoundStore().setSuppressed(true)
        applyAllVolumes()
      } else {
        const shouldRestoreMicrophone = microphoneBeforeDeafen && !app.user?.voiceMuted
        if (shouldRestoreMicrophone) {
          await target.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
          if (session !== voiceSession || room !== target) return
          await attachMicrophoneGain(target)
          if (session !== voiceSession || room !== target) return
          muted.value = false
        }
        microphoneBeforeDeafen = false
        deafened.value = false
        useSoundStore().setSuppressed(false)
        applyAllVolumes()
        if (applicationAudioAutoPaused && applicationAudioState.value === 'paused') {
          await resumeApplicationAudio(true)
        }
      }
      syncParticipants()
      queueDeafenedSync(nextDeafened)
    } catch (error) {
      if (session !== voiceSession || room !== target) return
      errorMessage.value = error instanceof Error ? error.message : '无法切换耳机静音状态'
      await restoreMicrophoneState(target, !previousMuted && !app.user?.voiceMuted)
      if (session !== voiceSession || room !== target) return
      muted.value = Boolean(app.user?.voiceMuted) || !target.localParticipant.isMicrophoneEnabled
      deafened.value = previousDeafened
      microphoneBeforeDeafen = previousMicrophoneBeforeDeafen
      useSoundStore().setSuppressed(previousDeafened)
      applyAllVolumes()
      syncParticipants()
      queueDeafenedSync(previousDeafened)
    } finally {
      deafenChanging.value = false
    }
  }

  async function switchInput(deviceId: string) {
    if (!room) return
    await room.switchActiveDevice('audioinput', deviceId, true)
    activeInputId.value = deviceId
  }

  async function switchOutput(deviceId: string) {
    if (!room) return
    await room.switchActiveDevice('audiooutput', deviceId, true)
    activeOutputId.value = deviceId
    useSoundStore().setOutputDevice(deviceId)
    document.querySelectorAll<HTMLAudioElement>('#voice-audio-root audio').forEach((element) => {
      void setAudioSink(element, deviceId)
    })
  }

  function setParticipantVolume(userId: number, volume: number) {
    const normalized = clampVolume(volume)
    localStorage.setItem(`cws.volume.${userId}`, String(normalized))
    const participant = participantStates.value.find((item) => item.userId === userId)
    if (participant) participant.volume = normalized
    applyVolume(userId)
  }

  function setMicrophoneGain(volume: number) {
    const normalized = clampVolume(volume)
    microphoneGain.value = normalized
    localStorage.setItem(MICROPHONE_GAIN_KEY, String(normalized))
    microphoneGainProcessor.setGain(normalized)
  }

  function setOutputVolume(volume: number) {
    const normalized = clampVolume(volume)
    outputVolume.value = normalized
    localStorage.setItem(OUTPUT_VOLUME_KEY, String(normalized))
    applyAllVolumes()
  }

  function setEchoCancellation(value: boolean) {
    echoCancellation.value = value
    localStorage.setItem(ECHO_CANCELLATION_KEY, String(value))
  }

  function setNoiseSuppression(value: boolean) {
    noiseSuppression.value = value
    localStorage.setItem(NOISE_SUPPRESSION_KEY, String(value))
  }

  async function applyBitrateChange() {
    if (!room) return
    const target = room
    if (!muted.value && !useAppStore().user?.voiceMuted) {
      await target.localParticipant.setMicrophoneEnabled(false)
      await target.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
      await attachMicrophoneGain(target)
    }
    if (applicationAudioTrack) {
      const track = applicationAudioTrack
      const generation = applicationAudioGeneration
      const wasPaused = applicationAudioState.value === 'paused'
      try {
        await target.localParticipant.unpublishTrack(track, false)
        if (generation !== applicationAudioGeneration || room !== target) return
        const publication = await target.localParticipant.publishTrack(track, applicationAudioPublishOptions())
        if (generation !== applicationAudioGeneration || room !== target) {
          await target.localParticipant.unpublishTrack(publication.track!, false).catch(() => undefined)
          return
        }
        applicationAudioPublication = publication
        applicationAudioTrack = publication.audioTrack ?? null
        if (wasPaused) await applicationAudioTrack?.mute()
      } catch (error) {
        applicationAudioError.value = applicationAudioErrorMessage(error)
        await stopApplicationAudio()
      }
    }
    syncParticipants()
  }

  async function syncServerMute(serverMuted: boolean) {
    if (!room || !serverMuted) return
    const target = room
    const stoppingBackgroundAudio = stopApplicationAudio()
    await target.localParticipant.setMicrophoneEnabled(false)
    await stoppingBackgroundAudio
    microphoneBeforeDeafen = false
    muted.value = true
    syncParticipants()
  }


  async function refreshDevices(requestPermissions = false) {
    const [inputs, outputs] = await Promise.all([
      Room.getLocalDevices('audioinput', requestPermissions),
      Room.getLocalDevices('audiooutput', false),
    ])
    inputDevices.value = inputs
    outputDevices.value = outputs
    activeInputId.value = room?.getActiveDevice('audioinput') ?? inputs[0]?.deviceId ?? ''
    activeOutputId.value = room?.getActiveDevice('audiooutput') ?? outputs[0]?.deviceId ?? ''
    useSoundStore().setOutputDevice(activeOutputId.value)
  }

  function bindRoom(target: Room) {
    target
      .on(RoomEvent.TrackSubscribed, attachTrack)
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.ParticipantConnected, () => handleParticipantChange(target, 'join'))
      .on(RoomEvent.ParticipantDisconnected, () => handleParticipantChange(target, 'leave'))
      .on(RoomEvent.ActiveSpeakersChanged, syncParticipants)
      .on(RoomEvent.TrackPublished, syncParticipants)
      .on(RoomEvent.TrackUnpublished, syncParticipants)
      .on(RoomEvent.TrackMuted, syncParticipants)
      .on(RoomEvent.TrackUnmuted, syncParticipants)
      .on(RoomEvent.LocalTrackPublished, syncParticipants)
      .on(RoomEvent.LocalTrackUnpublished, syncParticipants)
      .on(RoomEvent.ParticipantAttributesChanged, syncParticipants)
      .on(RoomEvent.ConnectionQualityChanged, syncParticipants)
      .on(RoomEvent.Reconnecting, () => {
        participantSoundsReady = false
        status.value = 'reconnecting'
      })
      .on(RoomEvent.Reconnected, () => {
        if (room !== target) return
        status.value = 'connected'
        syncParticipants()
        queueDeafenedSync(deafened.value)
        participantSoundsReady = true
        useAppStore().requestVoiceRoomsRefresh()
      })
      .on(RoomEvent.Disconnected, () => {
        if (room === target) {
          void stopApplicationAudio()
          voiceSession += 1
          participantSoundsReady = false
          room = null
          connectedChannelId.value = null
          status.value = 'idle'
          participantStates.value = []
          muted.value = false
          deafened.value = false
          microphoneBeforeDeafen = false
          pendingDeafenedSync = null
          deafenedSyncError.value = ''
          microphoneActivity.destroy()
          useSoundStore().setSuppressed(false)
          useAppStore().requestVoiceRoomsRefresh()
        }
      })
  }

  function handleParticipantChange(target: Room, sound: 'join' | 'leave') {
    if (room !== target) return
    syncParticipants()
    useAppStore().requestVoiceRoomsRefresh()
    if (participantSoundsReady && status.value === 'connected') useSoundStore().play(sound)
  }

  function attachTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (track.kind !== Track.Kind.Audio || !(track instanceof RemoteAudioTrack)) return
    const element = track.attach()
    element.dataset.userId = String(participantUserId(participant))
    element.dataset.trackSource = publication.source
    element.autoplay = true
    element.style.display = 'none'
    document.querySelector('#voice-audio-root')?.appendChild(element)
    if (activeOutputId.value) void setAudioSink(element, activeOutputId.value)
    applyVolume(participantUserId(participant))
    syncParticipants()
  }

  function detachTrack(track: RemoteTrack) {
    track.detach().forEach((element) => element.remove())
    syncParticipants()
  }

  function syncParticipants() {
    if (!room) return
    const app = useAppStore()
    const values: VoiceParticipant[] = []
    if (app.user) values.push(toVoiceParticipant(room.localParticipant, true, app.user.id))
    room.remoteParticipants.forEach((participant) => {
      values.push(toVoiceParticipant(participant, false, participantUserId(participant)))
    })
    participantStates.value = values
    microphoneActivity.sync([room.localParticipant, ...room.remoteParticipants.values()].flatMap((participant) => {
      const publication = participant.getTrackPublication(Track.Source.Microphone)
      const track = publication?.audioTrack
      return track ? [{
        identity: participant.identity,
        mediaTrack: track.mediaStreamTrack,
        muted: publication.isMuted,
      }] : []
    }))
  }

  function toVoiceParticipant(participant: Participant, isLocal: boolean, userId: number): VoiceParticipant {
    const existing = participantStates.value.find((item) => item.identity === participant.identity)
    return {
      identity: participant.identity,
      userId,
      name: participant.name || participant.identity,
      isLocal,
      isSpeaking: microphoneActivity.isSpeaking(participant.identity),
      microphoneEnabled: participant.isMicrophoneEnabled,
      backgroundAudioPlaying: isBackgroundAudioPlaying(participant),
      deafened: isLocal ? deafened.value : participant.attributes[DEAFENED_ATTRIBUTE] === 'true',
      quality: participant.connectionQuality,
      volume: getSavedVolume(userId),
      role: participantRole(participant),
      joinedAt: existing ? existing.joinedAt : participantJoinedAt(participant),
    }
  }

  function queueDeafenedSync(value: boolean) {
    if (!room) return
    pendingDeafenedSync = value
    if (deafenedSyncSession !== voiceSession) void flushDeafenedSync()
  }

  function retryDeafenedSync() {
    if (deafenedSyncError.value) queueDeafenedSync(deafened.value)
  }

  async function flushDeafenedSync() {
    const session = voiceSession
    if (deafenedSyncSession === session) return
    deafenedSyncSession = session
    try {
      while (room && session === voiceSession && pendingDeafenedSync !== null) {
        const value = pendingDeafenedSync
        pendingDeafenedSync = null
        try {
          if (connectedChannelId.value === null) break
          await request<void>(`/api/channels/${connectedChannelId.value}/voice/state`, {
            method: 'PATCH',
            body: JSON.stringify({ deafened: value }),
          })
          if (session === voiceSession) deafenedSyncError.value = ''
        } catch {
          if (session === voiceSession) {
            pendingDeafenedSync = deafened.value
            deafenedSyncError.value = '耳机静音状态同步失败，将在连接恢复后重试'
          }
          break
        }
      }
    } finally {
      if (deafenedSyncSession === session) deafenedSyncSession = null
    }
  }

  async function initializeApplicationAudio() {
    if (applicationAudioInitialized) return
    applicationAudioInitialized = true
    const connected = await connectApplicationAudioBridge()
    if (!connected) return
    applicationAudioBridge = connected.bridge
    removeApplicationAudioSnapshotListener = connected.bridge.onSnapshot((snapshot) => {
      if (isApplicationAudioSnapshot(snapshot)) applyApplicationAudioSnapshot(snapshot)
    })
    removeApplicationAudioPcmListener = onApplicationAudioPcmPort(handleApplicationAudioPcmPort)
    applicationAudioSupported.value = connected.snapshot.supported
    applicationAudioState.value = connected.snapshot.supported ? 'idle' : 'unsupported'
    applicationAudioRevision = connected.snapshot.revision
    const latest = await connected.bridge.getSnapshot().catch(() => null)
    if (!latest || !isApplicationAudioSnapshot(latest) || !latest.supported) {
      disableApplicationAudio()
      return
    }
    if (latest.sessionId) {
      await connected.bridge.stop(latest.sessionId).catch(() => undefined)
      applicationAudioState.value = 'idle'
      applicationAudioSessionId.value = null
    } else {
      applyApplicationAudioSnapshot(latest)
    }
    window.addEventListener('pagehide', handleApplicationAudioPageHide)
  }

  async function startApplicationAudio() {
    const app = useAppStore()
    if (!applicationAudioInitialized) await initializeApplicationAudio()
    if (!applicationAudioBridge || !applicationAudioSupported.value || applicationAudioOperating.value) return false
    if (!room || status.value !== 'connected' || app.user?.voiceMuted || deafened.value) {
      applicationAudioError.value = '请先连接语音频道并取消耳机静音'
      return false
    }
    if (applicationAudioSessionId.value) return true
    const target = room
    const session = voiceSession
    const generation = ++applicationAudioGeneration
    let startedSessionId: string | null = null
    applicationAudioOperating.value = true
    applicationAudioState.value = 'selecting'
    applicationAudioError.value = ''
    const pipeline = new ApplicationAudioPipeline()
    applicationAudioPipeline = pipeline
    try {
      const mediaTrack = await pipeline.initialize(applicationAudioVolume.value)
      if (generation !== applicationAudioGeneration) throw new Error('背景音启动已取消')
      const snapshot = await applicationAudioBridge.start()
      if (!isApplicationAudioSnapshot(snapshot)) throw new Error('桌面客户端返回了无效的背景音状态')
      startedSessionId = snapshot.sessionId
      if (generation !== applicationAudioGeneration || app.user?.voiceMuted) throw new Error('背景音启动已取消')
      applyApplicationAudioSnapshot(snapshot)
      if (isSourcePickerCancellation(snapshot)) {
        await cleanupApplicationAudioMedia(target)
        applicationAudioState.value = 'idle'
        return false
      }
      const sessionId = snapshot.sessionId ?? applicationAudioSessionId.value
      if (!sessionId || !['starting', 'playing', 'paused'].includes(snapshot.state)) {
        throw applicationAudioSnapshotError(snapshot, '无法启动应用背景音')
      }
      applicationAudioSessionId.value = sessionId
      applicationAudioState.value = snapshot.state
      const port = await waitForApplicationAudioPort(sessionId)
      if (generation !== applicationAudioGeneration) {
        port.close()
        throw new Error('背景音启动已取消')
      }
      if (!pipeline.attachPort(sessionId, port)) throw new Error('背景音 PCM 端口无效')
      if (room !== target || session !== voiceSession || app.user?.voiceMuted) throw new Error('语音频道已切换')
      const publication = await target.localParticipant.publishTrack(mediaTrack, applicationAudioPublishOptions())
      if (room !== target || session !== voiceSession || applicationAudioSessionId.value !== sessionId) {
        await target.localParticipant.unpublishTrack(publication.track!, false).catch(() => undefined)
        throw new Error('背景音会话已经失效')
      }
      applicationAudioPublication = publication
      applicationAudioTrack = publication.audioTrack ?? null
      if (snapshot.state === 'paused') await publication.mute()
      syncParticipants()
      return true
    } catch (error) {
      if (!applicationAudioError.value) applicationAudioError.value = applicationAudioErrorMessage(error)
      const sessionId = startedSessionId ?? applicationAudioSessionId.value
      if (sessionId) await applicationAudioBridge.stop(sessionId).catch(() => undefined)
      await cleanupApplicationAudioMedia(target)
      applicationAudioState.value = 'idle'
      return false
    } finally {
      applicationAudioOperating.value = false
    }
  }

  async function pauseApplicationAudio(autoPaused = false) {
    if (!applicationAudioBridge || !applicationAudioSessionId.value || applicationAudioState.value !== 'playing') return false
    if (applicationAudioOperating.value) return false
    applicationAudioOperating.value = true
    applicationAudioError.value = ''
    const sessionId = applicationAudioSessionId.value
    const generation = applicationAudioGeneration
    try {
      const snapshot = await applicationAudioBridge.pause(sessionId)
      if (!isApplicationAudioSnapshot(snapshot)) throw new Error('桌面客户端返回了无效的背景音状态')
      if (applicationAudioSessionId.value !== sessionId || generation !== applicationAudioGeneration) return false
      applyApplicationAudioSnapshot(snapshot)
      await applicationAudioPublication?.mute()
      applicationAudioPipeline?.reset(sessionId)
      applicationAudioState.value = 'paused'
      applicationAudioAutoPaused = autoPaused
      syncParticipants()
      return true
    } catch (error) {
      applicationAudioError.value = applicationAudioErrorMessage(error)
      if (autoPaused) await stopApplicationAudio()
      return false
    } finally {
      applicationAudioOperating.value = false
    }
  }

  async function resumeApplicationAudio(autoResume = false) {
    if (!applicationAudioBridge || !applicationAudioSessionId.value || applicationAudioState.value !== 'paused') return false
    if (applicationAudioOperating.value) return false
    applicationAudioOperating.value = true
    applicationAudioError.value = ''
    const sessionId = applicationAudioSessionId.value
    const generation = applicationAudioGeneration
    try {
      const snapshot = await applicationAudioBridge.resume(sessionId)
      if (!isApplicationAudioSnapshot(snapshot)) throw new Error('桌面客户端返回了无效的背景音状态')
      if (applicationAudioSessionId.value !== sessionId || generation !== applicationAudioGeneration) return false
      applyApplicationAudioSnapshot(snapshot)
      await applicationAudioPublication?.unmute()
      applicationAudioState.value = 'playing'
      applicationAudioAutoPaused = false
      syncParticipants()
      return true
    } catch (error) {
      applicationAudioError.value = applicationAudioErrorMessage(error)
      if (autoResume) applicationAudioAutoPaused = false
      return false
    } finally {
      applicationAudioOperating.value = false
    }
  }

  async function stopApplicationAudio() {
    applicationAudioGeneration += 1
    const bridge = applicationAudioBridge
    const sessionId = applicationAudioSessionId.value
    if (!sessionId && !applicationAudioPipeline && !applicationAudioTrack) return
    applicationAudioState.value = 'stopping'
    applicationAudioAutoPaused = false
    const target = room
    await cleanupApplicationAudioMedia(target)
    if (bridge && sessionId) await bridge.stop(sessionId).catch(() => undefined)
    applicationAudioState.value = applicationAudioSupported.value ? 'idle' : 'unsupported'
    syncParticipants()
  }

  function setApplicationAudioVolume(value: number) {
    const normalized = clampApplicationAudioVolume(value)
    applicationAudioVolume.value = normalized
    localStorage.setItem(APPLICATION_AUDIO_VOLUME_KEY, String(normalized))
    applicationAudioPipeline?.setVolume(normalized)
  }

  function applyApplicationAudioSnapshot(snapshot: ApplicationAudioSnapshot) {
    if (snapshot.revision < applicationAudioRevision) return
    if (applicationAudioSessionId.value && snapshot.sessionId && snapshot.sessionId !== applicationAudioSessionId.value) return
    if (!applicationAudioSessionId.value && snapshot.sessionId && !['selecting', 'starting'].includes(applicationAudioState.value)) return
    applicationAudioRevision = snapshot.revision
    if (!snapshot.supported) {
      disableApplicationAudio()
      return
    }
    applicationAudioSupported.value = true
    if (snapshot.sessionId) applicationAudioSessionId.value = snapshot.sessionId
    applicationAudioState.value = snapshot.state
    if (snapshot.error && snapshot.error.code !== 'source_picker_cancelled') {
      applicationAudioError.value = applicationAudioErrorMessage(snapshot.error)
    }
    if (snapshot.state === 'playing') void synchronizeApplicationAudioPublication(false)
    if (snapshot.state === 'paused') void synchronizeApplicationAudioPublication(true)
    if (snapshot.state === 'error' || (snapshot.state === 'idle' && applicationAudioSessionId.value)) {
      void cleanupApplicationAudioMedia(room)
      applicationAudioState.value = 'idle'
    }
  }

  function handleApplicationAudioPcmPort(event: { sessionId: string; port: MessagePort }) {
    if (pendingApplicationAudioPortWaiter?.sessionId === event.sessionId) {
      const waiter = pendingApplicationAudioPortWaiter
      pendingApplicationAudioPortWaiter = null
      window.clearTimeout(waiter.timer)
      waiter.resolve(event.port)
      return
    }
    if (applicationAudioPipeline?.hasAttachedPort(event.sessionId)) {
      event.port.close()
      return
    }
    if ((!applicationAudioSessionId.value && ['selecting', 'starting'].includes(applicationAudioState.value)) || applicationAudioSessionId.value === event.sessionId) {
      pendingApplicationAudioPort?.port.close()
      pendingApplicationAudioPort = event
      return
    }
    event.port.close()
  }

  function waitForApplicationAudioPort(sessionId: string) {
    if (pendingApplicationAudioPort?.sessionId === sessionId) {
      const port = pendingApplicationAudioPort.port
      pendingApplicationAudioPort = null
      return Promise.resolve(port)
    }
    pendingApplicationAudioPort?.port.close()
    pendingApplicationAudioPort = null
    return new Promise<MessagePort>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (pendingApplicationAudioPortWaiter?.sessionId === sessionId) pendingApplicationAudioPortWaiter = null
        reject(new Error('等待背景音 PCM 端口超时'))
      }, APPLICATION_AUDIO_PORT_TIMEOUT_MS)
      pendingApplicationAudioPortWaiter = { sessionId, resolve, reject, timer }
    })
  }

  async function cleanupApplicationAudioMedia(target: Room | null) {
    rejectPendingApplicationAudioPort()
    pendingApplicationAudioPort?.port.close()
    pendingApplicationAudioPort = null
    const publication = applicationAudioPublication
    applicationAudioPublication = null
    applicationAudioTrack = null
    if (target && publication?.track) {
      await target.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined)
    }
    const pipeline = applicationAudioPipeline
    applicationAudioPipeline = null
    await pipeline?.destroy()
    applicationAudioSessionId.value = null
    applicationAudioAutoPaused = false
  }

  async function synchronizeApplicationAudioPublication(muted: boolean) {
    const publication = applicationAudioPublication
    if (!publication || publication.isMuted === muted) return
    try {
      if (muted) await publication.mute()
      else await publication.unmute()
      syncParticipants()
    } catch {
      applicationAudioError.value = '无法同步背景音播放状态'
    }
  }

  function rejectPendingApplicationAudioPort() {
    const waiter = pendingApplicationAudioPortWaiter
    if (!waiter) return
    pendingApplicationAudioPortWaiter = null
    window.clearTimeout(waiter.timer)
    waiter.reject(new Error('背景音会话已经停止'))
  }

  function disableApplicationAudio() {
    applicationAudioSupported.value = false
    applicationAudioState.value = 'unsupported'
    removeApplicationAudioSnapshotListener?.()
    removeApplicationAudioPcmListener?.()
    removeApplicationAudioSnapshotListener = null
    removeApplicationAudioPcmListener = null
    applicationAudioBridge = null
    window.removeEventListener('pagehide', handleApplicationAudioPageHide)
    void cleanupApplicationAudioMedia(room)
  }

  function handleApplicationAudioPageHide() {
    const bridge = applicationAudioBridge
    const sessionId = applicationAudioSessionId.value
    if (bridge && sessionId) void bridge.stop(sessionId)
  }

  function participantUserId(participant: Participant): number {
    const fromAttribute = Number(participant.attributes.user_id)
    if (Number.isFinite(fromAttribute) && fromAttribute > 0) return fromAttribute
    const match = participant.identity.match(/^user-(\d+)$/)
    return match ? Number(match[1]) : 0
  }

  function publishOptions() {
    const channel = useAppStore().voiceChannels.find((item) => item.id === connectedChannelId.value)
    return {
      audioPreset: { maxBitrate: (channel?.audioBitrateKbps ?? 64) * 1000 },
      dtx: true,
      red: true,
      forceStereo: false,
    }
  }

  function applicationAudioPublishOptions() {
    const channel = useAppStore().voiceChannels.find((item) => item.id === connectedChannelId.value)
    return {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: (channel?.audioBitrateKbps ?? 64) * 1000 },
      dtx: false,
      red: true,
      forceStereo: true,
    }
  }

  async function attachMicrophoneGain(target: Room) {
    const track = target.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (track && track.getProcessor() !== microphoneGainProcessor) {
      await track.setProcessor(microphoneGainProcessor)
    }
  }

  async function restoreMicrophoneState(target: Room, enabled: boolean) {
    try {
      if (target.localParticipant.isMicrophoneEnabled !== enabled) {
        await target.localParticipant.setMicrophoneEnabled(enabled, undefined, enabled ? publishOptions() : undefined)
      }
      if (enabled) await attachMicrophoneGain(target)
    } catch {
      // The participant state below remains the source of truth if rollback also fails.
    }
  }

  function getSavedVolume(userId: number): number {
    return getSavedLevel(`cws.volume.${userId}`)
  }

  function applyAllVolumes() {
    participantStates.value.forEach((participant) => applyVolume(participant.userId))
  }

  function applyVolume(userId: number) {
    if (!room) return
    const gain = deafened.value ? 0 : Math.max(0, getSavedVolume(userId) * outputVolume.value)
    room.remoteParticipants.forEach((participant) => {
      if (participantUserId(participant) === userId) {
        participant.setVolume(gain, Track.Source.Microphone)
        participant.setVolume(gain, Track.Source.ScreenShareAudio)
      }
    })
  }

  return {
    status,
    connectedChannelId,
    errorMessage,
    deafenedSyncError,
    muted,
    deafened,
    deafenChanging,
    participants,
    inputDevices,
    outputDevices,
    activeInputId,
    activeOutputId,
    microphoneGain,
    outputVolume,
    echoCancellation,
    noiseSuppression,
    applicationAudioSupported,
    applicationAudioState,
    applicationAudioError,
    applicationAudioVolume,
    applicationAudioActive,
    applicationAudioPlaying,
    applicationAudioChanging,
    joined,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    switchInput,
    switchOutput,
    setParticipantVolume,
    setMicrophoneGain,
    setOutputVolume,
    setEchoCancellation,
    setNoiseSuppression,
    initializeApplicationAudio,
    startApplicationAudio,
    pauseApplicationAudio,
    resumeApplicationAudio,
    stopApplicationAudio,
    setApplicationAudioVolume,
    applyBitrateChange,
    syncServerMute,
    retryDeafenedSync,
    refreshDevices,
  }
})

function clampVolume(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_VOLUME, value)) : DEFAULT_VOLUME
}

function getSavedLevel(key: string) {
  const saved = localStorage.getItem(key)
  if (saved === null) return DEFAULT_VOLUME
  return clampVolume(Number(saved))
}

function getSavedBoolean(key: string, defaultValue: boolean) {
  const saved = localStorage.getItem(key)
  if (saved === null) return defaultValue
  return saved !== 'false'
}

function getSavedApplicationAudioVolume() {
  const saved = localStorage.getItem(APPLICATION_AUDIO_VOLUME_KEY)
  if (saved === null) return APPLICATION_AUDIO_DEFAULT_VOLUME
  return clampApplicationAudioVolume(Number(saved))
}

function clampApplicationAudioVolume(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : APPLICATION_AUDIO_DEFAULT_VOLUME
}

function isBackgroundAudioPlaying(participant: Participant) {
  const publication = participant.getTrackPublication(Track.Source.ScreenShareAudio)
  return Boolean(publication && !publication.isMuted)
}

function isSourcePickerCancellation(snapshot: ApplicationAudioSnapshot) {
  return snapshot.error?.code === 'source_picker_cancelled' || (snapshot.state === 'idle' && !snapshot.sessionId)
}

function applicationAudioSnapshotError(snapshot: ApplicationAudioSnapshot, fallback: string) {
  return snapshot.error ?? new Error(fallback)
}

function applicationAudioErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (isApplicationAudioError(error) && error.message) return error.message
  return '应用背景音操作失败，请重新选择'
}

function isApplicationAudioError(value: unknown): value is ApplicationAudioError {
  return typeof value === 'object' && value !== null && typeof (value as ApplicationAudioError).code === 'string'
    && typeof (value as ApplicationAudioError).message === 'string'
}

function compareParticipants(a: VoiceParticipant, b: VoiceParticipant, users: User[]) {
  const roleDifference = roleRank(currentRole(b, users)) - roleRank(currentRole(a, users))
  if (roleDifference !== 0) return roleDifference
  if (a.joinedAt !== null && b.joinedAt !== null && a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt
  return a.userId - b.userId || a.identity.localeCompare(b.identity)
}

function currentRole(participant: VoiceParticipant, users: User[]): Role {
  return users.find((user) => user.id === participant.userId)?.role ?? participant.role
}

function roleRank(role: Role) {
  if (role === 'server_admin') return 2
  if (role === 'channel_admin') return 1
  return 0
}

function participantRole(participant: Participant): Role {
  const role = participant.attributes.role
  return role === 'server_admin' || role === 'channel_admin' ? role : 'member'
}

function participantJoinedAt(participant: Participant): number | null {
  const timestamp = participant.joinedAt?.getTime()
  return timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : null
}

async function setAudioSink(element: HTMLAudioElement, deviceId: string) {
  const sinkElement = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (sinkElement.setSinkId) await sinkElement.setSinkId(deviceId)
}
