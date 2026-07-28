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
