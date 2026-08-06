import { computed, ref, watch } from 'vue'
import type { SpeechDetectionEngine } from '../audio/SpeechDetectionEngine.ts'
import { PresenceActivityTracker, type AutoPresenceStatus } from './presence-activity.ts'

export type StatusSetting = 'auto' | 'fixed_away'
export type PresenceStatus = AutoPresenceStatus

export interface VoicePresenceContext {
  createSpeechDetectionEngine(): SpeechDetectionEngine
  devicePermissionState(): 'idle' | 'requesting' | 'granted' | 'denied'
  /** 有效静音（主动麦克风静音或耳机静音连带）；静音期间说话活动不作为在场证据。 */
  microphoneMuted(): boolean
  socketStatus(): string
  currentUserID(): number | null
  fixedAwayFromAccount(): boolean
  setStatusSettingOnServer(fixedAway: boolean): Promise<void>
  sendDeviceStatus(status: PresenceStatus): void
}

// useVoicePresence 拥有"我自己的在线状态"链路：常开说话检测引擎、自动状态
// 检测状态机、设备状态上报与状态设置。展示层消费 ownPresenceStatus 与
// statusSetting。
export function useVoicePresence(ctx: VoicePresenceContext) {
  const engine = ctx.createSpeechDetectionEngine()
  const tracker = new PresenceActivityTracker()
  const statusSetting = ref<StatusSetting>(ctx.fixedAwayFromAccount() ? 'fixed_away' : 'auto')
  const autoPresence = ref<AutoPresenceStatus>(tracker.value)

  engine.subscribe((speaking, frameDurationMs) => {
    if (statusSetting.value !== 'auto') return
    tracker.onSpeechFrame(speaking, frameDurationMs)
    if (tracker.value === autoPresence.value) return
    autoPresence.value = tracker.value
    ctx.sendDeviceStatus(autoPresence.value)
  })

  // 引擎失败时静默停用状态检测：没有信号源的计时会把人错误地推入离开。
  engine.onFailure(() => {
    tracker.stop()
    autoPresence.value = tracker.value
  })

  const ownPresenceStatus = computed<PresenceStatus>(() => (
    statusSetting.value === 'fixed_away' ? 'away' : autoPresence.value
  ))

  watch(() => ctx.fixedAwayFromAccount(), (fixedAway) => {
    statusSetting.value = fixedAway ? 'fixed_away' : 'auto'
  })

  watch(statusSetting, (setting) => {
    if (setting === 'auto') {
      tracker.start()
      autoPresence.value = tracker.value
      ctx.sendDeviceStatus(autoPresence.value)
    } else {
      ctx.sendDeviceStatus('away')
    }
  })

  // 引擎生命周期由应用级生命周期驱动（voice.ts 装配，ADR-0024），此处只按
  // 权限与登录状态启停本地的检测状态机。
  watch(() => ctx.devicePermissionState(), (state) => {
    if (state === 'granted') tracker.start()
    else tracker.stop()
  })

  // 静音门控（ADR-0023 修订）：静音期间说话帧不采信、离开计时照常进行，
  // 状态机内部的边界清空由 setSpeechIgnored 处理。
  watch(() => ctx.microphoneMuted(), (muted) => {
    tracker.setSpeechIgnored(muted)
  })

  watch(() => ctx.currentUserID(), (userID) => {
    if (userID === null) tracker.stop()
  })

  watch(() => ctx.socketStatus(), (status) => {
    if (status === 'online') ctx.sendDeviceStatus(ownPresenceStatus.value)
  })

  async function setStatusSetting(next: StatusSetting) {
    if (next === statusSetting.value) return
    const previous = statusSetting.value
    statusSetting.value = next
    try {
      await ctx.setStatusSettingOnServer(next === 'fixed_away')
    } catch (error) {
      statusSetting.value = previous
      throw error
    }
  }

  return {
    statusSetting,
    ownPresenceStatus,
    setStatusSetting,
  }
}
