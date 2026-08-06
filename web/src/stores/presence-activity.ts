export const PRESENCE_AWAY_AFTER_MS = 10 * 60_000
export const PRESENCE_SPEECH_CONFIRM_MS = 600

export type AutoPresenceStatus = 'online' | 'away'

export interface PresenceActivityTimer {
  now: () => number
  schedule: (delayMs: number, callback: () => void) => number
  clear: (handle: number) => void
}

// PresenceActivityTracker 是自动状态检测状态机：自动模式下，一次连续约
// 600 毫秒的说话活动被确认为"在场"，重置 10 分钟离开计时；计时到期进入
// 离开；离开后新的连续说话活动立即回到在线。仅在检测运行（麦克风授权且
// 引擎可用）时 start；stop 后回到"连接存活"语义的在线。静音期间由
// setSpeechIgnored 使说话帧不采信（离开计时照常进行）。注入计时器以支持
// 测试。
export class PresenceActivityTracker {
  private status: AutoPresenceStatus = 'online'
  private running = false
  private speechIgnored = false
  private utteranceSpeechMs = 0
  private awayTimer: number | null = null
  private timer: PresenceActivityTimer

  constructor(timer?: Partial<PresenceActivityTimer>) {
    this.timer = {
      now: () => Date.now(),
      schedule: (delayMs, callback) => window.setTimeout(callback, delayMs),
      clear: (handle) => window.clearTimeout(handle),
      ...timer,
    }
  }

  get value(): AutoPresenceStatus {
    return this.status
  }

  // start 用于麦克风授权或切回自动模式：从在线开始重新评估。
  start() {
    this.running = true
    this.utteranceSpeechMs = 0
    this.status = 'online'
    this.armAwayTimer()
  }

  // stop 用于检测暂停（无麦克风权限）：清除计时，状态回到连接存活语义的在线。
  stop() {
    this.running = false
    this.utteranceSpeechMs = 0
    this.status = 'online'
    if (this.awayTimer !== null) {
      this.timer.clear(this.awayTimer)
      this.awayTimer = null
    }
  }

  // setSpeechIgnored 是静音门控（麦克风静音/耳机静音）：静音期间说话帧
  // 不采信，离开计时照常进行——静音满 10 分钟仍进入离开，静音中的说话
  // 不能拉回在线。静音边界清空未确认的部分话语，防止静音前后两段不相干
  // 说话拼接成一次 600 毫秒确认。
  setSpeechIgnored(ignored: boolean) {
    if (this.speechIgnored === ignored) return
    this.speechIgnored = ignored
    if (ignored) this.utteranceSpeechMs = 0
  }

  onSpeechFrame(speaking: boolean, frameDurationMs: number) {
    if (!this.running || this.speechIgnored) return
    if (!Number.isFinite(frameDurationMs) || frameDurationMs <= 0) return
    if (speaking) {
      this.utteranceSpeechMs += frameDurationMs
      if (this.utteranceSpeechMs < PRESENCE_SPEECH_CONFIRM_MS) return
      if (this.status === 'away') this.status = 'online'
      this.armAwayTimer()
    } else {
      this.utteranceSpeechMs = 0
    }
  }

  private armAwayTimer() {
    if (this.awayTimer !== null) {
      this.timer.clear(this.awayTimer)
      this.awayTimer = null
    }
    this.awayTimer = this.timer.schedule(PRESENCE_AWAY_AFTER_MS, () => {
      this.awayTimer = null
      this.status = 'away'
    })
  }
}
