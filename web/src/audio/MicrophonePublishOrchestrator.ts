import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import type { NoiseSuppressionOption, VoiceTransmissionMode } from '../stores/voice-utils.ts'
import { buildMicrophoneCaptureOptions } from './microphoneCaptureOptions.ts'
import { MicrophonePipelineProcessor } from './MicrophonePipelineProcessor.ts'

// 麦克风发布链编排器：把「把麦克风声音发布到语音会话」收成一个深模块。
// 调用方只声明目标状态（启用与否、降噪选项、传输模式），操作序列、会话
// 守卫与方向性顺序（先拆后建）全部内化。
//
// 竞态模型（两层，各管一个异步边界）：
// - 本模块的 revision：串行化并发 applyMicrophoneState，并在 join/leave 时
//   作废进行中的操作（invalidate/endSession 递增会话代际）。
// - MicrophonePipelineProcessor 内部的 pipelineGeneration：管 AudioWorklet
//   节点异步创建迟到（重启/切选项后旧节点不得重新入图）。
//
// 窄端口依赖（MicrophonePublishTarget）让 livekit Room 结构兼容、测试只需
// 小桩；getter 注入让偏好/状态读取与 UI 层解耦。

export interface MicrophoneTrackPort {
  constraints: MediaTrackConstraints
  getProcessor(): unknown
  setProcessor(processor: unknown): Promise<void>
  stopProcessor(): Promise<void>
  restartTrack(options?: unknown): Promise<void>
}

// 窄端口：livekit Room 结构兼容（方法参数取宽类型，规避方法逆变）。
export interface MicrophonePublishTarget {
  localParticipant: {
    readonly isMicrophoneEnabled: boolean
    getTrackPublication(source: string): { audioTrack?: MicrophoneTrackPort | null; options?: unknown } | undefined
    setMicrophoneEnabled(enabled: boolean, captureOptions?: unknown, publishOptions?: unknown): Promise<unknown>
    unpublishTrack(track: unknown, stopOnUnpublish?: boolean): Promise<unknown>
    publishTrack(track: unknown, options?: unknown): Promise<unknown>
  }
}

export interface MicrophonePublishState {
  /** 目标麦克风启用状态；不提供则不变。 */
  enabled?: boolean
  /** 目标降噪选项；不提供则不变。切换是方向性的（先拆后建），并触发重发布。 */
  noiseSuppression?: NoiseSuppressionOption
  /** 目标传输模式；与已应用模式不同时触发重发布。 */
  transmissionMode?: VoiceTransmissionMode
  /** 强制按当前状态重发布（频道码率/RED 等发布设置变化后）。 */
  forceRepublish?: boolean
}

export interface MicrophonePublishOrchestratorOptions {
  gain: number
  noiseSuppressionOption(): NoiseSuppressionOption
  webRtcNoiseSuppression(): boolean
  resolvedPreferredInputDeviceId(): string
  echoCancellation(): boolean
  publishSettings(): { audioBitrateKbps: number; audioRedEnabled: boolean }
  isAudioContextAvailable(): boolean
  transmissionMode(): VoiceTransmissionMode
  /** 会话处于可重发布状态（connected / connecting）。 */
  isSessionLive(): boolean
  loadRnnoiseBinary(): Promise<ArrayBuffer | null>
  createRnnoiseNode?: (context: AudioContext, binary: ArrayBuffer) => Promise<RnnoiseWorkletNode | null>
  onError?(message: string, error?: unknown): void
}

const MICROPHONE_SOURCE = 'microphone'

export class MicrophonePublishOrchestrator {
  private readonly options: MicrophonePublishOrchestratorOptions
  private readonly processor: MicrophonePipelineProcessor
  private target: MicrophonePublishTarget | null = null
  private session = 0
  private revision = 0
  private queue: Promise<void> = Promise.resolve()
  private appliedTransmissionMode: VoiceTransmissionMode | null = null
  private rnnoiseFallback = false

