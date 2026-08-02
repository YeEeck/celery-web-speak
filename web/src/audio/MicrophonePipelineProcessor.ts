import {
  Track,
  type AudioProcessorOptions,
  type TrackProcessor,
} from 'livekit-client'
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import type { NoiseSuppressionOption } from '../stores/voice-utils.ts'
import { createRnnoiseNode } from './rnnoise.ts'

export interface MicrophonePipelineOptions {
  gain: number
  noiseSuppression: NoiseSuppressionOption
  rnnoiseBinary: () => Promise<ArrayBuffer | null>
}

// 统一麦克风管线：降噪（RNNoise worklet）与增益在同一 AudioContext 图内。
// 降噪选项控制 worklet 是否入图（直通/启用），切换不更换处理器、不中断音轨；
// 增强降噪在 WASM 缺失或上下文非 48kHz 时保持直通（按回退链由 WebRTC 约束承担降噪）。
export class MicrophonePipelineProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'cws-microphone-pipeline'
  processedTrack?: MediaStreamTrack

  private audioContext?: AudioContext
  private sourceNode?: MediaStreamAudioSourceNode
  private rnnoiseNode?: RnnoiseWorkletNode
  private gainNode?: GainNode
  private destinationNode?: MediaStreamAudioDestinationNode
  private gain: number
  private noiseSuppression: NoiseSuppressionOption
  private readonly rnnoiseBinary: () => Promise<ArrayBuffer | null>
  private suppressionNodePromise: Promise<void> | null = null

  constructor(options: MicrophonePipelineOptions) {
    this.gain = options.gain
    this.noiseSuppression = options.noiseSuppression
    this.rnnoiseBinary = options.rnnoiseBinary
  }

  async init(options: AudioProcessorOptions) {
    this.disconnect()
    this.audioContext = options.audioContext
    await this.connect(options.track)
  }

  async restart(options: AudioProcessorOptions) {
    this.disconnect()
    if (options.audioContext) this.audioContext = options.audioContext
    await this.connect(options.track)
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

  async setNoiseSuppression(option: NoiseSuppressionOption) {
    this.noiseSuppression = option
    if (!this.audioContext || !this.sourceNode || !this.gainNode || !this.destinationNode) return
    if (option !== 'rnnoise') {
      this.rnnoiseNode?.destroy()
      this.rnnoiseNode = undefined
      this.rebuildSuppressionPath()
      return
    }
    await this.ensureSuppressionNode()
  }

  private connect(track: MediaStreamTrack) {
    if (!this.audioContext) throw new Error('浏览器不支持麦克风增益处理')

    const source = this.audioContext.createMediaStreamSource(new MediaStream([track]))
    const gain = this.audioContext.createGain()
    const destination = this.audioContext.createMediaStreamDestination()
    gain.gain.value = this.gain

    this.sourceNode = source
    this.gainNode = gain
    this.destinationNode = destination
    this.processedTrack = destination.stream.getAudioTracks()[0]
    this.rebuildSuppressionPath()
    void this.ensureSuppressionNode()
  }

  // 选项为增强降噪时按需创建 RNNoise 节点：WASM 缺失或上下文非 48kHz 时保持
  // 直通（按回退链由 WebRTC 约束承担降噪）。并发调用共享同一 in-flight 承诺。
  private ensureSuppressionNode(): Promise<void> {
    if (this.noiseSuppression !== 'rnnoise' || this.rnnoiseNode || !this.audioContext) return Promise.resolve()
    if (this.suppressionNodePromise) return this.suppressionNodePromise
    this.suppressionNodePromise = (async () => {
      const binary = await this.rnnoiseBinary()
      if (!binary || !this.audioContext || this.audioContext.sampleRate !== 48_000) return
      const node = await createRnnoiseNode(this.audioContext, binary)
      if (!node || this.noiseSuppression !== 'rnnoise') return
      this.rnnoiseNode?.destroy()
      this.rnnoiseNode = node
      this.rebuildSuppressionPath()
    })().finally(() => {
      this.suppressionNodePromise = null
    })
    return this.suppressionNodePromise
  }

  // 重建 source → (rnnoise?) → gain → destination 的中间路径。
  private rebuildSuppressionPath() {
    const source = this.sourceNode
    const gain = this.gainNode
    const destination = this.destinationNode
    if (!source || !gain || !destination) return
    source.disconnect()
    this.rnnoiseNode?.disconnect()
    if (this.noiseSuppression === 'rnnoise' && this.rnnoiseNode) {
      source.connect(this.rnnoiseNode)
      this.rnnoiseNode.connect(gain)
    } else {
      source.connect(gain)
    }
    gain.connect(destination)
  }

  private disconnect() {
    this.sourceNode?.disconnect()
    this.rnnoiseNode?.disconnect()
    this.rnnoiseNode?.destroy()
    this.gainNode?.disconnect()
    this.processedTrack?.stop()
    this.sourceNode = undefined
    this.rnnoiseNode = undefined
    this.gainNode = undefined
    this.destinationNode = undefined
    this.processedTrack = undefined
  }
}
