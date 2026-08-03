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
  loadRnnoiseBinary: () => Promise<ArrayBuffer | null>
  createRnnoiseNode?: (context: AudioContext, binary: ArrayBuffer) => Promise<RnnoiseWorkletNode | null>
  onRnnoiseUnavailable?: (isGenerationCurrent: () => boolean) => void | Promise<void>
  rnnoiseCaptureAllowed?: boolean
}

// 统一麦克风管线：降噪（RNNoise worklet）与增益在同一 AudioContext 图内。
// 降噪选项控制 worklet 是否入图（直通/启用），切换复用同一个处理器；
// 增强降噪在能力未就绪或上下文非 48kHz 时保持直通（按回退链由 WebRTC 约束承担降噪）。
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
  private readonly loadRnnoiseBinary: () => Promise<ArrayBuffer | null>
  private readonly createRnnoiseNode: (context: AudioContext, binary: ArrayBuffer) => Promise<RnnoiseWorkletNode | null>
  private readonly onRnnoiseUnavailable?: (isGenerationCurrent: () => boolean) => void | Promise<void>
  private rnnoiseCaptureAllowed: boolean
  private pipelineGeneration = 0
  private suppressionNodePromise: { generation: number; promise: Promise<void> } | null = null
  private unavailableGeneration: number | null = null

  constructor(options: MicrophonePipelineOptions) {
    this.gain = options.gain
    this.noiseSuppression = options.noiseSuppression
    this.loadRnnoiseBinary = options.loadRnnoiseBinary
    this.createRnnoiseNode = options.createRnnoiseNode ?? createRnnoiseNode
    this.onRnnoiseUnavailable = options.onRnnoiseUnavailable
    this.rnnoiseCaptureAllowed = options.rnnoiseCaptureAllowed ?? true
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
      this.invalidateSuppression()
      return
    }
    await this.ensureSuppressionNode()
  }

  // 采集约束在设置处理器前确定。能力在 getUserMedia 之后才就绪时，
  // 本次采集仍保持 WebRTC 直通，避免后来又叠加 RNNoise。
  setCaptureNoiseSuppression(noiseSuppression: boolean) {
    this.rnnoiseCaptureAllowed = !noiseSuppression
    if (noiseSuppression) {
      this.invalidateSuppression()
    } else if (this.audioContext && this.sourceNode && this.noiseSuppression === 'rnnoise') {
      void this.ensureSuppressionNode()
    }
  }

  private connect(track: MediaStreamTrack) {
    if (!this.audioContext) throw new Error('浏览器不支持麦克风音频处理')

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

  // 选项为增强降噪时按需创建 RNNoise 节点。异步创建绑定管线代次，
  // 重启或切换选项后迟到的节点不能重新接入旧图。
  private ensureSuppressionNode(): Promise<void> {
    if (this.noiseSuppression !== 'rnnoise' || this.rnnoiseNode || !this.audioContext) return Promise.resolve()
    const generation = this.pipelineGeneration
    if (!this.rnnoiseCaptureAllowed) return Promise.resolve()
    if (this.suppressionNodePromise?.generation === generation) return this.suppressionNodePromise.promise

    let promise: Promise<void>
    promise = (async () => {
      let binary: ArrayBuffer | null
      try {
        binary = await this.loadRnnoiseBinary()
      } catch {
        await this.handleRnnoiseUnavailable(generation)
        return
      }
      if (!this.isCurrentGeneration(generation)) return
      if (!binary || !this.audioContext || this.audioContext.sampleRate !== 48_000) {
        await this.handleRnnoiseUnavailable(generation)
        return
      }

      let node: RnnoiseWorkletNode | null
      try {
        node = await this.createRnnoiseNode(this.audioContext, binary)
      } catch {
        node = null
      }
      if (!node) {
        await this.handleRnnoiseUnavailable(generation)
        return
      }
      // RNNoise 为单声道语音增强：强制 worklet 输入单声道（输出随之单声道），
      // 否则立体声麦克风下输出右声道保持静音，对端仅听到左声道。
      node.channelCount = 1
      node.channelCountMode = 'explicit'
      if (!this.isCurrentGeneration(generation)
        || this.noiseSuppression !== 'rnnoise'
        || !this.rnnoiseCaptureAllowed) {
        node.destroy()
        return
      }
      this.rnnoiseNode?.destroy()
      this.rnnoiseNode = node
      this.rebuildSuppressionPath()
    })().finally(() => {
      if (this.suppressionNodePromise?.promise === promise) this.suppressionNodePromise = null
    })
    this.suppressionNodePromise = { generation, promise }
    return promise
  }

  // 重建 source → (rnnoise?) → gain → destination 的中间路径。
  private rebuildSuppressionPath() {
    const source = this.sourceNode
    const gain = this.gainNode
    const destination = this.destinationNode
    if (!source || !gain || !destination) return
    source.disconnect()
    this.rnnoiseNode?.disconnect()
    gain.disconnect()
    if (this.noiseSuppression === 'rnnoise' && this.rnnoiseNode) {
      source.connect(this.rnnoiseNode)
      this.rnnoiseNode.connect(gain)
    } else {
      source.connect(gain)
    }
    gain.connect(destination)
  }

  private disconnect() {
    this.invalidateSuppression()
    this.sourceNode?.disconnect()
    this.destroyRnnoiseNode()
    this.gainNode?.disconnect()
    this.processedTrack?.stop()
    this.sourceNode = undefined
    this.rnnoiseNode = undefined
    this.gainNode = undefined
    this.destinationNode = undefined
    this.processedTrack = undefined
  }

  private invalidateSuppression() {
    this.pipelineGeneration += 1
    this.destroyRnnoiseNode()
    this.rebuildSuppressionPath()
  }

  private destroyRnnoiseNode() {
    this.rnnoiseNode?.disconnect()
    this.rnnoiseNode?.destroy()
    this.rnnoiseNode = undefined
  }

  private isCurrentGeneration(generation: number) {
    return generation === this.pipelineGeneration
      && this.noiseSuppression === 'rnnoise'
      && this.rnnoiseCaptureAllowed
      && this.audioContext !== undefined
      && this.sourceNode !== undefined
      && this.gainNode !== undefined
      && this.destinationNode !== undefined
  }

  private async handleRnnoiseUnavailable(generation: number) {
    if (!this.isCurrentGeneration(generation)) return
    this.rnnoiseCaptureAllowed = false
    this.destroyRnnoiseNode()
    this.rebuildSuppressionPath()
    if (this.unavailableGeneration === generation) return
    this.unavailableGeneration = generation
    await this.onRnnoiseUnavailable?.(() => this.isGenerationActive(generation))
  }

  private isGenerationActive(generation: number) {
    return generation === this.pipelineGeneration
      && this.audioContext !== undefined
      && this.sourceNode !== undefined
      && this.gainNode !== undefined
      && this.destinationNode !== undefined
  }
}