  constructor(options: MicrophonePublishOrchestratorOptions) {
    this.options = options
    this.processor = new MicrophonePipelineProcessor({
      gain: options.gain,
      noiseSuppression: options.noiseSuppressionOption(),
      loadRnnoiseBinary: options.loadRnnoiseBinary,
      createRnnoiseNode: options.createRnnoiseNode,
      onRnnoiseUnavailable: (isGenerationCurrent) => this.handleRnnoiseUnavailable(isGenerationCurrent),
      rnnoiseCaptureAllowed: !options.webRtcNoiseSuppression(),
    })
  }

  // 会话边界：join 入口作废旧会话；room 就绪后接入新会话；离开/断开时结束。
  invalidate() {
    this.session += 1
    this.target = null
    this.appliedTransmissionMode = null
    this.rnnoiseFallback = false
  }

  beginSession(target: MicrophonePublishTarget) {
    this.target = target
  }

  endSession() {
    this.invalidate()
  }

  setGain(gain: number) {
    this.processor.setGain(gain)
  }

  // 初始采集约束（加入会话时创建 Room 的 audioCaptureDefaults 用）。
  buildCaptureOptions(noiseSuppressionOverride?: boolean): ReturnType<typeof buildMicrophoneCaptureOptions> {
    const option = this.options.noiseSuppressionOption()
    const noiseSuppression = noiseSuppressionOverride
      ?? (option === 'rnnoise' && this.rnnoiseFallback ? true : this.options.webRtcNoiseSuppression())
    return buildMicrophoneCaptureOptions({
      deviceId: this.options.resolvedPreferredInputDeviceId(),
      echoCancellation: this.options.echoCancellation(),
      noiseSuppression,
    })
  }

