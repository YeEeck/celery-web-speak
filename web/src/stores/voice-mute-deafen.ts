import { ref, watch, type Ref } from 'vue'
import { type Room } from 'livekit-client'
import type { MicrophonePublishState } from '../audio/MicrophonePublishOrchestrator.ts'
import {
  DEAFENED_PREFERENCE_KEY,
  MICROPHONE_ENABLED_KEY,
  getSavedBoolean,
  saveBoolean,
  type VoiceTransmissionMode,
} from './voice-utils.ts'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface MuteDeafenContext {
  // Race-guard getters（race idiom 在 module 内部消费）
  room: () => Room | null
  voiceSession: () => number

  // 状态/连接身份读出
  status: () => VoiceStatus
  connectedChannelId: () => number | null
  connectedGuildId: () => number | null

  // 外部 reactive 输入（替代 AppShell 的两个 watcher）
  guildMuteValue: () => boolean | undefined
  socketStatus: () => string

  // 传输模式与应用模式 interplay：module 只读，不写
  transmissionMode: () => VoiceTransmissionMode

  // 偏好持久化 adapter
  saveMicrophonePreference: (enabled: boolean) => void
  saveDeafenedPreference: (value: boolean) => void

  // 应用提示音 follow adapter
  syncApplicationSoundPlayback: () => void

  // 应用音频生命周期 adapter
  pauseApplicationAudio: (cancelResume?: boolean) => Promise<void>
  resumeApplicationAudio: (cancelResume?: boolean) => Promise<void>
  stopApplicationAudio: () => Promise<void>
  applicationAudioIsPlaying: () => boolean
  applicationAudioIsAutoPaused: () => boolean

  // 麦克风发布入口（幂等：编排器按目标与当前状态决定实际切换序列）
  applyMicrophoneState: (state: MicrophonePublishState) => Promise<void>

  // 音频路由/上下文
  startAudio: () => Promise<void>
  resumeAudioContext: () => void

  // 参与者合成/音量
  syncParticipants: () => void
  applyAllVolumes: () => void

  // 加入期设备选择 adapter（设备 module 拥有，加入流程在 module 内调用）
  applyPreferredDevices: () => Promise<void>

  // 错误通道 writer
  setErrorMessage: (msg: string) => void

  // 耳机静音后端同步 adapter
  syncDeafenedToBackend: (guildId: number, channelId: number, deafened: boolean) => Promise<void>
}

export interface VoiceMuteDeafenModule {
  // reactive state — forwarded 到 voice store
  readonly muted: Ref<boolean>
  readonly deafened: Ref<boolean>
  readonly guildMuted: Ref<boolean>
  readonly microphoneEnabledPreference: Ref<boolean>
  readonly deafenedPreference: Ref<boolean>
  readonly muteChanging: Ref<boolean>
  readonly deafenChanging: Ref<boolean>
  readonly voicePreferenceFeedback: Ref<string>
  readonly deafenedSyncError: Ref<string>
  // 频道作用域耳机静音（通话叠加）：只静频道、不写全局偏好（ADR-0032）。
  readonly channelDeafened: Ref<boolean>

  // 6 个领域入口
  userToggledMute: () => Promise<void>
  userToggledDeafen: () => Promise<void>
  guildMuteChanged: (value: boolean) => Promise<void>
  transportRecovered: () => Promise<void>
  connectionReset: () => void
  applyConnectionPreferences: () => Promise<void>

  // 外部偏好变化通知（让 module 的 reconcile 循环感知）
  notifyPreferenceChange: () => void

  // 频道作用域耳机静音施加/解除（voice.ts 在通话状态变化时调用；传入是否处于通话）。
  setCallChannelDeafen: (active: boolean) => Promise<void>
}

const PREFERENCE_FEEDBACK_DURATION_MS = 2_400

