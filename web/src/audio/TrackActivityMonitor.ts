const DEFAULT_ACTIVITY_THRESHOLD = 0.015
const DEFAULT_ACTIVE_HOLD_MS = 250
const DEFAULT_POLL_INTERVAL_MS = 100

interface MonitoredTrack {
  mediaTrack: MediaStreamTrack
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  samples: Float32Array<ArrayBuffer>
  muted: boolean
  active: boolean
  lastActiveAt: number
}

export class TrackActivityMonitor {
  private readonly holdMs: number
  private context: AudioContext | null = null
  private silence: GainNode | null = null
  private tracks = new Map<string, MonitoredTrack>()
  private timer: number | null = null

  private onChange: (identity: string, active: boolean) => void

  constructor(onChange: (identity: string, active: boolean) => void, holdMs = DEFAULT_ACTIVE_HOLD_MS) {
    this.onChange = onChange
    this.holdMs = holdMs
  }

  sync(sources: Array<{ identity: string; mediaTrack: MediaStreamTrack; muted: boolean }>) {
    const identities = new Set(sources.map((source) => source.identity))
    for (const identity of this.tracks.keys()) {
      if (!identities.has(identity)) this.remove(identity)
    }
    for (const source of sources) {
      const existing = this.tracks.get(source.identity)
      if (existing?.mediaTrack === source.mediaTrack) {
        existing.muted = source.muted
        if (source.muted) this.updateActive(source.identity, existing, false)
        continue
      }
      if (existing) this.remove(source.identity)
      this.add(source.identity, source.mediaTrack, source.muted)
    }
    if (this.tracks.size && this.timer === null) {
      this.timer = window.setInterval(() => this.poll(), DEFAULT_POLL_INTERVAL_MS)
    } else if (!this.tracks.size && this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  isActive(identity: string) {
    return this.tracks.get(identity)?.active ?? false
  }

  destroy() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    for (const identity of [...this.tracks.keys()]) this.remove(identity)
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
      this.tracks.set(identity, {
        mediaTrack,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        muted,
        active: false,
        // 无活动哨兵：保持时长只在首次检测到声音后生效，避免长保持下
        // 新加入的静默轨道在头几秒被误判为有声音。
        lastActiveAt: Number.NEGATIVE_INFINITY,
      })
    } catch {
      this.onChange(identity, false)
    }
  }

  private remove(identity: string) {
    const track = this.tracks.get(identity)
    if (!track) return
    track.source.disconnect()
    track.analyser.disconnect()
    this.tracks.delete(identity)
    if (track.active) this.onChange(identity, false)
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
    for (const [identity, track] of this.tracks) {
      let active = false
      if (!track.muted && track.mediaTrack.readyState === 'live') {
        track.analyser.getFloatTimeDomainData(track.samples)
        let energy = 0
        for (const sample of track.samples) energy += sample * sample
        active = Math.sqrt(energy / track.samples.length) >= DEFAULT_ACTIVITY_THRESHOLD
      }
      if (active) track.lastActiveAt = now
      this.updateActive(identity, track, active || now - track.lastActiveAt < this.holdMs)
    }
  }

  private updateActive(identity: string, track: MonitoredTrack, active: boolean) {
    if (track.active === active) return
    track.active = active
    this.onChange(identity, active)
  }
}
