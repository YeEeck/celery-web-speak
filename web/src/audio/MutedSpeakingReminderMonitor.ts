import { MutedSpeakingReminderState } from './MutedSpeakingReminderState.ts'
import type { SpeechDetectionEngine } from './SpeechDetectionEngine'

interface MutedSpeakingReminderCallbacks {
  onReminder: () => void
}

// MutedSpeakingReminderMonitor 是共享说话检测引擎的消费者：订阅引擎的逐帧
// 说话活动事件，用静音说话提醒状态机（武装延迟、连续说话确认、重新武装与
// 冷却）判断是否触发提醒。它不持有麦克风采集或 VAD 资源，启动与停止委托给
// 引擎。
export class MutedSpeakingReminderMonitor {
  private state = new MutedSpeakingReminderState()
  private engine: SpeechDetectionEngine
  private callbacks: MutedSpeakingReminderCallbacks
  private unsubscribe: () => void

  constructor(engine: SpeechDetectionEngine, callbacks: MutedSpeakingReminderCallbacks) {
    this.engine = engine
    this.callbacks = callbacks
    this.unsubscribe = engine.subscribe((speaking, frameDurationMs) => {
      if (this.state.process(speaking, frameDurationMs)) this.callbacks.onReminder()
    })
  }

  async start(deviceId?: string) {
    this.state.reset()
    return this.engine.start(deviceId)
  }

  stop() {
    this.engine.stop()
  }

  resetFailure() {
    this.engine.resetFailure()
  }

  dispose() {
    this.unsubscribe()
  }
}
