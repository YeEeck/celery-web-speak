import { markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import { Room, supportsAudioOutputSelection } from 'livekit-client'
import { request } from '../api.ts'
import type { VoiceCredentials } from '../types.ts'
import { useAppStore } from './app.ts'
import { useApplicationSoundStore } from './application-sounds.ts'
import { SpeechDetectionEngine } from '../audio/SpeechDetectionEngine.ts'
import { useVoiceDevices } from './voice-devices.ts'
import { useParticipantVolume } from './voice-participant-volume.ts'
import { useApplicationAudio } from './voice-application-audio.ts'
import { useVoiceMuteDeafenModule } from './voice-mute-deafen.ts'
import { useVoicePresence } from './voice-presence.ts'
import { useVoiceSession } from './voice-session.ts'
import { useVoiceOverlay } from './voice-overlay.ts'
import {
  DEAFENED_PREFERENCE_KEY,
  ECHO_CANCELLATION_KEY,
  MICROPHONE_ENABLED_KEY,
  MICROPHONE_GAIN_KEY,
  NOISE_SUPPRESSION_KEY,
  OUTPUT_VOLUME_KEY,
  clampVolume,
  getSavedBoolean,
  getSavedLevel,
  saveBoolean,
  setAudioSink,
  type VoiceParticipant,
  type VoiceTransmissionMode,
} from './voice-utils.ts'

export type { VoiceParticipant, VoiceTransmissionMode } from './voice-utils.ts'

export const useVoiceStore = defineStore('voice', () => {
  // 与连接无关的纯偏好（会话模块经 ctx 单向读取）。
  const microphoneGain = ref(getSavedLevel(MICROPHONE_GAIN_KEY))
  const outputVolume = ref(getSavedLevel(OUTPUT_VOLUME_KEY))
  const echoCancellation = ref(getSavedBoolean(ECHO_CANCELLATION_KEY, true))
  const noiseSuppression = ref(getSavedBoolean(NOISE_SUPPRESSION_KEY, true))

  // 跨模块组合的延迟解析位：session 模块的 ctx 需要 mute/deafen、设备、应用音频
  // 模块的输出，而这些模块的 ctx 又需要 session 的输出，创建顺序由本层化解。
  const muteDeafenRef: { current: ReturnType<typeof useVoiceMuteDeafenModule> | null } = { current: null }
  const devicesRef: { current: ReturnType<typeof useVoiceDevices> | null } = { current: null }
  const appAudioRef: { current: ReturnType<typeof useApplicationAudio> | null } = { current: null }
  const participantVolumeRef: { current: ReturnType<typeof useParticipantVolume> | null } = { current: null }

  const sounds = useApplicationSoundStore()

  // 共享说话检测引擎：静音说话提醒与在线状态检测共用一条采集流与一个 VAD
  // worker（ADR-0024）。引擎生命周期由两个消费方的引用计数协作。
  const speechDetection = new SpeechDetectionEngine({
    onError: (error) => console.warn('说话检测已停用', error),
  })

  const session = useVoiceSession({
    createSpeechDetectionEngine: () => speechDetection,
    findChannel: (channelId) => useAppStore().voiceChannels.find((item) => item.id === channelId),
    activeGuildInfo: () => {
      const app = useAppStore()
      const guild = app.activeGuild
      return app.activeGuildId === guild?.id && guild ? { id: guild.id, name: guild.name } : null
    },
    currentUser: () => {
      const user = useAppStore().user
      return user ? { id: user.id, voiceMuted: user.voiceMuted } : null
    },
    connectedUsers: () => {
      const app = useAppStore()
      return app.activeGuildId === session.connectedGuildId.value ? app.users : []
    },
    requestVoiceRoomsRefresh: () => useAppStore().requestVoiceRoomsRefresh(),
    muted: () => muteDeafenRef.current?.muted.value ?? false,
    deafened: () => muteDeafenRef.current?.deafened.value ?? false,
    guildMuted: () => muteDeafenRef.current?.guildMuted.value ?? false,
    microphoneEnabledPreference: () => muteDeafenRef.current?.microphoneEnabledPreference.value ?? false,
    deafenedPreference: () => muteDeafenRef.current?.deafenedPreference.value ?? false,
    muteChanging: () => muteDeafenRef.current?.muteChanging.value ?? false,
    deafenChanging: () => muteDeafenRef.current?.deafenChanging.value ?? false,
    refreshGuildMuted: () => {
      if (muteDeafenRef.current) muteDeafenRef.current.guildMuted.value = useAppStore().user?.voiceMuted ?? false
    },
    setMuted: (value) => {
      if (muteDeafenRef.current) muteDeafenRef.current.muted.value = value
    },
    applyConnectionPreferences: () => muteDeafenRef.current ? muteDeafenRef.current.applyConnectionPreferences() : Promise.resolve(),
    connectionReset: () => muteDeafenRef.current?.connectionReset(),
    transportRecovered: () => muteDeafenRef.current ? muteDeafenRef.current.transportRecovered() : Promise.resolve(),
    notifyPreferenceChange: () => muteDeafenRef.current?.notifyPreferenceChange(),
    resolvedPreferredInputDeviceId: () => devicesRef.current?.resolvedPreferredDeviceId('input') ?? '',
    resolvedPreferredOutputDeviceId: () => devicesRef.current?.resolvedPreferredDeviceId('output') ?? '',
    activeOutputDeviceId: () => devicesRef.current?.activeOutputId.value ?? null,
    devicePermissionState: () => devicesRef.current?.devicePermissionState.value ?? 'idle',
    supportsOutputSelection: () => devicesRef.current?.supportsOutputSelection ?? false,
    initializeDevices: () => devicesRef.current ? devicesRef.current.initializeDevices() : Promise.resolve(false),
    refreshDevices: (force) => devicesRef.current ? devicesRef.current.refreshDevices(force) : Promise.resolve(),
    applyPreferredDevicesToRoom: (room, voiceSession) => devicesRef.current
      ? devicesRef.current.applyPreferredDevicesToRoom(room, voiceSession)
      : Promise.resolve(),
    stopApplicationAudio: () => appAudioRef.current ? appAudioRef.current.stopApplicationAudio() : Promise.resolve(),
    republishBackgroundAudio: () => appAudioRef.current ? appAudioRef.current.republishBackgroundAudio() : Promise.resolve(),
    applicationAudioHasActiveTrack: () => appAudioRef.current?.hasActiveTrack() ?? false,
    applyAllVolumes: () => participantVolumeRef.current?.applyAllVolumes(),
    applyVolume: (userId) => participantVolumeRef.current?.applyVolume(userId),
    signal: (occurrence) => sounds.signal(occurrence),
    followPlayback: (options) => sounds.followPlayback(options),
    mutedSpeakingReminderAudible: () => sounds.mutedSpeakingReminderAudible,
    microphoneGainInitial: () => microphoneGain.value,
    echoCancellation: () => echoCancellation.value,
    noiseSuppression: () => noiseSuppression.value,
    fetchVoiceToken: (guildId, channelId, deafened) => request<VoiceCredentials>(`/api/guilds/${guildId}/channels/${channelId}/voice/token`, {
      method: 'POST',
      body: JSON.stringify({ deafened }),
    }),
    postVoiceLeave: (guildId) => request<void>(`/api/guilds/${guildId}/voice/leave`, { method: 'POST' }),
    createRoom: (options) => markRaw(new Room(options)),
    createAudioContext: () => {
      const AudioContextConstructor = window.AudioContext
        || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      return AudioContextConstructor ? new AudioContextConstructor({ latencyHint: 'interactive' }) : null
    },
    audioInteractionTarget: () => document,
    appendAudioElement: (element) => void document.querySelector('#voice-audio-root')?.appendChild(element),
    removeAllAudioElements: () => void document.querySelectorAll('#voice-audio-root audio').forEach((element) => element.remove()),
    applyAudioSink: (element, deviceId) => void setAudioSink(element, deviceId),
    subscribePageHide: (callback) => window.addEventListener('pagehide', callback),
    sendBeacon: (url) => navigator.sendBeacon(url),
  })

  const muteDeafen = useVoiceMuteDeafenModule({
    room: session.room,
    voiceSession: session.voiceSession,
    status: session.statusValue,
    connectedChannelId: session.connectedChannelIdValue,
    connectedGuildId: session.connectedGuildIdValue,
    guildMuteValue: () => {
      const app = useAppStore()
      return app.activeGuildId === session.connectedGuildId.value ? app.user?.voiceMuted : undefined
    },
    socketStatus: () => useAppStore().socketStatus,
    transmissionMode: session.transmissionModeValue,
    appliedTransmissionMode: session.appliedTransmissionModeValue,
    microphoneCurrentlyEnabled: () => session.room()?.localParticipant.isMicrophoneEnabled ?? false,
    saveMicrophonePreference: (enabled) => saveBoolean(MICROPHONE_ENABLED_KEY, enabled),
    saveDeafenedPreference: (value) => saveBoolean(DEAFENED_PREFERENCE_KEY, value),
    syncApplicationSoundPlayback: session.syncApplicationSoundPlayback,
    pauseApplicationAudio: async (cancelResume?: boolean) => { await appAudioRef.current?.pauseApplicationAudio(cancelResume) },
    resumeApplicationAudio: async (cancelResume?: boolean) => { await appAudioRef.current?.resumeApplicationAudio(cancelResume) },
    stopApplicationAudio: async () => { await appAudioRef.current?.stopApplicationAudio() },
    applicationAudioIsPlaying: () => { const state = appAudioRef.current?.applicationAudioState.value; return state === 'playing' },
    applicationAudioIsAutoPaused: () => { const state = appAudioRef.current?.applicationAudioState.value; return (appAudioRef.current?.isAutoPaused() ?? false) && state === 'paused' },
    enableMicrophone: session.enableMicrophone,
    republishMicrophone: session.republishMicrophone,
    attachMicrophoneGain: session.attachMicrophoneGain,
    startAudio: () => session.room()?.startAudio() ?? Promise.resolve(),
    resumeAudioContext: session.resumeVoiceAudioContext,
    syncParticipants: session.syncParticipants,
    applyAllVolumes: () => participantVolumeRef.current?.applyAllVolumes(),
    applyPreferredDevices: session.applyPreferredDevicesToCurrentRoom,
    setErrorMessage: (msg) => { session.errorMessage.value = msg },
    syncDeafenedToBackend: (guildId, channelId, value) => request<void>(`/api/guilds/${guildId}/channels/${channelId}/voice/state`, {
      method: 'PATCH',
      body: JSON.stringify({ deafened: value }),
    }),
  })

  const devices = useVoiceDevices({
    room: session.room,
    voiceSession: session.voiceSession,
    status: session.statusValue,
    joined: session.joinedValue,
    requestMicPermission: async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风访问')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      return true
    },
    getLocalDevices: (kind) => Room.getLocalDevices(kind, false),
    listenDeviceChange: (callback) => {
      navigator.mediaDevices?.addEventListener('devicechange', callback)
    },
    supportsOutputSelection: () => supportsAudioOutputSelection(),
    applyOutputSink: (deviceId) => {
      document.querySelectorAll<HTMLAudioElement>('#voice-audio-root audio').forEach((element) => {
        void setAudioSink(element, deviceId)
      })
    },
    syncSoundPlayback: session.syncApplicationSoundPlayback,
    notifyPreferenceChange: muteDeafen.notifyPreferenceChange,
  })

  const appAudio = useApplicationAudio({
    room: session.room,
    voiceSession: session.voiceSession,
    deafened: () => muteDeafen.deafened.value,
    status: session.statusValue,
    connectedPublishSettings: () => session.connectedPublishSettings.value,
    syncParticipants: session.syncParticipants,
    muted: () => useAppStore().user?.voiceMuted === true,
  })

  const participantVolume = useParticipantVolume({
    room: session.room,
    deafened: muteDeafen.deafened,
    outputVolume,
    participantStates: session.participantStates,
  })

  const overlay = useVoiceOverlay({
    status: session.statusValue,
    connectedChannelName: () => session.connectedChannelName.value,
    participants: () => session.participants.value,
    connectedUsers: () => {
      const app = useAppStore()
      return app.activeGuildId === session.connectedGuildId.value ? app.users : []
    },
  })

  muteDeafenRef.current = muteDeafen
  devicesRef.current = devices
  appAudioRef.current = appAudio
  participantVolumeRef.current = participantVolume

  const presence = useVoicePresence({
    createSpeechDetectionEngine: () => speechDetection,
    devicePermissionState: () => devicesRef.current?.devicePermissionState.value ?? 'idle',
    socketStatus: () => useAppStore().socketStatus,
    currentUserID: () => useAppStore().user?.id ?? null,
    fixedAwayFromAccount: () => useAppStore().user?.fixedAway === true,
    setStatusSettingOnServer: (fixedAway) => useAppStore().setMyStatusSetting(fixedAway),
    sendDeviceStatus: (status) => useAppStore().sendSocketMessage({ type: 'device_status', status }),
  })

  function setMicrophoneGain(volume: number) {
    const normalized = clampVolume(volume)
    microphoneGain.value = normalized
    localStorage.setItem(MICROPHONE_GAIN_KEY, String(normalized))
    session.applyMicrophoneGain(normalized)
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

  return {
    status: session.status,
    connectedChannelId: session.connectedChannelId,
    connectedGuildId: session.connectedGuildId,
    connectedGuildName: session.connectedGuildName,
    connectedChannelName: session.connectedChannelName,
    connectedAudioBitrateKbps: session.connectedAudioBitrateKbps,
    errorMessage: session.errorMessage,
    deafenedSyncError: muteDeafen.deafenedSyncError,
    voicePreferenceFeedback: muteDeafen.voicePreferenceFeedback,
    muted: muteDeafen.muted,
    deafened: muteDeafen.deafened,
    microphoneEnabledPreference: muteDeafen.microphoneEnabledPreference,
    deafenedPreference: muteDeafen.deafenedPreference,
    muteChanging: muteDeafen.muteChanging,
    deafenChanging: muteDeafen.deafenChanging,
    guildMuted: muteDeafen.guildMuted,
    participants: session.participants,
    inputDevices: devices.inputDevices,
    outputDevices: devices.outputDevices,
    activeInputId: devices.activeInputId,
    activeOutputId: devices.activeOutputId,
    preferredInputId: devices.preferredInputId,
    preferredOutputId: devices.preferredOutputId,
    inputDeviceOptions: devices.inputDeviceOptions,
    outputDeviceOptions: devices.outputDeviceOptions,
    outputDeviceSelectionSupported: devices.supportsOutputSelection,
    devicePermissionState: devices.devicePermissionState,
    devicePermissionError: devices.devicePermissionError,
    deviceChangeError: devices.deviceChangeError,
    deviceChangeErrorKind: devices.deviceChangeErrorKind,
    deviceChangingKind: devices.deviceChangingKind,
    deviceChangingId: devices.deviceChangingId,
    microphoneGain,
    outputVolume,
    echoCancellation,
    noiseSuppression,
    mutedSpeakingReminderEnabled: session.mutedSpeakingReminderEnabled,
    mutedSpeakingReminderVisible: session.mutedSpeakingReminderVisible,
    transmissionMode: session.transmissionMode,
    transmissionModeChanging: session.transmissionModeChanging,
    transmissionModeError: session.transmissionModeError,
    dtxEnabled: session.dtxEnabled,
    applicationAudioSupported: appAudio.applicationAudioSupported,
    applicationAudioState: appAudio.applicationAudioState,
    applicationAudioError: appAudio.applicationAudioError,
    applicationAudioVolume: appAudio.applicationAudioVolume,
    applicationAudioActive: appAudio.applicationAudioActive,
    applicationAudioPlaying: appAudio.applicationAudioPlaying,
    applicationAudioChanging: appAudio.applicationAudioChanging,
    joined: session.joined,
    join: session.join,
    leave: session.leave,
    toggleMute: muteDeafen.userToggledMute,
    toggleDeafen: muteDeafen.userToggledDeafen,
    switchInput: devices.switchInput,
    switchOutput: devices.switchOutput,
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
    setMutedSpeakingReminderEnabled: session.setMutedSpeakingReminderEnabled,
    toggleTransmissionMode: session.toggleTransmissionMode,
    initializeApplicationAudio: appAudio.initializeApplicationAudio,
    overlaySupported: overlay.supported,
    overlayEnabled: overlay.enabled,
    setOverlayEnabled: overlay.setOverlayEnabled,
    overlayConfig: overlay.config,
    overlayConfigSupported: overlay.configSupported,
    setOverlayConfig: overlay.setOverlayConfig,
    initializeVoiceOverlay: overlay.initializeVoiceOverlay,
    startApplicationAudio: appAudio.startApplicationAudio,
    pauseApplicationAudio: appAudio.pauseApplicationAudio,
    resumeApplicationAudio: appAudio.resumeApplicationAudio,
    stopApplicationAudio: appAudio.stopApplicationAudio,
    setApplicationAudioVolume: appAudio.setApplicationAudioVolume,
    applyPublishSettingsChange: session.applyPublishSettingsChange,
    updateConnectedChannelSettings: session.updateConnectedChannelSettings,
    syncGuildMute: muteDeafen.guildMuteChanged,
    handleModeratorDisconnect: session.handleModeratorDisconnect,
    refreshDevices: devices.refreshDevices,
    initializeDevices: devices.initializeDevices,
    requestMicrophonePermission: devices.requestMicrophonePermission,
    statusSetting: presence.statusSetting,
    ownPresenceStatus: presence.ownPresenceStatus,
    setStatusSetting: presence.setStatusSetting,
  }
})
