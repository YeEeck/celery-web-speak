const SPEAKING_THRESHOLD = 0.015
const SPEAKING_HOLD_MS = 250
const POLL_INTERVAL_MS = 100

interface MonitoredMicrophone {
  mediaTrack: MediaStreamTrack
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  samples: Float32Array<ArrayBuffer>
  muted: boolean
  speaking: boolean
  lastActiveAt: number
}

export class MicrophoneActivityMonitor {
  private context: AudioContext | null = null
  private silence: GainNode | null = null
  private microphones = new Map<string, MonitoredMicrophone>()
  private timer: number | null = null

  private onChange: (identity: string, speaking: boolean) => void

  constructor(onChange: (identity: string, speaking: boolean) => void) {
    this.onChange = onChange
  }

  sync(sources: Array<{ identity: string; mediaTrack: MediaStreamTrack; muted: boolean }>) {
    const identities = new Set(sources.map((source) => source.identity))
    for (const identity of this.microphones.keys()) {
      if (!identities.has(identity)) this.remove(identity)
    }
    for (const source of sources) {
      const existing = this.microphones.get(source.identity)
      if (existing?.mediaTrack === source.mediaTrack) {
        existing.muted = source.muted
        if (source.muted) this.updateSpeaking(source.identity, existing, false)
        continue
      }
      if (existing) this.remove(source.identity)
      this.add(source.identity, source.mediaTrack, source.muted)
    }
    if (this.microphones.size && this.timer === null) {
      this.timer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS)
    } else if (!this.microphones.size && this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  isSpeaking(identity: string) {
    return this.microphones.get(identity)?.speaking ?? false
  }

  destroy() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    for (const identity of [...this.microphones.keys()]) this.remove(identity)
    this.silence?.disconnect()
    this.silence = null
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') void context.close()
  }

  private add(identity: string, mediaTrack: MediaStreamTrack, muted: boolean) {
    try {
      const context = this.ensureContext()
      const source = context.createMediaStreamSource(new MediaStream([mediaTrack]))
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser).connect(this.silence!)
      this.microphones.set(identity, {
        mediaTrack,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        muted,
        speaking: false,
        lastActiveAt: 0,
      })
    } catch {
      this.onChange(identity, false)
    }
  }

  private remove(identity: string) {
    const microphone = this.microphones.get(identity)
    if (!microphone) return
    microphone.source.disconnect()
    microphone.analyser.disconnect()
    this.microphones.delete(identity)
    if (microphone.speaking) this.onChange(identity, false)
  }

  private ensureContext() {
    if (this.context) return this.context
    const context = new AudioContext()
    const silence = context.createGain()
    silence.gain.value = 0
    silence.connect(context.destination)
    this.context = context
    this.silence = silence
    void context.resume()
    return context
  }

  private poll() {
    const now = performance.now()
    for (const [identity, microphone] of this.microphones) {
      let active = false
      if (!microphone.muted && microphone.mediaTrack.readyState === 'live') {
        microphone.analyser.getFloatTimeDomainData(microphone.samples)
        let energy = 0
        for (const sample of microphone.samples) energy += sample * sample
        active = Math.sqrt(energy / microphone.samples.length) >= SPEAKING_THRESHOLD
      }
      if (active) microphone.lastActiveAt = now
      this.updateSpeaking(identity, microphone, active || now - microphone.lastActiveAt < SPEAKING_HOLD_MS)
    }
  }

  private updateSpeaking(identity: string, microphone: MonitoredMicrophone, speaking: boolean) {
    if (microphone.speaking === speaking) return
    microphone.speaking = speaking
    this.onChange(identity, speaking)
  }
}
