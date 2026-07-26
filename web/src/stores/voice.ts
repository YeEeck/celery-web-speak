import { computed, markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import {
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
import { MicrophoneActivityMonitor } from '../audio/MicrophoneActivityMonitor'
import { MicrophoneGainProcessor } from '../audio/MicrophoneGainProcessor'
import type { Channel, VoiceCredentials } from '../types'
import { useAppStore } from './app'
import { useSoundStore } from './sounds'
import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEAFENED_ATTRIBUTE,
  ECHO_CANCELLATION_KEY,
  MICROPHONE_GAIN_KEY,
  NOISE_SUPPRESSION_KEY,
  OUTPUT_VOLUME_KEY,
  clampVolume,
  compareParticipants,
  defaultConnectedPublishSettings,
  getSavedBackgroundAudioVolume,
  getSavedBoolean,
  getSavedLevel,
  getSavedMuted,
  getSavedTransmissionMode,
  getSavedVolume,
  hasBackgroundAudio,
  isBackgroundAudioPlaying,
  participantJoinedAt,
  participantRole,
  participantUserId,
  saveTransmissionMode,
  setAudioSink,
  type VoiceParticipant,
  type VoiceTransmissionMode,
} from './voice-utils'
import { useParticipantVolume } from './voice-participant-volume'
import { useApplicationAudio } from './voice-application-audio'

export type { VoiceParticipant, VoiceTransmissionMode } from './voice-utils'

export const useVoiceStore = defineStore('voice', () => {
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const connectedChannelId = ref<number | null>(null)
  const connectedServerId = ref<number | null>(null)
  const connectedServerName = ref('')
  const connectedChannelName = ref('')
  const connectedPublishSettings = ref(defaultConnectedPublishSettings())
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
  const transmissionMode = ref<VoiceTransmissionMode>(getSavedTransmissionMode())
  const transmissionModeChanging = ref(false)
  const transmissionModeError = ref('')
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

  const joined = computed(() => status.value !== 'idle' && status.value !== 'error')
  const connectedAudioBitrateKbps = computed(() => connectedPublishSettings.value.audioBitrateKbps)
  const dtxEnabled = computed(() => transmissionMode.value === 'voice-activity')

  const appAudio = useApplicationAudio({
    room: () => room,
    voiceSession: () => voiceSession,
    deafened: () => deafened.value,
    status: () => status.value,
    connectedPublishSettings: () => connectedPublishSettings.value,
    syncParticipants,
  })

  const participants = computed(() => {
    const app = useAppStore()
    const connectedUsers = app.activeServerId === connectedServerId.value ? app.users : []
    return [...participantStates.value].sort((a, b) => compareParticipants(a, b, connectedUsers))
  })

  const participantVolume = useParticipantVolume({
    room: () => room,
    deafened,
    outputVolume,
    participantStates,
  })

  // 页面关闭时主动通知后端离开语音频道，避免依赖 LiveKit 的断开检测延迟（关闭标签页/窗口时
  // LiveKit 可能需要数十秒才能通过心跳超时发现连接已断开，导致成员列表出现幽灵状态）。
  window.addEventListener('pagehide', () => {
    const serverId = connectedServerId.value
    if (!joined.value || serverId === null) return
    navigator.sendBeacon(`/api/servers/${serverId}/voice/leave`)
  })

  async function join(channelId: number) {
    if (room && connectedChannelId.value === channelId) return
    if (status.value === 'connecting') return
    if (room) await leave()
    voiceSession += 1
    const session = voiceSession
    const app = useAppStore()
    status.value = 'connecting'
    errorMessage.value = ''
    deafenedSyncError.value = ''
    transmissionModeError.value = ''
    pendingDeafenedSync = null
    microphoneBeforeDeafen = false
    try {
      const channel = app.voiceChannels.find((item) => item.id === channelId)
      if (!channel) throw new Error('语音频道不存在')
      const server = app.activeServer
      if (!server || app.activeServerId !== server.id) throw new Error('未选择服务器')
      const serverId = server.id
      const serverName = server.name
      const serverVoiceMuted = app.user?.voiceMuted ?? false
      const credentials = await request<VoiceCredentials>(`/api/servers/${serverId}/channels/${channelId}/voice/token`, { method: 'POST' })
      if (session !== voiceSession) return
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
          audioPreset: { maxBitrate: (channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS) * 1000 },
          dtx: dtxEnabled.value,
          red: channel.audioRedEnabled ?? true,
          forceStereo: false,
        },
      }))
      room = nextRoom
      connectedChannelId.value = channelId
      connectedServerId.value = serverId
      connectedServerName.value = serverName
      connectedChannelName.value = channel.name
      setConnectedChannelSettings(channel)
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token, { autoSubscribe: true, maxRetries: 5 })
      if (session !== voiceSession || room !== nextRoom) return
      await nextRoom.startAudio()
      if (session !== voiceSession || room !== nextRoom) return
      if (!serverVoiceMuted) {
        await nextRoom.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
        if (session !== voiceSession || room !== nextRoom) return
        await attachMicrophoneGain(nextRoom)
        if (session !== voiceSession || room !== nextRoom) return
      }
      muted.value = serverVoiceMuted
      status.value = 'connected'
      await refreshDevices(true)
      if (session !== voiceSession || room !== nextRoom) return
      syncParticipants()
      participantSoundsReady = true
      useSoundStore().play('join')
      app.requestVoiceRoomsRefresh()
    } catch (error) {
      if (session !== voiceSession) return
      participantSoundsReady = false
      room?.disconnect()
      room = null
      clearConnectedChannelSummary()
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : '无法连接语音频道'
      throw error
    }
  }

  async function leave(options: { notifyServer?: boolean } = {}) {
    const app = useAppStore()
    const wasJoined = room !== null
    const serverId = connectedServerId.value
    await appAudio.stopApplicationAudio()
    voiceSession += 1
    participantSoundsReady = false
    if (room) {
      room.disconnect()
      room = null
    }
    clearConnectedChannelSummary()
    document.querySelectorAll('#voice-audio-root audio').forEach((element) => element.remove())
    participantStates.value = []
    status.value = 'idle'
    muted.value = false
    deafened.value = false
    microphoneBeforeDeafen = false
    pendingDeafenedSync = null
    deafenedSyncError.value = ''
    transmissionModeError.value = ''
    microphoneActivity.destroy()
    useSoundStore().setSuppressed(false)
    if (wasJoined && serverId !== null && options.notifyServer !== false) {
      await request(`/api/servers/${serverId}/voice/leave`, { method: 'POST' })
      app.requestVoiceRoomsRefresh()
    }
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
        if (appAudio.applicationAudioState.value === 'playing') await appAudio.pauseApplicationAudio(true)
        deafened.value = true
        useSoundStore().setSuppressed(true)
        participantVolume.applyAllVolumes()
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
        participantVolume.applyAllVolumes()
        if (appAudio.isAutoPaused() && appAudio.applicationAudioState.value === 'paused') {
          await appAudio.resumeApplicationAudio(true)
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
      participantVolume.applyAllVolumes()
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
    participantVolume.applyAllVolumes()
  }

  function setEchoCancellation(value: boolean) {
    echoCancellation.value = value
    localStorage.setItem(ECHO_CANCELLATION_KEY, String(value))
  }

  function setNoiseSuppression(value: boolean) {
    noiseSuppression.value = value
    localStorage.setItem(NOISE_SUPPRESSION_KEY, String(value))
  }

  async function toggleTransmissionMode() {
    if (transmissionModeChanging.value || deafenChanging.value || status.value !== 'connected') return
    const previous = transmissionMode.value
    const next: VoiceTransmissionMode = previous === 'voice-activity' ? 'continuous' : 'voice-activity'
    transmissionMode.value = next
    saveTransmissionMode(next)
    transmissionModeError.value = ''

    const app = useAppStore()
    if (!room || muted.value || deafened.value || app.user?.voiceMuted) return
    const target = room
    const session = voiceSession
    transmissionModeChanging.value = true
    try {
      await republishMicrophone(target)
      if (session !== voiceSession || room !== target) return
      syncParticipants()
    } catch (error) {
      if (session !== voiceSession || room !== target) return
      transmissionMode.value = previous
      saveTransmissionMode(previous)
      try {
        await republishMicrophone(target)
      } catch {
        muted.value = !target.localParticipant.isMicrophoneEnabled
      }
      transmissionModeError.value = error instanceof Error ? `无法切换传输模式：${error.message}` : '无法切换传输模式'
      syncParticipants()
    } finally {
      transmissionModeChanging.value = false
    }
  }

  async function applyPublishSettingsChange(microphoneChanged: boolean, backgroundAudioChanged: boolean) {
    if (!room) return
    const target = room
    if (microphoneChanged && !muted.value && !useAppStore().user?.voiceMuted) {
      await republishMicrophone(target)
    }
    if (backgroundAudioChanged && appAudio.hasActiveTrack()) {
      await appAudio.republishBackgroundAudio()
    }
    syncParticipants()
  }

  function updateConnectedChannelSettings(channel: Channel) {
    if (channel.id !== connectedChannelId.value) return { microphoneChanged: false, backgroundAudioChanged: false }
    const previous = connectedPublishSettings.value
    const next = {
      audioBitrateKbps: channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
      backgroundAudioBitrateKbps: channel.backgroundAudioBitrateKbps ?? 128,
      audioRedEnabled: channel.audioRedEnabled ?? true,
      backgroundAudioRedEnabled: channel.backgroundAudioRedEnabled ?? false,
    }
    setConnectedChannelSettings(channel)
    return {
      microphoneChanged: previous.audioBitrateKbps !== next.audioBitrateKbps || previous.audioRedEnabled !== next.audioRedEnabled,
      backgroundAudioChanged: previous.backgroundAudioBitrateKbps !== next.backgroundAudioBitrateKbps || previous.backgroundAudioRedEnabled !== next.backgroundAudioRedEnabled,
    }
  }

  async function syncServerMute(serverMuted: boolean) {
    if (!room || !serverMuted) return
    const target = room
    const stoppingBackgroundAudio = appAudio.stopApplicationAudio()
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
          void appAudio.stopApplicationAudio()
          voiceSession += 1
          participantSoundsReady = false
          room = null
          clearConnectedChannelSummary()
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
    participantVolume.applyVolume(participantUserId(participant))
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
      backgroundAudioAvailable: hasBackgroundAudio(participant),
      backgroundAudioPlaying: isBackgroundAudioPlaying(participant),
      deafened: isLocal ? deafened.value : participant.attributes[DEAFENED_ATTRIBUTE] === 'true',
      quality: participant.connectionQuality,
      microphoneVolume: getSavedVolume(userId),
      backgroundAudioVolume: getSavedBackgroundAudioVolume(userId),
      microphoneMuted: getSavedMuted(`cws.muted.${userId}`),
      backgroundAudioMuted: getSavedMuted(`cws.backgroundAudioMuted.${userId}`),
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
	const app = useAppStore()
    const session = voiceSession
    if (deafenedSyncSession === session) return
    deafenedSyncSession = session
    try {
      while (room && session === voiceSession && pendingDeafenedSync !== null) {
        const value = pendingDeafenedSync
        pendingDeafenedSync = null
        try {
          if (connectedChannelId.value === null) break
		  if (connectedServerId.value === null) return
		  await request<void>(`/api/servers/${connectedServerId.value}/channels/${connectedChannelId.value}/voice/state`, {
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

  function setConnectedChannelSettings(channel: Channel) {
    connectedPublishSettings.value = {
      audioBitrateKbps: channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
      backgroundAudioBitrateKbps: channel.backgroundAudioBitrateKbps ?? 128,
      audioRedEnabled: channel.audioRedEnabled ?? true,
      backgroundAudioRedEnabled: channel.backgroundAudioRedEnabled ?? false,
    }
  }

  function clearConnectedChannelSummary() {
    connectedChannelId.value = null
    connectedServerId.value = null
    connectedServerName.value = ''
    connectedChannelName.value = ''
    connectedPublishSettings.value = defaultConnectedPublishSettings()
  }

  function publishOptions() {
    const settings = connectedPublishSettings.value
    return {
      audioPreset: { maxBitrate: settings.audioBitrateKbps * 1000 },
      dtx: dtxEnabled.value,
      red: settings.audioRedEnabled,
      forceStereo: false,
    }
  }

  function applicationAudioPublishOptions() {
    const settings = connectedPublishSettings.value
    return {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: settings.backgroundAudioBitrateKbps * 1000 },
      dtx: false,
      red: settings.backgroundAudioRedEnabled,
      forceStereo: true,
    }
  }

  async function attachMicrophoneGain(target: Room) {
    const track = target.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (track && track.getProcessor() !== microphoneGainProcessor) {
      await track.setProcessor(microphoneGainProcessor)
    }
  }

  async function republishMicrophone(target: Room) {
    await target.localParticipant.setMicrophoneEnabled(false)
    await target.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
    await attachMicrophoneGain(target)
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

  return {
    status,
    connectedChannelId,
    connectedServerId,
    connectedServerName,
    connectedChannelName,
    connectedAudioBitrateKbps,
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
    transmissionMode,
    transmissionModeChanging,
    transmissionModeError,
    dtxEnabled,
    applicationAudioSupported: appAudio.applicationAudioSupported,
    applicationAudioState: appAudio.applicationAudioState,
    applicationAudioError: appAudio.applicationAudioError,
    applicationAudioVolume: appAudio.applicationAudioVolume,
    applicationAudioActive: appAudio.applicationAudioActive,
    applicationAudioPlaying: appAudio.applicationAudioPlaying,
    applicationAudioChanging: appAudio.applicationAudioChanging,
    joined,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    switchInput,
    switchOutput,
    setParticipantMicrophoneVolume: participantVolume.setParticipantMicrophoneVolume,
    setParticipantBackgroundAudioVolume: participantVolume.setParticipantBackgroundAudioVolume,
    toggleParticipantMicrophoneMute: participantVolume.toggleParticipantMicrophoneMute,
    toggleParticipantBackgroundAudioMute: participantVolume.toggleParticipantBackgroundAudioMute,
    resetParticipantMicrophoneVolume: participantVolume.resetParticipantMicrophoneVolume,
    resetParticipantBackgroundAudioVolume: participantVolume.resetParticipantBackgroundAudioVolume,
    setMicrophoneGain,
    setOutputVolume,
    setEchoCancellation,
    setNoiseSuppression,
    toggleTransmissionMode,
    initializeApplicationAudio: appAudio.initializeApplicationAudio,
    startApplicationAudio: appAudio.startApplicationAudio,
    pauseApplicationAudio: appAudio.pauseApplicationAudio,
    resumeApplicationAudio: appAudio.resumeApplicationAudio,
    stopApplicationAudio: appAudio.stopApplicationAudio,
    setApplicationAudioVolume: appAudio.setApplicationAudioVolume,
    applyPublishSettingsChange,
    updateConnectedChannelSettings,
    syncServerMute,
    retryDeafenedSync,
    refreshDevices,
  }
})
