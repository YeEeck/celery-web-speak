import { computed, markRaw, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  Participant,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  supportsAudioOutputSelection,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import { request } from '../api'
import { MicrophoneActivityMonitor } from '../audio/MicrophoneActivityMonitor'
import { MicrophoneGainProcessor } from '../audio/MicrophoneGainProcessor'
import { buildMicrophoneCaptureOptions } from '../audio/microphoneCaptureOptions'
import { MutedSpeakingReminderMonitor } from '../audio/MutedSpeakingReminderMonitor'
import { VoiceAudioContextController } from '../audio/VoiceAudioContextController'
import type { Channel, VoiceCredentials } from '../types'
import { useAppStore } from './app'
import { useApplicationSoundStore } from './application-sounds'
import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEFAULT_DEVICE_ID,
  DEAFENED_PREFERENCE_KEY,
  DEAFENED_ATTRIBUTE,
  ECHO_CANCELLATION_KEY,
  MICROPHONE_ENABLED_KEY,
  MICROPHONE_GAIN_KEY,
  MUTED_SPEAKING_REMINDER_KEY,
  NOISE_SUPPRESSION_KEY,
  OUTPUT_VOLUME_KEY,
  PREFERRED_INPUT_DEVICE_KEY,
  PREFERRED_OUTPUT_DEVICE_KEY,
  buildVoiceDeviceOptions,
  clampVolume,
  compareParticipants,
  defaultConnectedPublishSettings,
  getSavedBackgroundAudioVolume,
  getSavedBoolean,
  getSavedDevicePreference,
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
  saveBoolean,
  saveDevicePreference,
  setAudioSink,
  type VoiceDevicePreference,
  type VoiceParticipant,
  type VoiceTransmissionMode,
} from './voice-utils'
import { useParticipantVolume } from './voice-participant-volume'
import { useApplicationAudio } from './voice-application-audio'
import { useVoiceMuteDeafenModule } from './voice-mute-deafen'

export type { VoiceParticipant, VoiceTransmissionMode } from './voice-utils'

interface LeaveOptions {
  notifyGuild?: boolean
  intent?: 'active'
}

interface EndedVoiceSession {
  guildId: number
  channelId: number
  deafened: boolean
  endedAt: number
}

const MODERATOR_DISCONNECT_MATCH_WINDOW_MS = 5_000

