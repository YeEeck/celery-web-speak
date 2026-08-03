import { MutedSpeakingReminderState } from './MutedSpeakingReminderState.ts'
import type { SpeechDetectionEngine } from './SpeechDetectionEngine'

interface MutedSpeakingReminderCallbacks {
  onReminder: () => void
}

// MutedSpeakingReminderMonitor 是常开说话检测引擎（ADR-0024）的消费者：
// 订阅引擎的逐帧说话活动事件，用静音说话提醒状态机（武装延迟、连续说话
// 确认、重新武装与冷却）判断是否触发提醒。它不持有麦克风采集或 VAD 资源，
// 也不参与引擎启停——引擎生命周期由 SpeechDetectionLifecycle 驱动。
export class MutedSpeakingReminderMonitor {
  private state = new MutedSpeakingReminderState()
  private callbacks: MutedSpeakingReminderCallbacks
  private unsubscribe: () => void

  constructor(engine: SpeechDetectionEngine, callbacks: MutedSpeakingReminderCallbacks) {
    this.callbacks = callbacks
    this.unsubscribe = engine.subscribe((speaking, frameDurationMs) => {
      if (this.state.process(speaking, frameDurationMs)) this.callbacks.onReminder()
    })
  }

  // reset 在门控翻转启用提醒时调用：武装延迟与冷却从零开始。
  reset() {
    this.state.reset()
  }

  dispose() {
    this.unsubscribe()
  }
}
