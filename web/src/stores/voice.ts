import { markRaw, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { Room, supportsAudioOutputSelection } from 'livekit-client'
import { ApiError, request } from '../api.ts'
import type { VoiceCredentials } from '../types.ts'
import { useAppStore, setCallSignalHandler } from './app.ts'
import { useApplicationSoundStore } from './application-sounds.ts'
import { SpeechDetectionEngine } from '../audio/SpeechDetectionEngine.ts'
import { SpeechDetectionLifecycle } from '../audio/SpeechDetectionLifecycle.ts'
import { preloadRnnoiseWasm } from '../audio/rnnoise.ts'
import { useVoiceDevices, type VoiceLiveConnection } from './voice-devices.ts'
import { getSavedAutoVoiceBalance, saveAutoVoiceBalance } from './voice-auto-balance-state.ts'
import { useParticipantVolume } from './voice-participant-volume.ts'
import { useApplicationAudio } from './voice-application-audio.ts'
import { useVoiceMuteDeafenModule } from './voice-mute-deafen.ts'
import { useVoicePresence } from './voice-presence.ts'
import { useVoiceSession } from './voice-session.ts'
import { useVoiceCall } from './voice-call.ts'
import { callTerminalMessage, callTerminalSide, parseCallSignal, type CallPeer } from './call-signal.ts'
import { useCallPermissionsStore } from './call-permissions.ts'
import { useVoiceOverlay } from './voice-overlay.ts'
import { useToastStore } from './toast.ts'
import {
  DEAFENED_PREFERENCE_KEY,
  ECHO_CANCELLATION_KEY,
  MICROPHONE_ENABLED_KEY,
  MICROPHONE_GAIN_KEY,
  OUTPUT_VOLUME_KEY,
  clampVolume,
  getSavedBoolean,
  getSavedLevel,
  getSavedNoiseSuppressionOption,
  getSavedLastNoiseSuppressionOption,
  parseNoiseSuppressionOption,
  resolveNoiseSuppression,
  saveBoolean,
  saveNoiseSuppressionOption,
  saveLastNoiseSuppressionOption,
  setAudioSink,
  toggleNoiseSuppressionOption,
  type NoiseSuppressionOption,
  type VoiceParticipant,
  type VoiceTransmissionMode,
} from './voice-utils.ts'

function createInteractiveAudioContext(): AudioContext | null {
  const AudioContextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return null
  try {
    return new AudioContextConstructor({ latencyHint: 'interactive', sampleRate: 48_000 })
  } catch {
    // Some browsers reject an explicit rate; retain the WebRTC fallback
    // path with their default context instead of failing voice join.
    try {
      return new AudioContextConstructor({ latencyHint: 'interactive' })
    } catch {
      return null
    }
  }
}

export type { VoiceParticipant, VoiceTransmissionMode } from './voice-utils.ts'

export const useVoiceStore = defineStore('voice', () => {
  // 与连接无关的纯偏好（会话模块经 ctx 单向读取）。
  const microphoneGain = ref(getSavedLevel(MICROPHONE_GAIN_KEY))
  const outputVolume = ref(getSavedLevel(OUTPUT_VOLUME_KEY))
  const echoCancellation = ref(getSavedBoolean(ECHO_CANCELLATION_KEY, true))
  const noiseSuppressionOption = ref(getSavedNoiseSuppressionOption())
  // 自动音量平衡（ADR-0026）：全局开关，仅本机，默认关闭。
  const autoVoiceBalance = ref(getSavedAutoVoiceBalance(localStorage))
  // RNNoise 在每次采集时都尝试加载。预取只是优化路径，失败不能把后续会话
  // 永久锁死为系统降噪；节点创建失败由当前会话回退并在下一会话重试。
  const rnnoiseBinaryPromise = preloadRnnoiseWasm()
  void rnnoiseBinaryPromise
  // 语音音频上下文引用：约束合成需要知道实际采样率（RNNoise 仅支持 48kHz）。
  const voiceContextRef: { current: AudioContext | null } = { current: null }

  // 跨模块组合的延迟解析位：session 模块的 ctx 需要 mute/deafen、设备、应用音频
  // 模块的输出，而这些模块的 ctx 又需要 session 的输出，创建顺序由本层化解。
  const muteDeafenRef: { current: ReturnType<typeof useVoiceMuteDeafenModule> | null } = { current: null }
  const devicesRef: { current: ReturnType<typeof useVoiceDevices> | null } = { current: null }
  const appAudioRef: { current: ReturnType<typeof useApplicationAudio> | null } = { current: null }
  const participantVolumeRef: { current: ReturnType<typeof useParticipantVolume> | null } = { current: null }
  const callRef: { current: ReturnType<typeof useVoiceCall> | null } = { current: null }

  const sounds = useApplicationSoundStore()
  const toast = useToastStore()

  // 共享说话检测引擎：静音说话提醒与在线状态检测共用一条采集流与一个 VAD
  // worker（ADR-0024）。引擎生命周期由应用级驱动（登录 + 麦克风授权），
  // 见 detectionLifecycle，消费方只订阅不参与启停。
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
    channelDeafened: () => muteDeafenRef.current?.channelDeafened.value ?? false,
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
    autoVoiceBalanceEnabled: () => autoVoiceBalance.value,
    updateVoiceBalanceMarker: (userId, gainDb) => {
      const element = document.querySelector<HTMLElement>(`#voice-audio-root audio[data-user-id="${userId}"]`)
      if (!element) return
      if (gainDb === null) delete element.dataset.voiceBalanceGain
      else element.dataset.voiceBalanceGain = gainDb.toFixed(1)
    },
    signal: (occurrence) => sounds.signal(occurrence),
    followPlayback: (options) => sounds.followPlayback(options),
    mutedSpeakingReminderAudible: () => sounds.mutedSpeakingReminderAudible,
    microphoneGainInitial: () => microphoneGain.value,
    echoCancellation: () => echoCancellation.value,
    noiseSuppression: () => {
      const context = voiceContextRef.current
      return resolveNoiseSuppression(
        noiseSuppressionOption.value,
        context !== null && context.state !== 'closed' && context.sampleRate === 48_000,
      )
    },
    noiseSuppressionOption: () => noiseSuppressionOption.value,
    loadRnnoiseBinary: () => preloadRnnoiseWasm(),
    fetchVoiceToken: (guildId, channelId, deafened) => request<VoiceCredentials>(`/api/guilds/${guildId}/channels/${channelId}/voice/token`, {
      method: 'POST',
      body: JSON.stringify({ deafened }),
    }),
    postVoiceLeave: (guildId) => request<void>(`/api/guilds/${guildId}/voice/leave`, { method: 'POST' }),
    createRoom: (options) => markRaw(new Room(options)),
    createAudioContext: () => {
      const context = createInteractiveAudioContext()
      voiceContextRef.current = context
      return context
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
    saveMicrophonePreference: (enabled) => saveBoolean(MICROPHONE_ENABLED_KEY, enabled),
    saveDeafenedPreference: (value) => saveBoolean(DEAFENED_PREFERENCE_KEY, value),
    syncApplicationSoundPlayback: session.syncApplicationSoundPlayback,
    pauseApplicationAudio: async (cancelResume?: boolean) => { await appAudioRef.current?.pauseApplicationAudio(cancelResume) },
    resumeApplicationAudio: async (cancelResume?: boolean) => { await appAudioRef.current?.resumeApplicationAudio(cancelResume) },
    stopApplicationAudio: async () => { await appAudioRef.current?.stopApplicationAudio() },
    applicationAudioIsPlaying: () => { const state = appAudioRef.current?.applicationAudioState.value; return state === 'playing' },
    applicationAudioIsAutoPaused: () => { const state = appAudioRef.current?.applicationAudioState.value; return (appAudioRef.current?.isAutoPaused() ?? false) && state === 'paused' },
    applyMicrophoneState: session.applyMicrophoneState,
    startAudio: session.startAudioIfNeeded,
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
    liveConnections: () => {
      const connections: VoiceLiveConnection[] = []
      const channelRoom = session.room()
      if (channelRoom) {
        connections.push({
          room: channelRoom,
          session: session.voiceSession(),
          ready: session.statusValue() !== 'connecting',
        })
      }
      const call = callRef.current
      if (call && call.connectedAt.value != null) {
        const callRoom = call.room()
        if (callRoom) {
          connections.push({
            room: callRoom,
            session: call.callSession(),
            ready: true,
          })
        }
      }
      return connections
    },
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
      document.querySelectorAll<HTMLAudioElement>('#voice-audio-root audio, #call-audio-root audio').forEach((element) => {
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
    voiceBalanceGain: (userId) => session.voiceBalanceGain(userId),
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

  // 1:1 临时语音通话会话（spec 04/05）：与 channel 语音会话并列，各自持有一条
  // LiveKit Room；ctx 复用本层已化解的 device/mute-deafen 输出（延迟解析位）。
  const call = useVoiceCall({
    currentUser: () => {
      const user = useAppStore().user
      return user ? { id: user.id } : null
    },
    createRoom: (options) => markRaw(new Room(options)),
    startCallRequest: (calleeUserId) => request<{ callId: string; state: string; reason?: string }>('/api/calls', {
      method: 'POST',
      body: JSON.stringify({ calleeUserId }),
    }),
    acceptRequest: (callId) => request<void>(`/api/calls/${callId}/accept`, { method: 'POST' }),
    rejectRequest: (callId) => request<void>(`/api/calls/${callId}/reject`, { method: 'POST' }),
    setTemporaryBlockRequest: (targetUserId) => (
      useCallPermissionsStore().setBlockForCall(targetUserId, 'temporary').then(() => undefined)
    ),
    cancelRequest: (callId) => request<void>(`/api/calls/${callId}/cancel`, { method: 'POST' }),
    hangupRequest: (callId) => request<void>(`/api/calls/${callId}/hangup`, { method: 'POST' }),
    fetchCallToken: (callId) => request<VoiceCredentials>(`/api/calls/${callId}/token`, { method: 'POST' }),
    resolvedPreferredInputDeviceId: () => devicesRef.current?.resolvedPreferredDeviceId('input') ?? '',
    resolvedPreferredOutputDeviceId: () => devicesRef.current?.resolvedPreferredDeviceId('output') ?? '',
    echoCancellation: () => echoCancellation.value,
    microphoneGainInitial: () => microphoneGain.value,
    transmissionMode: () => session.transmissionMode.value,
    noiseSuppressionOption: () => noiseSuppressionOption.value,
    loadRnnoiseBinary: () => preloadRnnoiseWasm(),
    createAudioContext: createInteractiveAudioContext,
    audioInteractionTarget: () => document,
    microphoneEnabledPreference: () => muteDeafenRef.current?.microphoneEnabledPreference.value ?? false,
    toggleMicrophonePreference: () => muteDeafenRef.current ? muteDeafenRef.current.userToggledMute() : Promise.resolve(),
    deafenedPreference: () => muteDeafenRef.current?.deafenedPreference.value ?? false,
    // 通话远端音频挂载到独立的 #call-audio-root，而不是频道语音的
    // #voice-audio-root；这样频道 leave/join 清理频道音频元素时不会误删通话音频。
    appendAudioElement: (element) => void document.querySelector('#call-audio-root')?.appendChild(element),
    removeAudioElements: () => void document.querySelectorAll('#call-audio-root audio').forEach((element) => element.remove()),
    setRemoteAudioMuted: (muted) => void document.querySelectorAll<HTMLAudioElement>('#call-audio-root audio').forEach((element) => {
      element.muted = muted
    }),
    applyAudioSink: (element, deviceId) => void setAudioSink(element, deviceId),
  })
  callRef.current = call

  // 频道作用域耳机静音接线（ticket 04 / ADR-0032）：发起通话（outgoing）与
  // 接听进入通话（active）时自动静音频道；来电振铃（ringing）期间频道保持原样；
  // 任何方式回到 idle（挂断/拒接/取消/超时等）自动解除并恢复通话前偏好。
  // 语义判定放在接线层，不写进 call 会话（保持 voice-call 对「频道」无感知）。
  watch(() => call.status.value, (status) => {
    void muteDeafen.setCallChannelDeafen(status === 'outgoing' || status === 'active')
  })

  // 通话提示音接线（ticket 05 / spec 09）：呼出中循环回铃、来电循环振铃；进入
  // active（接听/接通）停止循环并播放接通音；离开 active 或任何回到 idle 的终态
  // 停止循环并播放结束音（busy/unreachable 等即时终态虽也回到 idle，会先经
  // outgoing → idle 触发结束音）。
  watch(() => call.status.value, (status, previous) => {
    if (status === 'outgoing') {
      sounds.loop('call-outgoing')
    } else if (status === 'ringing') {
      sounds.loop('call-incoming')
    } else if (status === 'active') {
      sounds.stopLoop()
      sounds.signal('call-connected')
    } else {
      sounds.stopLoop()
      if (previous === 'active') sounds.signal('call-ended')
    }
  })

  // 终态文案接线（ticket 06 / spec 04 转移表）：任何回到 idle 的终态读一次
  // endedReason，按侧别映射文案并提示一次。侧别由前一状态判定（outgoing=主叫、
  // ringing=被叫）；active→idle 不携带侧别（null），掉线 reason=disconnected
  // 文案不分侧别，其余侧别敏感原因在 null 侧别下静默。自己主动取消（canceled，
  // 主叫）与主动挂断（ended）无提示——callTerminalMessage 返回 null 即静默跳过。
  // endedReason 在下一通发起时清空，且 Vue watch 仅在值实际变化时触发，一次终态
  // 转移恰好触发一次，无重复提示。
  watch(() => call.status.value, (status, previous) => {
    if (status !== 'idle') return
    const reason = call.endedReason.value
    if (!reason) return
    const terminal = callTerminalMessage(reason, callTerminalSide(previous))
    if (terminal) toast.show(terminal.message, terminal.type)
  })

  // 把 WS 点到点 call_* 事件路由给通话会话。app.ts 在 handleEvent 里按
  // call_ 前缀统一转发到这里注册的 handler（模块级，避免 app ↔ voice 循环依赖）。
  // raw payload 的解析与归一由 call-signal module 完成（ADR-0033）：解析失败
  // （未知 type / 空 callId）即忽略事件。
  setCallSignalHandler((type, data) => {
    const signal = parseCallSignal(type, data)
    if (signal) call.handleSignal(signal)
  })

  // 常开说话检测引擎的应用级生命周期（ADR-0024）：登录且麦克风授权时启动，
  // 退出登录或权限丢失时停止，首选输入设备变化时重启采集；失败后在标签页
  // 恢复可见、设备变化或权限重新授予时自动重试。
  const detectionLifecycle = new SpeechDetectionLifecycle({
    engine: speechDetection,
    isActive: () => useAppStore().user !== null
      && (devicesRef.current?.devicePermissionState.value ?? 'idle') === 'granted',
    preferredInputDeviceId: () => devicesRef.current?.resolvedPreferredDeviceId('input') ?? '',
    subscribeRetryEvents: (listener) => {
      window.addEventListener('visibilitychange', listener)
      navigator.mediaDevices?.addEventListener('devicechange', listener)
      return () => {
        window.removeEventListener('visibilitychange', listener)
        navigator.mediaDevices?.removeEventListener('devicechange', listener)
      }
    },
  })
  watch(() => detectionLifecycle.state(), () => detectionLifecycle.sync(), { flush: 'sync' })

  const presence = useVoicePresence({
    createSpeechDetectionEngine: () => speechDetection,
    devicePermissionState: () => devicesRef.current?.devicePermissionState.value ?? 'idle',
    microphoneMuted: () => muteDeafenRef.current?.muted.value ?? false,
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
    call.applyMicrophoneGain(normalized)
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

  function setNoiseSuppressionOption(value: NoiseSuppressionOption | string) {
    const option = parseNoiseSuppressionOption(value)
    noiseSuppressionOption.value = option
    saveNoiseSuppressionOption(option)
    if (option !== 'off') saveLastNoiseSuppressionOption(option)
    session.applyNoiseSuppressionOption(option)
    call.applyNoiseSuppressionOption(option)
  }

  // 降噪快控左键：非关闭与关闭之间切换，关闭时恢复上次使用的非关闭方法。
  function toggleNoiseSuppression() {
    setNoiseSuppressionOption(toggleNoiseSuppressionOption(noiseSuppressionOption.value, getSavedLastNoiseSuppressionOption()))
  }

  // 自动音量平衡开关：即时生效——开则对在场参与者逐个挂 analyser 并从 0dB
  // 起步，关则摘除插件、增益复位（applyAllVolumes 回到纯手动合成）。
  function setAutoVoiceBalance(value: boolean) {
    autoVoiceBalance.value = value
    saveAutoVoiceBalance(localStorage, value)
    session.syncParticipants()
    participantVolume.applyAllVolumes()
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
    noiseSuppressionOption,
    autoVoiceBalance,
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
    setNoiseSuppressionOption,
    toggleNoiseSuppression,
    setAutoVoiceBalance,
    setMutedSpeakingReminderEnabled: session.setMutedSpeakingReminderEnabled,
    toggleTransmissionMode: async () => {
      await session.toggleTransmissionMode()
      call.applyTransmissionMode()
    },
    initializeApplicationAudio: appAudio.initializeApplicationAudio,
    overlaySupported: overlay.supported,
    overlayEnabled: overlay.enabled,
    overlayShortcutEnabled: overlay.shortcutEnabled,
    setOverlayEnabled: overlay.setOverlayEnabled,
    setOverlayShortcutEnabled: overlay.setOverlayShortcutEnabled,
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
    // 语音通话会话公开面（通话浮层/个人信息卡片入口消费）。
    callStatus: call.status,
    // 频道作用域耳机静音叠加态（通话期间为 true）：频道信息区显示临时态用。
    callChannelDeafened: muteDeafen.channelDeafened,
    callReconnecting: call.reconnecting,
    callPeer: call.peer,
    callMicrophoneMuted: call.microphoneMuted,
    callOverlayOpen: call.overlayOpen,
    callConnectedAt: call.connectedAt,
    // 发起通话的接线：后端仲裁拒绝（如主叫已有通话 409 call_in_progress）时
    // 提示服务端消息；会话内部已自行回退 idle，这里只负责把拒绝呈现给用户。
    startCall: (target: CallPeer) => call.startCall(target).catch((error) => {
      if (error instanceof ApiError) toast.showWarning(error.message)
    }),
    acceptCall: call.accept,
    rejectCall: call.reject,
    rejectAndBlockTemporarily: () => call.rejectAndBlockTemporarily().catch((error) => {
      toast.showWarning(error instanceof Error ? error.message : '已屏蔽对方，但通话结束失败，请重试')
    }),
    cancelCall: call.cancel,
    hangupCall: call.hangup,
    toggleCallMicrophoneMute: call.toggleMicrophoneMute,
  }
})
