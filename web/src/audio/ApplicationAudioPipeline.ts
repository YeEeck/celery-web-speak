const SAMPLE_RATE = 48_000

export class ApplicationAudioPipeline {
  private context: AudioContext | null = null
  private processor: AudioWorkletNode | null = null
  private gain: GainNode | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  private track: MediaStreamTrack | null = null
  private attachedSessionId: string | null = null

  async initialize(volume: number) {
    if (this.track) return this.track
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    try {
      await context.audioWorklet.addModule(new URL('./application-audio-worklet.js', import.meta.url))
      const processor = new AudioWorkletNode(context, 'cws-application-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      })
      const gain = context.createGain()
      const destination = context.createMediaStreamDestination()
      gain.gain.value = volume
      processor.connect(gain).connect(destination)
      const track = destination.stream.getAudioTracks()[0]
      if (!track) throw new Error('无法创建背景音媒体轨道')
      if ('contentHint' in track) track.contentHint = 'music'
      this.context = context
      this.processor = processor
      this.gain = gain
      this.destination = destination
      this.track = track
      await context.resume()
      return track
    } catch (error) {
      await context.close().catch(() => undefined)
      throw error
    }
  }

  attachPort(sessionId: string, port: MessagePort) {
    if (!this.processor || this.attachedSessionId) {
      port.close()
      return false
    }
    this.attachedSessionId = sessionId
    this.processor.port.postMessage({ type: 'attach-port', sessionId, port }, [port])
    return true
  }

  hasAttachedPort(sessionId: string) {
    return this.attachedSessionId === sessionId
  }

  setVolume(volume: number) {
    if (!this.gain || !this.context) return
    this.gain.gain.setValueAtTime(volume, this.context.currentTime)
  }

  reset(sessionId: string) {
    this.processor?.port.postMessage({ type: 'reset', sessionId })
  }

  mediaTrack() {
    return this.track
  }

  async destroy() {
    this.processor?.port.postMessage({ type: 'destroy' })
    this.processor?.disconnect()
    this.gain?.disconnect()
    this.track?.stop()
    const context = this.context
    this.context = null
    this.processor = null
    this.gain = null
    this.destination = null
    this.track = null
    this.attachedSessionId = null
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
  }
}