export const useVoiceStore = defineStore('voice', () => {
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const connectedChannelId = ref<number | null>(null)
  const connectedGuildId = ref<number | null>(null)
  const connectedGuildName = ref('')
  const connectedChannelName = ref('')
  const connectedPublishSettings = ref(defaultConnectedPublishSettings())
  const errorMessage = ref('')
  const participantStates = ref<VoiceParticipant[]>([])
  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const activeInputId = ref('')
  const activeOutputId = ref('')
  const outputDeviceSelectionSupported = supportsAudioOutputSelection()
  const savedInputDevice = getSavedDevicePreference(PREFERRED_INPUT_DEVICE_KEY)
  const savedOutputDevice = getSavedDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY)
  const preferredInputId = ref(savedInputDevice.deviceId)
  const preferredInputLabel = ref(savedInputDevice.label)
  const preferredOutputId = ref(outputDeviceSelectionSupported ? savedOutputDevice.deviceId : DEFAULT_DEVICE_ID)
  const preferredOutputLabel = ref(outputDeviceSelectionSupported ? savedOutputDevice.label : '系统默认')
  const devicePermissionState = ref<'idle' | 'requesting' | 'granted' | 'denied'>('idle')
  const devicePermissionError = ref('')
  const deviceChangeError = ref('')
  const deviceChangeErrorKind = ref<'input' | 'output' | null>(null)
  const deviceChangingKind = ref<'input' | 'output' | null>(null)
  const deviceChangingId = ref('')
  const microphoneGain = ref(getSavedLevel(MICROPHONE_GAIN_KEY))
  const outputVolume = ref(getSavedLevel(OUTPUT_VOLUME_KEY))
  const echoCancellation = ref(getSavedBoolean(ECHO_CANCELLATION_KEY, true))
  const noiseSuppression = ref(getSavedBoolean(NOISE_SUPPRESSION_KEY, true))
  const mutedSpeakingReminderEnabled = ref(getSavedBoolean(MUTED_SPEAKING_REMINDER_KEY, true))
  const mutedSpeakingReminderVisible = ref(false)
  const transmissionMode = ref<VoiceTransmissionMode>(getSavedTransmissionMode())
  const transmissionModeChanging = ref(false)
  const transmissionModeError = ref('')
  const microphoneGainProcessor = new MicrophoneGainProcessor(microphoneGain.value)
  const microphoneActivity = new MicrophoneActivityMonitor((identity, speaking) => {
    const participant = participantStates.value.find((item) => item.identity === identity)
    if (participant) participant.isSpeaking = speaking
  })
  let room: Room | null = null
  let voiceAudioContextController: VoiceAudioContextController | null = null
  let participantSoundsReady = false
  let voiceSession = 0
  let appliedTransmissionMode: VoiceTransmissionMode | null = null
  let deviceListenersInstalled = false
  let deviceInitializationPromise: Promise<boolean> | null = null
  let permissionRequestPromise: Promise<boolean> | null = null
  let deviceRefreshPromise: Promise<void> | null = null
  let mutedSpeakingReminderTimer: number | null = null
  let recentEndedSession: EndedVoiceSession | null = null

  if (!outputDeviceSelectionSupported && savedOutputDevice.deviceId !== DEFAULT_DEVICE_ID) {
    saveDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY, { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' })
  }

  const joined = computed(() => status.value !== 'idle' && status.value !== 'error')
  const connectedAudioBitrateKbps = computed(() => connectedPublishSettings.value.audioBitrateKbps)
  const dtxEnabled = computed(() => transmissionMode.value === 'voice-activity')
  const inputDeviceOptions = computed(() => buildVoiceDeviceOptions(
    inputDevices.value,
    'input',
    { deviceId: preferredInputId.value, label: preferredInputLabel.value },
    activeInputId.value,
    joined.value,
  ))
  const outputDeviceOptions = computed(() => buildVoiceDeviceOptions(
    outputDeviceSelectionSupported ? outputDevices.value : [],
    'output',
    outputDeviceSelectionSupported
      ? { deviceId: preferredOutputId.value, label: preferredOutputLabel.value }
      : { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' },
    activeOutputId.value,
    joined.value,
  ))
  const sounds = useApplicationSoundStore()

  const muteDeafen = useVoiceMuteDeafenModule({
    room: () => room,
    voiceSession: () => voiceSession,
    status: () => status.value,
    connectedChannelId: () => connectedChannelId.value,
    connectedGuildId: () => connectedGuildId.value,
    guildMuteValue: () => {
      const app = useAppStore()
      return app.activeGuildId === connectedGuildId.value ? app.user?.voiceMuted : undefined
    },
    socketStatus: () => useAppStore().socketStatus,
    transmissionMode: () => transmissionMode.value,
    appliedTransmissionMode: () => appliedTransmissionMode,
    microphoneCurrentlyEnabled: () => room?.localParticipant.isMicrophoneEnabled ?? false,
    saveMicrophonePreference: (enabled) => saveBoolean(MICROPHONE_ENABLED_KEY, enabled),
    saveDeafenedPreference: (value) => saveBoolean(DEAFENED_PREFERENCE_KEY, value),
    syncApplicationSoundPlayback,
    pauseApplicationAudio: async (cancelResume?: boolean) => { await appAudio.pauseApplicationAudio(cancelResume) },
    resumeApplicationAudio: async (cancelResume?: boolean) => { await appAudio.resumeApplicationAudio(cancelResume) },
    stopApplicationAudio: async () => { await appAudio.stopApplicationAudio() },
    applicationAudioIsPlaying: () => appAudio.applicationAudioState.value === 'playing',
    applicationAudioIsAutoPaused: () => appAudio.isAutoPaused() && appAudio.applicationAudioState.value === 'paused',
    enableMicrophone,
    republishMicrophone,
    attachMicrophoneGain,
    startAudio: () => room?.startAudio() ?? Promise.resolve(),
    resumeAudioContext: () => voiceAudioContextController?.resumeIfNeeded(),
    syncParticipants,
    applyAllVolumes: () => participantVolume.applyAllVolumes(),
    applyPreferredDevices: () => room ? applyPreferredDevicesToRoom(room, voiceSession) : Promise.resolve(),
    setErrorMessage: (msg) => { errorMessage.value = msg },
    syncDeafenedToBackend: (guildId, channelId, value) => request<void>(`/api/guilds/${guildId}/channels/${channelId}/voice/state`, {
      method: 'PATCH',
      body: JSON.stringify({ deafened: value }),
    }),
  })
  const {
    muted,
    deafened,
    guildMuted,
    microphoneEnabledPreference,
    deafenedPreference,
    muteChanging,
    deafenChanging,
    voicePreferenceFeedback,
    deafenedSyncError,
    userToggledMute,
    userToggledDeafen,
    guildMuteChanged,
    transportRecovered,
    connectionReset,
    applyConnectionPreferences,
    notifyPreferenceChange,
  } = muteDeafen

  syncApplicationSoundPlayback()
  const mutedSpeakingReminderInputDeviceId = computed(() => resolvedPreferredDeviceId('input'))
  const shouldRunMutedSpeakingReminder = computed(() => (
    status.value === 'connected'
    && !microphoneEnabledPreference.value
    && !deafenedPreference.value
    && !guildMuted.value
    && mutedSpeakingReminderEnabled.value
    && sounds.mutedSpeakingReminderAudible
    && devicePermissionState.value === 'granted'
  ))
  const mutedSpeakingReminder = new MutedSpeakingReminderMonitor({
    onReminder: showMutedSpeakingReminder,
    onError: (error) => console.warn('静音说话检测已停用', error),
  })

  watch(
    () => ({
      enabled: shouldRunMutedSpeakingReminder.value,
      deviceId: mutedSpeakingReminderInputDeviceId.value,
    }),
    (current, previous) => {
      if (!current.enabled) {
        mutedSpeakingReminder.stop()
        clearMutedSpeakingReminder()
        return
      }
      if (!previous?.enabled || current.deviceId !== previous.deviceId) {
        void mutedSpeakingReminder.start(current.deviceId)
      }
    },
    { flush: 'sync' },
  )

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
    const connectedUsers = app.activeGuildId === connectedGuildId.value ? app.users : []
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
    const guildId = connectedGuildId.value
    if (!joined.value || guildId === null) return
    navigator.sendBeacon(`/api/guilds/${guildId}/voice/leave`)
  })

  function setPreferredDevice(kind: 'input' | 'output', preference: VoiceDevicePreference) {
    if (kind === 'input') {
      preferredInputId.value = preference.deviceId
      preferredInputLabel.value = preference.label
      saveDevicePreference(PREFERRED_INPUT_DEVICE_KEY, preference)
    } else {
      preferredOutputId.value = preference.deviceId
      preferredOutputLabel.value = preference.label
      saveDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY, preference)
      syncApplicationSoundPlayback()
    }
    notifyPreferenceChange()
  }

  function showMutedSpeakingReminder() {
    if (!shouldRunMutedSpeakingReminder.value) return
    mutedSpeakingReminderVisible.value = true
    if (mutedSpeakingReminderTimer !== null) window.clearTimeout(mutedSpeakingReminderTimer)
    mutedSpeakingReminderTimer = window.setTimeout(() => {
      mutedSpeakingReminderVisible.value = false
      mutedSpeakingReminderTimer = null
    }, 3_000)
    sounds.signal('muted-speaking-reminder')
  }

  function clearMutedSpeakingReminder() {
    mutedSpeakingReminderVisible.value = false
    if (mutedSpeakingReminderTimer !== null) window.clearTimeout(mutedSpeakingReminderTimer)
    mutedSpeakingReminderTimer = null
  }

  function setMutedSpeakingReminderEnabled(value: boolean) {
    mutedSpeakingReminderEnabled.value = value
    saveBoolean(MUTED_SPEAKING_REMINDER_KEY, value)
  }

  function devicePreference(kind: 'input' | 'output'): VoiceDevicePreference {
    return kind === 'input'
      ? { deviceId: preferredInputId.value, label: preferredInputLabel.value }
      : { deviceId: preferredOutputId.value, label: preferredOutputLabel.value }
  }

  function deviceOptions(kind: 'input' | 'output') {
    return kind === 'input' ? inputDeviceOptions.value : outputDeviceOptions.value
  }

  function resolvedPreferredDeviceId(kind: 'input' | 'output') {
    const preference = devicePreference(kind)
    const available = deviceOptions(kind).some((option) => option.deviceId === preference.deviceId && !option.unavailable)
    return available ? preference.deviceId : DEFAULT_DEVICE_ID
  }

  async function initializeDevices() {
    if (!deviceListenersInstalled) {
      deviceListenersInstalled = true
      navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange)
    }
    if (!deviceInitializationPromise) deviceInitializationPromise = requestMicrophonePermission()
    return deviceInitializationPromise
  }

  function requestMicrophonePermission() {
    if (permissionRequestPromise) return permissionRequestPromise
    permissionRequestPromise = performMicrophonePermissionRequest().finally(() => {
      permissionRequestPromise = null
    })
    return permissionRequestPromise
  }

  async function performMicrophonePermissionRequest() {
    devicePermissionState.value = 'requesting'
    devicePermissionError.value = ''
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风访问')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      devicePermissionState.value = 'granted'
    } catch (error) {
      devicePermissionState.value = 'denied'
      devicePermissionError.value = error instanceof Error ? error.message : '麦克风权限请求失败'
    }
    await refreshDevices(false)
    return devicePermissionState.value === 'granted'
  }

  function handleDeviceChange() {
    void refreshDevices(false)
  }

  function createVoiceAudioContext() {
    const AudioContextConstructor = window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    return AudioContextConstructor ? new AudioContextConstructor({ latencyHint: 'interactive' }) : null
  }

  async function destroyVoiceAudioContext() {
    const controller = voiceAudioContextController
    if (!controller) return
    voiceAudioContextController = null
    await controller.destroy()
  }

  async function join(channelId: number) {
    if (room && connectedChannelId.value === channelId) return
    if (status.value === 'connecting') return
    if (room) await leave({ intent: 'active' })
    await destroyVoiceAudioContext()
    voiceSession += 1
    mutedSpeakingReminder.resetFailure()
    clearMutedSpeakingReminder()
    const session = voiceSession
    recentEndedSession = null
    const app = useAppStore()
    status.value = 'connecting'
    errorMessage.value = ''
    transmissionModeError.value = ''
    connectionReset()
    appliedTransmissionMode = null
    syncApplicationSoundPlayback()
    try {
      const channel = app.voiceChannels.find((item) => item.id === channelId)
      if (!channel) throw new Error('语音频道不存在')
      const guild = app.activeGuild
      if (!guild || app.activeGuildId !== guild.id) throw new Error('未选择服务器')
      const guildId = guild.id
      const guildName = guild.name
      guildMuted.value = app.user?.voiceMuted ?? false
      connectedChannelId.value = channelId
      connectedGuildId.value = guildId
      connectedGuildName.value = guildName
      connectedChannelName.value = channel.name
      setConnectedChannelSettings(channel)
      await initializeDevices()
      if (permissionRequestPromise) await permissionRequestPromise
      if (session !== voiceSession) return
      const tokenDeafened = deafenedPreference.value
      const credentials = await request<VoiceCredentials>(`/api/guilds/${guildId}/channels/${channelId}/voice/token`, {
        method: 'POST',
        body: JSON.stringify({ deafened: tokenDeafened }),
      })
      if (session !== voiceSession) return
      const audioContext = createVoiceAudioContext()
      const nextRoom = markRaw(new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: audioContext ? { audioContext } : true,
        audioCaptureDefaults: microphoneCaptureOptions(),
        publishDefaults: {
          audioPreset: { maxBitrate: (channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS) * 1000 },
          dtx: dtxEnabled.value,
          red: channel.audioRedEnabled ?? true,
          forceStereo: false,
        },
        audioOutput: outputDeviceSelectionSupported ? { deviceId: resolvedPreferredDeviceId('output') } : undefined,
      }))
      room = nextRoom
      if (audioContext) {
        voiceAudioContextController = new VoiceAudioContextController(audioContext, {
          startAudio: () => nextRoom.startAudio(),
          shouldResume: () => room === nextRoom && status.value === 'connected' && !deafened.value,
          interactionTarget: document,
          onError: (error) => console.warn('语音音频自动恢复失败', error),
        })
      }
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token, { autoSubscribe: true, maxRetries: 5 })
      if (session !== voiceSession || room !== nextRoom) return
      await refreshDevices(false)
      if (session !== voiceSession || room !== nextRoom) return
      await applyConnectionPreferences()
      if (session !== voiceSession || room !== nextRoom) return
      status.value = 'connected'
      voiceAudioContextController?.resumeIfNeeded()
      await refreshDevices(false)
      syncParticipants()
      participantSoundsReady = true
      sounds.signal('voice-self-joined')
      app.requestVoiceRoomsRefresh()
    } catch (error) {
      if (session !== voiceSession) return
      participantSoundsReady = false
      room?.disconnect()
      room = null
      await destroyVoiceAudioContext()
      clearConnectedChannelSummary()
      status.value = 'error'
      connectionReset()
      syncApplicationSoundPlayback()
      errorMessage.value = error instanceof Error ? error.message : '无法连接语音频道'
      throw error
    }
  }

  async function leave(options: LeaveOptions = {}) {
    const app = useAppStore()
    const targetRoom = room
    const guildId = connectedGuildId.value
    rememberEndedSession()
    mutedSpeakingReminder.stop()
    clearMutedSpeakingReminder()
    await appAudio.stopApplicationAudio()
    const wasJoined = targetRoom !== null && room === targetRoom
    voiceSession += 1
    participantSoundsReady = false
    if (wasJoined) {
      targetRoom.disconnect()
      room = null
    }
    await destroyVoiceAudioContext()
    clearConnectedChannelSummary()
    document.querySelectorAll('#voice-audio-root audio').forEach((element) => element.remove())
    participantStates.value = []
    status.value = 'idle'
    connectionReset()
    appliedTransmissionMode = null
    transmissionModeError.value = ''
    microphoneActivity.destroy()
    if (wasJoined && options.intent === 'active') sounds.signal('voice-self-left')
    syncApplicationSoundPlayback()
    if (wasJoined && guildId !== null && options.notifyGuild !== false) {
      await request(`/api/guilds/${guildId}/voice/leave`, { method: 'POST' })
      app.requestVoiceRoomsRefresh()
    }
  }

  async function switchInput(deviceId: string) {
    return switchDevice('input', deviceId)
  }

  async function switchOutput(deviceId: string) {
    return switchDevice('output', deviceId)
  }

  async function switchDevice(kind: 'input' | 'output', deviceId: string) {
    if (deviceChangingKind.value !== null) return false
    const option = deviceOptions(kind).find((item) => item.deviceId === deviceId)
    if (!option || option.unavailable) return false
    if (kind === 'output' && !outputDeviceSelectionSupported) {
      setPreferredDevice('output', { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' })
      return true
    }
    deviceChangeError.value = ''
    deviceChangeErrorKind.value = null
    const target = room
    if (!target || status.value === 'connecting') {
      setPreferredDevice(kind, option)
      return true
    }
    const session = voiceSession
    const mediaDeviceKind = kind === 'input' ? 'audioinput' : 'audiooutput'
    const previousDeviceId = kind === 'input'
      ? activeInputId.value || target.getActiveDevice(mediaDeviceKind) || DEFAULT_DEVICE_ID
      : activeOutputId.value || target.getActiveDevice(mediaDeviceKind) || DEFAULT_DEVICE_ID
    deviceChangingKind.value = kind
    deviceChangingId.value = deviceId
    try {
      const changed = await target.switchActiveDevice(mediaDeviceKind, deviceId, true)
      if (!changed) throw new Error('设备切换未生效')
      if (session !== voiceSession || room !== target) return false
      if (kind === 'input') activeInputId.value = deviceId
      else applyOutputDeviceSelection(deviceId)
      setPreferredDevice(kind, option)
      return true
    } catch (error) {
      if (session === voiceSession && room === target) {
        if (previousDeviceId !== deviceId) {
          await target.switchActiveDevice(mediaDeviceKind, previousDeviceId, true).catch(() => false)
        }
        if (session !== voiceSession || room !== target) return false
        if (kind === 'input') activeInputId.value = previousDeviceId
        else applyOutputDeviceSelection(previousDeviceId)
        deviceChangeError.value = error instanceof Error ? error.message : '设备切换失败'
        deviceChangeErrorKind.value = kind
      }
      return false
    } finally {
      if (deviceChangingKind.value === kind && deviceChangingId.value === deviceId) {
        deviceChangingKind.value = null
        deviceChangingId.value = ''
      }
    }
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
    if (transmissionModeChanging.value || deafenChanging.value || muteChanging.value) return
    const previous = transmissionMode.value
    const next: VoiceTransmissionMode = previous === 'voice-activity' ? 'continuous' : 'voice-activity'
    transmissionMode.value = next
    saveTransmissionMode(next)
    notifyPreferenceChange()
    transmissionModeError.value = ''

    if (!room || status.value !== 'connected' || muted.value || deafened.value || guildMuted.value) return
    const target = room
    const session = voiceSession
    transmissionModeChanging.value = true
    try {
      await republishMicrophone()
      if (session !== voiceSession || room !== target) return
      syncParticipants()
    } catch (error) {
      if (session !== voiceSession || room !== target) return
      transmissionMode.value = previous
      saveTransmissionMode(previous)
      notifyPreferenceChange()
      try {
        await republishMicrophone()
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
    if (microphoneChanged && !muted.value && !guildMuted.value) {
      await republishMicrophone()
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

  async function refreshDevices(requestPermissions = false) {
    if (requestPermissions) {
      await requestMicrophonePermission()
      return
    }
    if (deviceRefreshPromise) return deviceRefreshPromise
    deviceRefreshPromise = (async () => {
      const [inputResult, outputResult] = await Promise.allSettled([
        Room.getLocalDevices('audioinput', false),
        Room.getLocalDevices('audiooutput', false),
      ])
      inputDevices.value = inputResult.status === 'fulfilled' ? inputResult.value : []
      outputDevices.value = outputResult.status === 'fulfilled' ? outputResult.value : []
      const target = room
      if (!target) {
        syncApplicationSoundPlayback()
        return
      }
      const nextInput = target.getActiveDevice('audioinput') ?? activeInputId.value
      const nextOutput = target.getActiveDevice('audiooutput') ?? activeOutputId.value
      activeInputId.value = nextInput || DEFAULT_DEVICE_ID
      activeOutputId.value = nextOutput || DEFAULT_DEVICE_ID
      await fallbackMissingActiveDevice(target, 'input')
      await fallbackMissingActiveDevice(target, 'output')
    })().finally(() => {
      deviceRefreshPromise = null
    })
    return deviceRefreshPromise
  }

  async function fallbackMissingActiveDevice(target: Room, kind: 'input' | 'output') {
    if (room !== target) return
    if (kind === 'output' && !outputDeviceSelectionSupported) {
      activeOutputId.value = DEFAULT_DEVICE_ID
      return
    }
    const activeId = kind === 'input' ? activeInputId.value : activeOutputId.value
    if (!activeId || activeId === DEFAULT_DEVICE_ID) return
    const available = (kind === 'input' ? inputDevices.value : outputDevices.value).some((device) => device.deviceId === activeId)
    if (available) return
    try {
      await target.switchActiveDevice(kind === 'input' ? 'audioinput' : 'audiooutput', DEFAULT_DEVICE_ID, true)
      if (room !== target) return
      if (kind === 'input') activeInputId.value = DEFAULT_DEVICE_ID
      else applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
    } catch {
      // The browser or LiveKit keeps its own fallback when an explicit switch is unavailable.
    }
  }

  async function applyPreferredDevicesToRoom(target: Room, session: number) {
    const inputId = resolvedPreferredDeviceId('input')
    try {
      const changed = await target.switchActiveDevice('audioinput', inputId, true)
      if (session === voiceSession && room === target && changed) activeInputId.value = inputId
    } catch {
      if (inputId !== DEFAULT_DEVICE_ID) {
        await target.switchActiveDevice('audioinput', DEFAULT_DEVICE_ID, true).catch(() => false)
      }
      if (session === voiceSession && room === target) activeInputId.value = DEFAULT_DEVICE_ID
    }
    if (session !== voiceSession || room !== target) return
    if (!outputDeviceSelectionSupported) {
      applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
      return
    }
    const outputId = resolvedPreferredDeviceId('output')
    try {
      const changed = await target.switchActiveDevice('audiooutput', outputId, true)
      if (session === voiceSession && room === target && changed) applyOutputDeviceSelection(outputId)
    } catch {
      if (outputId !== DEFAULT_DEVICE_ID) {
        await target.switchActiveDevice('audiooutput', DEFAULT_DEVICE_ID, true).catch(() => false)
      }
      if (session === voiceSession && room === target) applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
    }
  }

  function applyOutputDeviceSelection(deviceId: string) {
    activeOutputId.value = deviceId
    syncApplicationSoundPlayback()
    document.querySelectorAll<HTMLAudioElement>('#voice-audio-root audio').forEach((element) => {
      void setAudioSink(element, deviceId)
    })
  }

  function syncApplicationSoundPlayback() {
    sounds.followPlayback({
      deafened: deafened.value,
      outputDeviceId: room !== null && status.value !== 'connecting'
        ? activeOutputId.value
        : resolvedPreferredDeviceId('output'),
    })
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
        voiceAudioContextController?.resumeIfNeeded()
        void transportRecovered().then(() => {
          if (room !== target) return
          syncParticipants()
          participantSoundsReady = true
          useAppStore().requestVoiceRoomsRefresh()
        })
      })
      .on(RoomEvent.Disconnected, () => {
        if (room === target) {
          void appAudio.stopApplicationAudio()
          voiceSession += 1
          participantSoundsReady = false
          rememberEndedSession()
          room = null
          clearConnectedChannelSummary()
          status.value = 'idle'
          participantStates.value = []
          connectionReset()
          appliedTransmissionMode = null
          microphoneActivity.destroy()
          void destroyVoiceAudioContext()
          syncApplicationSoundPlayback()
          useAppStore().requestVoiceRoomsRefresh()
        }
      })
  }

  function handleParticipantChange(target: Room, sound: 'join' | 'leave') {
    if (room !== target) return
    syncParticipants()
    useAppStore().requestVoiceRoomsRefresh()
    if (participantSoundsReady && status.value === 'connected') {
      sounds.signal(sound === 'join' ? 'voice-participant-joined' : 'voice-participant-left')
    }
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
    connectedGuildId.value = null
    connectedGuildName.value = ''
    connectedChannelName.value = ''
    connectedPublishSettings.value = defaultConnectedPublishSettings()
  }

  function rememberEndedSession() {
    if (connectedGuildId.value === null || connectedChannelId.value === null) return
    recentEndedSession = {
      guildId: connectedGuildId.value,
      channelId: connectedChannelId.value,
      deafened: deafened.value,
      endedAt: Date.now(),
    }
  }

  function handleModeratorDisconnect(guildId: number, channelId: number) {
    const matchesCurrent = connectedGuildId.value === guildId && connectedChannelId.value === channelId
    const matchesRecent = recentEndedSession?.guildId === guildId
      && recentEndedSession.channelId === channelId
      && Date.now() - recentEndedSession.endedAt <= MODERATOR_DISCONNECT_MATCH_WINDOW_MS
    if (!matchesCurrent && !matchesRecent) return false

    const wasDeafened = matchesCurrent ? deafened.value : recentEndedSession?.deafened === true
    recentEndedSession = null
    if (!wasDeafened) sounds.signal('voice-moderator-disconnected')
    return true
  }

  function publishOptions(mode: VoiceTransmissionMode = transmissionMode.value) {
    const settings = connectedPublishSettings.value
    return {
      audioPreset: { maxBitrate: settings.audioBitrateKbps * 1000 },
      dtx: mode === 'voice-activity',
      red: settings.audioRedEnabled,
      forceStereo: false,
    }
  }

  function microphoneCaptureOptions() {
    return buildMicrophoneCaptureOptions({
      deviceId: resolvedPreferredDeviceId('input'),
      echoCancellation: echoCancellation.value,
      noiseSuppression: noiseSuppression.value,
    })
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

  async function enableMicrophone(enabled: boolean) {
    const target = room
    if (!target) return
    if (target.localParticipant.isMicrophoneEnabled === enabled) return
    const mode = transmissionMode.value
    await target.localParticipant.setMicrophoneEnabled(
      enabled,
      enabled ? microphoneCaptureOptions() : undefined,
      enabled ? publishOptions(mode) : undefined,
    )
    if (enabled && room === target) appliedTransmissionMode = mode
  }

  async function attachMicrophoneGain() {
    const target = room
    if (!target) return
    const track = target.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (track && track.getProcessor() !== microphoneGainProcessor) {
      await track.setProcessor(microphoneGainProcessor)
    }
  }

  async function republishMicrophone() {
    const target = room
    if (!target) return
    const nextTransmissionMode = transmissionMode.value
    await target.localParticipant.setMicrophoneEnabled(false)
    await target.localParticipant.setMicrophoneEnabled(true, microphoneCaptureOptions(), publishOptions(nextTransmissionMode))
    if (room === target) appliedTransmissionMode = nextTransmissionMode
    await attachMicrophoneGain()
  }

  return {
    status,
    connectedChannelId,
    connectedGuildId,
    connectedGuildName,
    connectedChannelName,
    connectedAudioBitrateKbps,
    errorMessage,
    deafenedSyncError,
    voicePreferenceFeedback,
    muted,
    deafened,
    microphoneEnabledPreference,
    deafenedPreference,
    muteChanging,
    deafenChanging,
    guildMuted,
    participants,
    inputDevices,
    outputDevices,
    activeInputId,
    activeOutputId,
    preferredInputId,
    preferredOutputId,
    inputDeviceOptions,
    outputDeviceOptions,
    outputDeviceSelectionSupported,
    devicePermissionState,
    devicePermissionError,
    deviceChangeError,
    deviceChangeErrorKind,
    deviceChangingKind,
    deviceChangingId,
    microphoneGain,
    outputVolume,
    echoCancellation,
    noiseSuppression,
    mutedSpeakingReminderEnabled,
    mutedSpeakingReminderVisible,
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
    toggleMute: userToggledMute,
    toggleDeafen: userToggledDeafen,
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
    setMutedSpeakingReminderEnabled,
    toggleTransmissionMode,
    initializeApplicationAudio: appAudio.initializeApplicationAudio,
    startApplicationAudio: appAudio.startApplicationAudio,
    pauseApplicationAudio: appAudio.pauseApplicationAudio,
    resumeApplicationAudio: appAudio.resumeApplicationAudio,
    stopApplicationAudio: appAudio.stopApplicationAudio,
    setApplicationAudioVolume: appAudio.setApplicationAudioVolume,
    applyPublishSettingsChange,
    updateConnectedChannelSettings,
    syncGuildMute: guildMuteChanged,
    handleModeratorDisconnect,
    refreshDevices,
    initializeDevices,
    requestMicrophonePermission,
  }
})
