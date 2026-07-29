import type { ApplicationSoundAudioAdapter, DecodedCustomSound } from './core'
import { MUTED_SPEAKING_NOTES, SOUND_PRESETS, type NotePattern, type SoundPresetId } from './patterns'

interface WebAudioDependencies {
  createContext: () => AudioContext
  interactionTarget: EventTarget
  diagnose: (message: string, error?: unknown) => void
}

export class BrowserApplicationSoundAudioAdapter implements ApplicationSoundAudioAdapter {
  private context: AudioContext | null = null
  private listenersInstalled = false
  private outputDeviceId = ''
  private routeRevision = 0
  private appliedRouteRevision = -1
  private routeQueue = Promise.resolve()

  constructor(private readonly dependencies: WebAudioDependencies) {}

  start() {
    if (this.listenersInstalled) return
    this.listenersInstalled = true
    this.dependencies.interactionTarget.addEventListener('pointerdown', this.handleInteraction, true)
    this.dependencies.interactionTarget.addEventListener('keydown', this.handleInteraction, true)
  }

  async decode(blob: Blob): Promise<DecodedCustomSound> {
    const context = this.getOrCreateContext()
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    return { duration: buffer.duration, value: buffer }
  }

  async playPreset(preset: SoundPresetId, volume: number) {
    const context = await this.runningContext()
    scheduleNotes(context, SOUND_PRESETS[preset].notes, volume)
  }

  async playCustom(sound: DecodedCustomSound, volume: number) {
    const context = await this.runningContext()
    scheduleCustomSound(context, sound.value as AudioBuffer, volume)
  }

  async playMutedSpeakingReminder(volume: number) {
    const context = await this.runningContext()
    scheduleNotes(context, MUTED_SPEAKING_NOTES, volume)
  }

  followOutput(deviceId: string) {
    this.outputDeviceId = deviceId
    this.routeRevision += 1
    this.appliedRouteRevision = -1
    if (this.context) this.enqueueOutputRoute(this.context, this.routeRevision)
  }

  async dispose() {
    if (this.listenersInstalled) {
      this.listenersInstalled = false
      this.dependencies.interactionTarget.removeEventListener('pointerdown', this.handleInteraction, true)
      this.dependencies.interactionTarget.removeEventListener('keydown', this.handleInteraction, true)
    }
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') {
      try {
        await context.close()
      } catch (error) {
        this.dependencies.diagnose('应用提示音 AudioContext 关闭失败', error)
      }
    }
  }

  private readonly handleInteraction = () => {
    try {
      const context = this.getOrCreateContext()
      if (context.state !== 'running') void context.resume().catch(() => undefined)
    } catch (error) {
      this.dependencies.diagnose('应用提示音首次交互解锁失败', error)
    }
  }

  private getOrCreateContext() {
    if (!this.context || this.context.state === 'closed') {
      this.context = this.dependencies.createContext()
      this.appliedRouteRevision = -1
      this.enqueueOutputRoute(this.context, this.routeRevision)
    }
    return this.context
  }

  private async runningContext() {
    const context = this.context
    if (!context) throw new Error('浏览器尚未允许播放应用提示音')
    if (context.state !== 'running') await context.resume()
    if (context.state !== 'running') throw new Error('应用提示音 AudioContext 未运行')
    if (this.appliedRouteRevision !== this.routeRevision) {
      this.enqueueOutputRoute(context, this.routeRevision)
    }
    await this.routeQueue
    if (context !== this.context || context.state !== 'running') {
      throw new Error('应用提示音 AudioContext 已失效')
    }
    return context
  }

  private enqueueOutputRoute(context: AudioContext, revision: number) {
    const apply = async () => {
      if (context !== this.context || revision !== this.routeRevision) return
      const routable = context as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> }
      if (!routable.setSinkId) {
        this.appliedRouteRevision = revision
        return
      }

      try {
        await routable.setSinkId(this.outputDeviceId)
        if (context === this.context && revision === this.routeRevision) {
          this.appliedRouteRevision = revision
        }
      } catch (error) {
        this.dependencies.diagnose('提示音输出设备切换失败，将回退到系统默认设备', error)
        try {
          await routable.setSinkId('')
          if (context === this.context && revision === this.routeRevision) {
            this.appliedRouteRevision = revision
          }
        } catch (fallbackError) {
          this.dependencies.diagnose('提示音回退到系统默认设备失败', fallbackError)
          if (context === this.context && revision === this.routeRevision) {
            this.appliedRouteRevision = revision
          }
        }
      }
    }
    this.routeQueue = this.routeQueue.then(apply, apply)
  }
}

function scheduleNotes(context: AudioContext, notes: readonly NotePattern[], volume: number) {
  const start = context.currentTime + 0.005
  const master = context.createGain()
  master.gain.setValueAtTime(volume * 0.18, start)
  master.connect(context.destination)

  for (const [index, note] of notes.entries()) {
    const noteStart = start + note.delay
    const noteEnd = noteStart + note.duration
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(note.from, noteStart)
    oscillator.frequency.exponentialRampToValueAtTime(note.to, noteEnd)
    envelope.gain.setValueAtTime(0.0001, noteStart)
    envelope.gain.exponentialRampToValueAtTime(1, noteStart + 0.012)
    envelope.gain.exponentialRampToValueAtTime(0.0001, noteEnd)
    oscillator.connect(envelope)
    envelope.connect(master)
    if (index === notes.length - 1) {
      oscillator.addEventListener('ended', () => master.disconnect(), { once: true })
    }
    oscillator.start(noteStart)
    oscillator.stop(noteEnd + 0.01)
  }
}

function scheduleCustomSound(context: AudioContext, buffer: AudioBuffer, volume: number) {
  const start = context.currentTime + 0.005
  const source = context.createBufferSource()
  const gain = context.createGain()
  source.buffer = buffer
  gain.gain.setValueAtTime(Math.max(0.0001, volume), start)
  source.connect(gain)
  gain.connect(context.destination)
  source.addEventListener('ended', () => {
    source.disconnect()
    gain.disconnect()
  }, { once: true })
  source.start(start)
}