export function useVoiceMuteDeafenModule(ctx: MuteDeafenContext): VoiceMuteDeafenModule {
  const microphoneEnabledPreference = ref(getSavedBoolean(MICROPHONE_ENABLED_KEY, true))
  const deafenedPreference = ref(getSavedBoolean(DEAFENED_PREFERENCE_KEY, false))
  const muted = ref(!microphoneEnabledPreference.value || deafenedPreference.value)
  const deafened = ref(deafenedPreference.value)
  const muteChanging = ref(false)
  const deafenChanging = ref(false)
  const guildMuted = ref(false)
  const voicePreferenceFeedback = ref('')
  const deafenedSyncError = ref('')
  // 频道作用域耳机静音叠加态（通话期间施加）：独立于全局 deafenedPreference，
  // 只静频道（停发频道麦克风、停播频道回放），不静通话；挂断后解除并恢复通话前偏好。
  const channelDeafened = ref(false)

  let pendingDeafenedSync: boolean | null = null
  let deafenedSyncSession: number | null = null
  let deafenedSyncPromise: Promise<void> | null = null
  let preferenceRevision = 0
  let preferenceFeedbackTimer: number | null = null

  // 取代 AppShell 的 `app.user?.voiceMuted → voice.syncGuildMute` watcher。
  watch(() => ctx.guildMuteValue(), (value) => {
    if (value !== undefined) void guildMuteChanged(value)
  })

  // 取代 AppShell 的 `app.socketStatus === 'online' → voice.retryDeafenedSync` watcher。
  watch(() => ctx.socketStatus(), (value) => {
    if (value === 'online') retryDeafenedSync()
  })

  function setMicrophonePreference(enabled: boolean) {
    microphoneEnabledPreference.value = enabled
    ctx.saveMicrophonePreference(enabled)
    preferenceRevision += 1
  }

  function setDeafenedPreference(value: boolean) {
    deafenedPreference.value = value
    ctx.saveDeafenedPreference(value)
    preferenceRevision += 1
  }

  function notifyPreferenceChange() {
    preferenceRevision += 1
  }

  function showVoicePreferenceFeedback(message: string) {
    voicePreferenceFeedback.value = message
    if (preferenceFeedbackTimer !== null) window.clearTimeout(preferenceFeedbackTimer)
    preferenceFeedbackTimer = window.setTimeout(() => {
      voicePreferenceFeedback.value = ''
      preferenceFeedbackTimer = null
    }, PREFERENCE_FEEDBACK_DURATION_MS)
  }

  // 有效耳机静音：全局偏好或频道作用域叠加任一命中即静音频道。
  function effectiveDeafened() {
    return deafenedPreference.value || channelDeafened.value
  }

  function syncIdlePreferenceState() {
    if (ctx.room()) return
    deafened.value = effectiveDeafened()
    muted.value = effectiveDeafened() || !microphoneEnabledPreference.value
  }

  async function userToggledMute() {
    if (muteChanging.value || deafenChanging.value) return
    const previousMicrophone = microphoneEnabledPreference.value
    const previousDeafened = deafenedPreference.value
    if (deafenedPreference.value) {
      setDeafenedPreference(false)
      setMicrophonePreference(true)
    } else {
      setMicrophonePreference(!microphoneEnabledPreference.value)
    }
    const target = ctx.room()
    if (!target || ctx.status() === 'connecting') {
      deafened.value = deafenedPreference.value
      muted.value = deafenedPreference.value || !microphoneEnabledPreference.value
      ctx.syncApplicationSoundPlayback()
      return
    }
    const session = ctx.voiceSession()
    muteChanging.value = true
    ctx.setErrorMessage('')
    try {
      await reconcileConnectedPreferences(target, session)
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      ctx.syncParticipants()
      if (guildMuted.value) {
        showVoicePreferenceFeedback(microphoneEnabledPreference.value
          ? '管理员禁言；解除后将开启麦克风'
          : '管理员禁言；解除后将保持静音')
      }
    } catch (error) {
      setMicrophonePreference(previousMicrophone)
      setDeafenedPreference(previousDeafened)
      await reconcileConnectedPreferences(target, session).catch(() => undefined)
      if (session === ctx.voiceSession() && ctx.room() === target) {
        ctx.setErrorMessage(error instanceof Error ? error.message : '无法切换麦克风状态')
      }
    } finally {
      muteChanging.value = false
    }
  }

  async function userToggledDeafen() {
    if (muteChanging.value || deafenChanging.value) return
    const previousDeafenedPreference = deafenedPreference.value
    setDeafenedPreference(!deafenedPreference.value)
    const target = ctx.room()
    if (!target || ctx.status() === 'connecting') {
      deafened.value = deafenedPreference.value
      muted.value = deafenedPreference.value || !microphoneEnabledPreference.value
      ctx.syncApplicationSoundPlayback()
      return
    }
    const session = ctx.voiceSession()
    deafenChanging.value = true
    ctx.setErrorMessage('')
    try {
      await reconcileConnectedPreferences(target, session)
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      ctx.syncParticipants()
    } catch (error) {
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      setDeafenedPreference(previousDeafenedPreference)
      await reconcileConnectedPreferences(target, session).catch(() => undefined)
      ctx.setErrorMessage(error instanceof Error ? error.message : '无法切换耳机静音状态')
    } finally {
      deafenChanging.value = false
    }
  }

  async function guildMuteChanged(value: boolean) {
    if (guildMuted.value !== value) preferenceRevision += 1
    guildMuted.value = value
    const target = ctx.room()
    if (!target) {
      syncIdlePreferenceState()
      return
    }
    const session = ctx.voiceSession()
    if (value) await ctx.stopApplicationAudio()
    await reconcileConnectedPreferences(target, session)
    if (session === ctx.voiceSession() && ctx.room() === target) ctx.syncParticipants()
  }

  async function transportRecovered() {
    const target = ctx.room()
    if (!target) return
    const session = ctx.voiceSession()
    try {
      await reconcileConnectedPreferences(target, session)
    } catch (error) {
      if (session === ctx.voiceSession() && ctx.room() === target) {
        ctx.setErrorMessage(error instanceof Error ? error.message : '无法恢复语音状态')
      }
    }
  }

  function connectionReset() {
    pendingDeafenedSync = null
    deafenedSyncError.value = ''
    guildMuted.value = false
    syncIdlePreferenceState()
  }

  // 频道作用域耳机静音（通话叠加）：active 为 true 时只静频道（停发频道麦克风、
  // 停播频道回放、后端同步 deafened=true），不写全局 deafenedPreference；false 时
  // 解除并按通话前偏好回算。无频道（未连接）时仅记录叠加态，无副作用。
  // 与全局偏好独立：施加/解除都不触碰 deafenedPreference，通话中翻转全局偏好也不
  // 解除叠加（reconcile 以 effectiveDeafened = 偏好 || 叠加 计算）。
  async function setCallChannelDeafen(active: boolean): Promise<void> {
    if (channelDeafened.value === active) return
    channelDeafened.value = active
    const target = ctx.room()
    if (!target || ctx.status() === 'connecting') {
      syncIdlePreferenceState()
      return
    }
    const session = ctx.voiceSession()
    ctx.setErrorMessage('')
    try {
      await reconcileConnectedPreferences(target, session)
      if (session === ctx.voiceSession() && ctx.room() === target) ctx.syncParticipants()
    } catch (error) {
      if (session === ctx.voiceSession() && ctx.room() === target) {
        ctx.setErrorMessage(error instanceof Error ? error.message : '无法切换频道静音状态')
      }
    }
  }

  async function applyConnectionPreferences() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const target = ctx.room()
      if (!target) return
      const session = ctx.voiceSession()
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      const revision = preferenceRevision
      await ctx.applyPreferredDevices()
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      await reconcileConnectedPreferences(target, session)
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      await queueDeafenedSync(effectiveDeafened())
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      if (revision === preferenceRevision) return
    }
    throw new Error('语音偏好切换过于频繁，请稍后重试')
  }

  async function reconcileConnectedPreferences(target: Room, session: number) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (session !== ctx.voiceSession() || ctx.room() !== target) return
      const revision = preferenceRevision
      const nextDeafened = effectiveDeafened()
      const shouldEnableMicrophone = microphoneEnabledPreference.value && !nextDeafened && !guildMuted.value

      if (nextDeafened) {
        // 编排器幂等：仅翻转静音（无重发布，模式变化留到解除静音时生效）。
        await ctx.applyMicrophoneState({ enabled: false })
        if (session !== ctx.voiceSession() || ctx.room() !== target) return
        if (ctx.applicationAudioIsPlaying()) await ctx.pauseApplicationAudio(true)
        deafened.value = true
        muted.value = true
        ctx.syncApplicationSoundPlayback()
      } else {
        await ctx.startAudio()
        if (session !== ctx.voiceSession() || ctx.room() !== target) return
        ctx.resumeAudioContext()
        // 单入口声明目标：编排器自行决定 静音翻转 → 模式重发布 → 处理器挂载
        // 的最小序列（含 appliedTransmissionMode 的 diff）。
        await ctx.applyMicrophoneState({ enabled: shouldEnableMicrophone, transmissionMode: ctx.transmissionMode() })
        if (session !== ctx.voiceSession() || ctx.room() !== target) return
        deafened.value = false
        muted.value = !shouldEnableMicrophone
        ctx.syncApplicationSoundPlayback()
        if (ctx.applicationAudioIsAutoPaused()) await ctx.resumeApplicationAudio(true)
      }
      ctx.applyAllVolumes()
      await queueDeafenedSync(nextDeafened)
      if (revision === preferenceRevision) return
    }
    throw new Error('语音状态切换过于频繁，请稍后重试')
  }

  function retryDeafenedSync() {
    if (deafenedSyncError.value) void queueDeafenedSync(deafened.value)
  }

  function queueDeafenedSync(value: boolean): Promise<void> {
    if (!ctx.room()) return Promise.resolve()
    pendingDeafenedSync = value
    if (deafenedSyncSession !== ctx.voiceSession() || !deafenedSyncPromise) {
      deafenedSyncPromise = flushDeafenedSync()
    }
    return deafenedSyncPromise
  }

  async function flushDeafenedSync() {
    const session = ctx.voiceSession()
    if (deafenedSyncSession === session) return
    deafenedSyncSession = session
    try {
      while (ctx.room() && session === ctx.voiceSession() && pendingDeafenedSync !== null) {
        const value = pendingDeafenedSync
        pendingDeafenedSync = null
        const guildId = ctx.connectedGuildId()
        const channelId = ctx.connectedChannelId()
        if (channelId === null) break
        if (guildId === null) return
        try {
          await ctx.syncDeafenedToBackend(guildId, channelId, value)
          if (session === ctx.voiceSession()) deafenedSyncError.value = ''
        } catch {
          if (session === ctx.voiceSession()) {
            pendingDeafenedSync = deafened.value
            deafenedSyncError.value = '耳机静音状态同步失败，将在连接恢复后重试'
          }
          break
        }
      }
    } finally {
      if (deafenedSyncSession === session) {
        deafenedSyncSession = null
        deafenedSyncPromise = null
      }
    }
  }

  return {
    muted,
    deafened,
    guildMuted,
    microphoneEnabledPreference,
    deafenedPreference,
    muteChanging,
    deafenChanging,
    voicePreferenceFeedback,
    deafenedSyncError,
    channelDeafened,
    userToggledMute,
    userToggledDeafen,
    guildMuteChanged,
    transportRecovered,
    connectionReset,
    applyConnectionPreferences,
    notifyPreferenceChange,
    setCallChannelDeafen,
  }
}
