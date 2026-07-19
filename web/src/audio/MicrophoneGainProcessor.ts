import {
  Track,
  type AudioProcessorOptions,
  type TrackProcessor,
} from 'livekit-client'

export class MicrophoneGainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'cws-microphone-gain'
  processedTrack?: MediaStreamTrack

  private audioContext?: AudioContext
  private sourceNode?: MediaStreamAudioSourceNode
  private gainNode?: GainNode
  private destinationNode?: MediaStreamAudioDestinationNode

  constructor(private gain: number) {}

  async init(options: AudioProcessorOptions) {
    this.disconnect()
    this.audioContext = options.audioContext
    this.connect(options.track)
  }

  async restart(options: AudioProcessorOptions) {
    this.disconnect()
    if (options.audioContext) this.audioContext = options.audioContext
    this.connect(options.track)
  }

  async destroy() {
    this.disconnect()
    this.audioContext = undefined
  }

  setGain(gain: number) {
    this.gain = gain
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, 0.02)
    }
  }

  private connect(track: MediaStreamTrack) {
    if (!this.audioContext) throw new Error('浏览器不支持麦克风增益处理')

    const source = this.audioContext.createMediaStreamSource(new MediaStream([track]))
    const gain = this.audioContext.createGain()
    const destination = this.audioContext.createMediaStreamDestination()
    gain.gain.value = this.gain
    source.connect(gain)
    gain.connect(destination)

    this.sourceNode = source
    this.gainNode = gain
    this.destinationNode = destination
    this.processedTrack = destination.stream.getAudioTracks()[0]
  }

  private disconnect() {
    this.sourceNode?.disconnect()
    this.gainNode?.disconnect()
    this.processedTrack?.stop()
    this.sourceNode = undefined
    this.gainNode = undefined
    this.destinationNode = undefined
    this.processedTrack = undefined
  }
}