  // 单一入口：声明目标状态，模块自决最小操作序列。并发调用串行执行，
  // 会话切换或更新的调用会让过期的进行中操作静默作废。
  // 箭头函数字段：方法被以裸引用传递（voice-session 组装层转发），绑定实例 this。
  applyMicrophoneState = (state: MicrophonePublishState): Promise<void> => {
    const revision = ++this.revision
    const run = this.queue.then(async () => {
      if (revision !== this.revision) return
      await this.applyDiff(revision, state)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async applyDiff(revision: number, state: MicrophonePublishState) {
    const target = this.target
    if (!target) {
      // 未接入会话：只落处理器级降噪选项（连接后由 applyMicrophoneState 应用）。
      if (state.noiseSuppression !== undefined) await this.processor.setNoiseSuppression(state.noiseSuppression)
      return
    }
    const session = this.session
    const mode = state.transmissionMode ?? this.options.transmissionMode()

    if (state.noiseSuppression !== undefined) {
      // 切回增强降噪即解除会话内回退粘滞，让本次采集约束重新按增强降噪合成；
      // 若再次失败，回退链仍会逐次收敛到系统降噪。
      if (state.noiseSuppression === 'rnnoise') this.rnnoiseFallback = false
      // 目标非增强降噪时先拆掉 RNNoise 节点，再重发布；反向则靠重发布内部
      // 的 track 重建先于处理器切换，两套抑制器永不重叠。
      if (state.noiseSuppression !== 'rnnoise') {
        await this.processor.setNoiseSuppression(state.noiseSuppression)
        if (!this.isCurrent(revision, session, target)) return
      }
    }

    if (state.enabled !== undefined) {
      await this.setEnabledPath(revision, session, target, state.enabled, mode)
      if (!this.isCurrent(revision, session, target)) return
    }

    const modeChanged = state.transmissionMode !== undefined && state.transmissionMode !== this.appliedTransmissionMode
    const microphoneActive = target.localParticipant.isMicrophoneEnabled
    if ((modeChanged || state.noiseSuppression !== undefined || state.forceRepublish === true) && microphoneActive) {
      await this.republishPath(revision, session, target, mode)
      if (!this.isCurrent(revision, session, target)) return
    }

    if (state.enabled === true) {
      // 偏好收敛的兜底挂载（静音翻转后处理器可能尚未挂到新采集上）。
      await this.attachPath(revision, session, target)
      if (!this.isCurrent(revision, session, target)) return
    }

    if (state.noiseSuppression !== undefined) {
      // 目标为增强降噪时在此触发节点创建；非增强降噪时此处是幂等拆除。
      await this.processor.setNoiseSuppression(state.noiseSuppression)
    }
  }

  // 仅翻转静音：约束变化时先重建采集，否则只 setMicrophoneEnabled。
  private async setEnabledPath(revision: number, session: number, target: MicrophonePublishTarget, enabled: boolean, mode: VoiceTransmissionMode) {
    if (target.localParticipant.isMicrophoneEnabled === enabled) return
    const captureOptions = enabled ? this.buildCaptureOptions() : undefined
    const existingTrack = enabled
      ? target.localParticipant.getTrackPublication(MICROPHONE_SOURCE)?.audioTrack
      : undefined
    if (existingTrack && captureOptions) {
      await this.detachPipelineForUnavailableAudioContext(existingTrack)
      if (!this.isCurrent(revision, session, target)) return
      if (existingTrack.constraints.noiseSuppression !== captureOptions.noiseSuppression) {
        await existingTrack.restartTrack(captureOptions)
        if (!this.isCurrent(revision, session, target)) return
      }
    }
    if (captureOptions) this.processor.setCaptureNoiseSuppression(captureOptions.noiseSuppression)
    await target.localParticipant.setMicrophoneEnabled(
      enabled,
      captureOptions,
      enabled ? this.publishOptions(mode) : undefined,
    )
    if (!this.isCurrent(revision, session, target)) return
    // LiveKit ignores publishOptions when unmuting an existing publication;
    // the mute/deafen reconciler will republish it if the mode changed while muted.
    if (enabled && !existingTrack) this.appliedTransmissionMode = mode
  }

  // 完整重发布：重建采集 → 挂处理器 → 解除并重发轨道，让 DTX/码率/降噪
  // 约束的变更到达 LiveKit。失败时恢复一条可用的麦克风轨道再向上抛错。
  private async republishPath(revision: number, session: number, target: MicrophonePublishTarget, mode: VoiceTransmissionMode, noiseSuppressionOverride?: boolean) {
    const captureOptions = this.buildCaptureOptions(noiseSuppressionOverride)
    const microphonePublication = target.localParticipant.getTrackPublication(MICROPHONE_SOURCE)
    const microphoneTrack = microphonePublication?.audioTrack
    const previousPublishOptions = microphonePublication?.options
    let microphoneUnpublished = false
    try {
      if (microphoneTrack) {
        await this.detachPipelineForUnavailableAudioContext(microphoneTrack)
        if (!this.isCurrent(revision, session, target)) return
      }
      this.processor.setCaptureNoiseSuppression(captureOptions.noiseSuppression)
      if (microphoneTrack && target.localParticipant.isMicrophoneEnabled) {
        // setMicrophoneEnabled(false/true) only mutes an existing publication and
        // ignores publishOptions. Reacquire the source first, then explicitly
        // republish the same track so DTX/bitrate/RED changes reach LiveKit.
        await microphoneTrack.restartTrack(captureOptions)
        if (!this.isCurrent(revision, session, target)) return
        await this.attachPath(revision, session, target)
        if (!this.isCurrent(revision, session, target)) return
        microphoneUnpublished = true
        await target.localParticipant.unpublishTrack(microphoneTrack, false)
        if (!this.isCurrent(revision, session, target)) return
        await target.localParticipant.publishTrack(microphoneTrack, this.publishOptions(mode))
        if (!this.isCurrent(revision, session, target)) return
        this.appliedTransmissionMode = mode
        return
      }
      await target.localParticipant.setMicrophoneEnabled(false)
      if (!this.isCurrent(revision, session, target)) return
      await target.localParticipant.setMicrophoneEnabled(true, captureOptions, this.publishOptions(mode))
      if (!this.isCurrent(revision, session, target)) return
      this.appliedTransmissionMode = mode
      await this.attachPath(revision, session, target)
    } catch (error) {
      // Re-publishing can fail after the old track has been disabled. Restore a
      // live microphone before propagating the original error to the caller.
      if (this.isCurrent(revision, session, target) && !target.localParticipant.isMicrophoneEnabled) {
        try {
          if (microphoneUnpublished && microphoneTrack) {
            if (!target.localParticipant.getTrackPublication(MICROPHONE_SOURCE)?.audioTrack) {
              await target.localParticipant.publishTrack(microphoneTrack, previousPublishOptions)
            }
          } else {
            await target.localParticipant.setMicrophoneEnabled(true, captureOptions, this.publishOptions(mode))
          }
          if (this.isCurrent(revision, session, target)) await this.attachPath(revision, session, target)
        } catch {
          // Preserve the original failure; the caller can surface or retry it.
        }
      }
      throw error
    }
  }

  // 把 Web Audio 处理器挂到已发布的麦克风轨道上。上下文不可用时不能走
  // Web Audio 路径：摘下处理器并按回退约束重建采集。
  private async attachPath(revision: number, session: number, target: MicrophonePublishTarget) {
    const track = target.localParticipant.getTrackPublication(MICROPHONE_SOURCE)?.audioTrack
    if (!this.options.isAudioContextAvailable()) {
      if (track && target.localParticipant.isMicrophoneEnabled) {
        await this.detachPipelineForUnavailableAudioContext(track)
        if (!this.isCurrent(revision, session, target)) return
        const captureOptions = this.buildCaptureOptions()
        if (track.constraints.noiseSuppression !== captureOptions.noiseSuppression) {
          await track.restartTrack(captureOptions)
          if (!this.isCurrent(revision, session, target)) return
        }
      }
      return
    }
    if (track && track.getProcessor() !== this.processor) {
      this.processor.setCaptureNoiseSuppression(this.buildCaptureOptions().noiseSuppression)
      if (!this.isCurrent(revision, session, target)) return
      await track.setProcessor(this.processor)
    }
  }

  // 上下文不可用且处理器已挂载时先摘下，避免把失效的处理器留在采集链上。
  private async detachPipelineForUnavailableAudioContext(track: MicrophoneTrackPort) {
    const contextUnavailable = !this.options.isAudioContextAvailable()
    if (contextUnavailable && track.getProcessor() === this.processor) {
      await track.stopProcessor()
    }
  }

  private publishOptions(mode: VoiceTransmissionMode) {
    const settings = this.options.publishSettings()
    return {
      audioPreset: { maxBitrate: settings.audioBitrateKbps * 1000 },
      dtx: mode === 'voice-activity',
      red: settings.audioRedEnabled,
      forceStereo: false,
    }
  }

  private isCurrent(revision: number, session: number, target: MicrophonePublishTarget) {
    return revision === this.revision && session === this.session && target === this.target
  }

  // RNNoise 能力未就绪时的回退入口（处理器回调）。AudioWorklet 初始化可能
  // 在 setProcessor 释放轨道锁之前完成，延迟到 setTimeout(0) 再重建采集，
  // 同时保留处理器代际以拒绝迟到的回调。
  private handleRnnoiseUnavailable(isGenerationCurrent: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const target = this.target
      const session = this.session
      setTimeout(() => {
        if (!isGenerationCurrent() || !target || this.target !== target || this.session !== session) {
          resolve()
          return
        }
        void this.fallbackToSystemNoiseSuppression(target, session)
          .catch((error) => {
            if (this.target === target && this.session === session) {
              this.options.onError?.(
                `无法回退到系统降噪：${error instanceof Error ? error.message : String(error)}`,
                error,
              )
            }
            console.warn('RNNoise 回退到系统降噪失败', error)
          })
          .finally(resolve)
      }, 0)
    })
  }

  private async fallbackToSystemNoiseSuppression(target: MicrophonePublishTarget, session: number) {
    if (this.options.noiseSuppressionOption() !== 'rnnoise'
      || this.target !== target
      || this.session !== session
      || !target.localParticipant.isMicrophoneEnabled
      || !this.options.isSessionLive()) return
    this.rnnoiseFallback = true
    await this.republishPath(this.revision, session, target, this.options.transmissionMode(), true)
  }
}
