export const MUTED_SPEAKING_ARM_DELAY_MS = 1_000
export const MUTED_SPEAKING_TRIGGER_MS = 600
export const MUTED_SPEAKING_REARM_MS = 1_500
export const MUTED_SPEAKING_COOLDOWN_MS = 10_000

export class MutedSpeakingReminderState {
  private elapsedMs = 0
  private speechMs = 0
  private silenceMs = 0
  private remindedForCurrentUtterance = false
  private lastReminderAt = Number.NEGATIVE_INFINITY

  // reset 在每次检测启动时调用，保证武装延迟与冷却从零开始（与引擎重启前
  // 的独立状态机语义一致）。
  reset() {
    this.elapsedMs = 0
    this.speechMs = 0
    this.silenceMs = 0
    this.remindedForCurrentUtterance = false
    this.lastReminderAt = Number.NEGATIVE_INFINITY
  }

  process(speaking: boolean, frameDurationMs: number) {
    if (!Number.isFinite(frameDurationMs) || frameDurationMs <= 0) return false
    this.elapsedMs += frameDurationMs

    if (this.elapsedMs <= MUTED_SPEAKING_ARM_DELAY_MS) return false

    if (speaking) {
      this.silenceMs = 0
      this.speechMs += frameDurationMs
      if (
        !this.remindedForCurrentUtterance
        && this.speechMs >= MUTED_SPEAKING_TRIGGER_MS
        && this.elapsedMs - this.lastReminderAt >= MUTED_SPEAKING_COOLDOWN_MS
      ) {
        this.remindedForCurrentUtterance = true
        this.lastReminderAt = this.elapsedMs
        return true
      }
      return false
    }

    this.speechMs = 0
    if (!this.remindedForCurrentUtterance) return false
    this.silenceMs += frameDurationMs
    if (this.silenceMs >= MUTED_SPEAKING_REARM_MS) {
      this.remindedForCurrentUtterance = false
      this.silenceMs = 0
    }
    return false
  }
}
