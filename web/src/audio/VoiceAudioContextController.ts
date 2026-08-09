export interface VoiceAudioContextControllerOptions {
  startAudio: () => Promise<void>
  shouldResume: () => boolean
  interactionTarget?: EventTarget
  onError?: (error: unknown) => void
}

export class VoiceAudioContextController {
  readonly context: AudioContext
  private readonly options: VoiceAudioContextControllerOptions
  private resumePromise: Promise<void> | null = null
  private interactionRetryInstalled = false
  private destroyed = false

  constructor(context: AudioContext, options: VoiceAudioContextControllerOptions) {
    this.context = context
    this.options = options
    context.addEventListener('statechange', this.handleStateChange)
  }

  resumeIfNeeded() {
    if (this.destroyed || this.context.state !== 'suspended' || !this.options.shouldResume()) return
    if (this.resumePromise) return

    const attempt = this.options.startAudio()
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        if (this.resumePromise === attempt) this.resumePromise = null
        if (this.destroyed || !this.options.shouldResume()) return
        if (this.context.state === 'suspended') this.installInteractionRetry()
      })
    this.resumePromise = attempt
  }

  // 门控式 startAudio（ADR-0031）：上下文 running 时直接跳过，避免 SDK
  // room.startAudio 的 acquireAudioContext 对全部远端轨道重建 WebAudio 路由
  // （connectWebAudio 以 falsy 检查重放音量，0 被跳过 → 按参与者静音短暂可闻）。
  // 仅上下文未运行（suspended 等）时才调用 startAudio 恢复播放——此时无
  // 声音可言，重路由无感知。与 resumeIfNeeded 的区别：无 shouldResume 门控；
  // 错误不上抛给 onError 吞掉——调用方（reconcileConnectedPreferences →
  // userToggledMute 等）依赖 startAudio 的拒绝来回滚偏好并提示用户，
  // 与 voice-session 无控制器分支 `room.startAudio()` 的上抛语义保持一致。
  ensureRunning() {
    if (this.destroyed || this.context.state === 'running') return Promise.resolve()
    return this.options.startAudio()
  }

  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.context.removeEventListener('statechange', this.handleStateChange)
    this.removeInteractionRetry()
    if (this.context.state !== 'closed') {
      await this.context.close().catch((error) => this.options.onError?.(error))
    }
  }

  private readonly handleStateChange = () => {
    if (this.context.state === 'running') {
      this.removeInteractionRetry()
      return
    }
    this.resumeIfNeeded()
  }

  private readonly handleInteraction = () => {
    this.removeInteractionRetry()
    this.resumeIfNeeded()
  }

  private installInteractionRetry() {
    const target = this.options.interactionTarget
    if (!target || this.interactionRetryInstalled) return
    this.interactionRetryInstalled = true
    target.addEventListener('pointerdown', this.handleInteraction, true)
    target.addEventListener('keydown', this.handleInteraction, true)
  }

  private removeInteractionRetry() {
    const target = this.options.interactionTarget
    if (!target || !this.interactionRetryInstalled) return
    this.interactionRetryInstalled = false
    target.removeEventListener('pointerdown', this.handleInteraction, true)
    target.removeEventListener('keydown', this.handleInteraction, true)
  }
}
