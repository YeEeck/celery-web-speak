// 把边沿型说话信号（LiveKit isSpeaking）展成固定间隔的帧，供常开 VAD
// 让出采集后的 PresenceActivityTracker 累计 600ms 确认。

export class SpeechFrameIngest {
  private timer: number | null = null
  private readonly emit: (speaking: boolean, frameDurationMs: number) => void
  private readonly intervalMs: number

  constructor(
    emit: (speaking: boolean, frameDurationMs: number) => void,
    intervalMs = 100,
  ) {
    this.emit = emit
    this.intervalMs = intervalMs
  }

  setSpeaking(speaking: boolean) {
    if (speaking) {
      this.emit(true, this.intervalMs)
      if (this.timer === null) {
        this.timer = globalThis.setInterval(() => this.emit(true, this.intervalMs), this.intervalMs)
      }
      return
    }
    this.stop()
    this.emit(false, this.intervalMs)
  }

  stop() {
    if (this.timer === null) return
    globalThis.clearInterval(this.timer)
    this.timer = null
  }
}
