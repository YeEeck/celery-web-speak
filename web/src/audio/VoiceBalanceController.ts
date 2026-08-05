// 自动音量平衡——控制器（管线层，seam 4）：经 SDK 实验扩展点
// setWebAudioPlugins 在每个远端麦克风轨道的手动增益之前插入 analyser，
// 5Hz 轮询实测电平，驱动估算器（voice-balance-estimator.ts 纯函数），
// 修正系数变化时回调会话层（onChange → applyVolume）。开关关闭或无共享
// AudioContext 时全量摘除、零开销。
import { RemoteAudioTrack } from 'livekit-client'
import {
  createVoiceBalanceState,
  estimateVoiceBalanceGain,
  rmsToDbFS,
  voiceBalanceGainLinear,
  type VoiceBalanceEstimateState,
} from './voice-balance-estimator.ts'

const POLL_INTERVAL_MS = 200
// 增益线性值变化 ≥0.001（≈0.009dB）才回调，避免每 tick 都触发合成。
const GAIN_CHANGE_EPSILON = 0.001

export interface VoiceBalanceSource {
  userId: number
  track: RemoteAudioTrack
}

interface BalancedParticipant {
  userId: number
  track: RemoteAudioTrack
  analyser: AnalyserNode
  samples: Float32Array<ArrayBuffer>
  state: VoiceBalanceEstimateState
}

interface VoiceBalanceControllerOptions {
  // 共享 AudioContext（SDK webAudioMix 所在上下文）；analyser 必须建在
  // 与播放链相同的上下文里。join 前/离开后为 null。
  getAudioContext: () => AudioContext | null
  enabled: () => boolean
  // 修正系数变化回调（线性变化超 epsilon 时），会话层接到现有 applyVolume。
  onChange: (userId: number) => void
}

export class VoiceBalanceController {
  private participants = new Map<number, BalancedParticipant>()
  private timer: number | null = null
  private readonly options: VoiceBalanceControllerOptions

  constructor(options: VoiceBalanceControllerOptions) {
    this.options = options
  }

  sync(sources: VoiceBalanceSource[]) {
    const context = this.options.enabled() ? this.options.getAudioContext() : null
    const userIds = new Set(context ? sources.map((source) => source.userId) : [])
    for (const userId of [...this.participants.keys()]) {
      if (!userIds.has(userId)) this.remove(userId)
    }
    if (context) {
      for (const source of sources) {
        const existing = this.participants.get(source.userId)
        if (existing?.track === source.track) continue
        if (existing) this.remove(source.userId)
        this.add(context, source)
      }
    }
    if (this.participants.size && this.timer === null) {
      this.timer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS)
    } else if (!this.participants.size && this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  // 当前修正增益（dB）；未跟踪该参与者（未平衡）时为 null。
  gainDbOf(userId: number): number | null {
    return this.participants.get(userId)?.state.gainDb ?? null
  }

  // 当前修正增益（线性），未跟踪时为 1（合成层乘 1 即旧行为）。
  gainOf(userId: number): number {
    const gainDb = this.gainDbOf(userId)
    return gainDb === null ? 1 : voiceBalanceGainLinear(gainDb)
  }

  destroy() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    for (const userId of [...this.participants.keys()]) this.remove(userId)
  }

  private add(context: AudioContext, source: VoiceBalanceSource) {
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    // 插件位位于播放链手动增益之前（ADR-0026，01 原型验证：setVolume 不变性）。
    source.track.setWebAudioPlugins([analyser])
    this.participants.set(source.userId, {
      userId: source.userId,
      track: source.track,
      analyser,
      samples: new Float32Array(analyser.fftSize),
      state: createVoiceBalanceState(),
    })
  }

  private remove(userId: number) {
    const participant = this.participants.get(userId)
    if (!participant) return
    // 清空插件让链路退回纯 gain；轨道已 detached 时仅清数组，安全无操作。
    participant.track.setWebAudioPlugins([])
    this.participants.delete(userId)
  }

  private poll() {
    for (const participant of this.participants.values()) {
      const previousLinear = voiceBalanceGainLinear(participant.state.gainDb)
      participant.analyser.getFloatTimeDomainData(participant.samples)
      let energy = 0
      for (const sample of participant.samples) energy += sample * sample
      const levelDb = rmsToDbFS(Math.sqrt(energy / participant.samples.length))
      estimateVoiceBalanceGain(participant.state, levelDb)
      if (Math.abs(voiceBalanceGainLinear(participant.state.gainDb) - previousLinear) >= GAIN_CHANGE_EPSILON) {
        this.options.onChange(participant.userId)
      }
    }
  }
}
