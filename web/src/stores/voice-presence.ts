import { computed, ref, watch } from 'vue'
import type { SpeechDetectionEngine } from '../audio/SpeechDetectionEngine.ts'
import { PresenceActivityTracker, type AutoPresenceStatus } from './presence-activity.ts'

export type StatusSetting = 'auto' | 'fixed_away'
export type PresenceStatus = AutoPresenceStatus

export interface VoicePresenceContext {
  createSpeechDetectionEngine(): SpeechDetectionEngine
  devicePermissionState(): 'idle' | 'requesting' | 'granted' | 'denied'
  socketStatus(): string
  currentUserID(): number | null
  initialFixedAway(): boolean
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
  const statusSetting = ref<StatusSetting>(ctx.initialFixedAway() ? 'fixed_away' : 'auto')
  const autoPresence = ref<AutoPresenceStatus>(tracker.value)

  engine.subscribe((speaking, frameDurationMs) => {
    if (statusSetting.value !== 'auto') return
    tracker.onSpeechFrame(speaking, frameDurationMs)
    if (tracker.value === autoPresence.value) return
    autoPresence.value = tracker.value
    ctx.sendDeviceStatus(autoPresence.value)
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

  watch(() => ctx.devicePermissionState(), (state) => {
    if (state === 'granted') {
      void engine.start()
      tracker.start()
    } else {
      engine.stop()
      tracker.stop()
    }
  })

  watch(() => ctx.currentUserID(), (userID) => {
    if (userID === null) engine.stop()
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
