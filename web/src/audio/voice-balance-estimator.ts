// 自动音量平衡——估算器纯函数（seam 1）。
// 参数策略见 ADR-0026 与 spec：固定目标电平、±12dB 钳制（只作用于电平修正项，
// 手动偏置在钳制之外由合成层相乘）、快 attack / 慢 release、底噪冻结、0dB 起步。
// 控制率 5Hz（200ms），与 VoiceBalanceController 的轮询间隔一致。

export const VOICE_BALANCE_TARGET_DBFS = -20
export const VOICE_BALANCE_GAIN_CLAMP_DB = 12
export const VOICE_BALANCE_FLOOR_DBFS = -55
export const VOICE_BALANCE_ATTACK_TAU_S = 0.3
export const VOICE_BALANCE_RELEASE_TAU_S = 2.0
export const VOICE_BALANCE_CONTROL_INTERVAL_S = 0.2

// 静音帧（RMS=0）映射到底噪阈值之下，估算器自然冻结。
const SILENCE_DBFS = -100

export interface VoiceBalanceEstimateState {
  gainDb: number
}

export function createVoiceBalanceState(): VoiceBalanceEstimateState {
  return { gainDb: 0 }
}

// RMS（0~1）→ dBFS。静音帧映射到 SILENCE_DBFS，低于底噪阈值触发冻结。
export function rmsToDbFS(rms: number): number {
  return rms <= 0 ? SILENCE_DBFS : 20 * Math.log10(rms)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

// 一步估算：输入实测电平（dBFS），更新并返回该时刻的电平修正增益（dB）。
// 低于底噪阈值冻结（不泵不漂移，防无限放大底噪）；需要压降（说话变响）
// 走快 attack，需要回升（说话变轻）走慢 release。
export function estimateVoiceBalanceGain(
  state: VoiceBalanceEstimateState,
  levelDb: number,
  targetDb = VOICE_BALANCE_TARGET_DBFS,
): number {
  if (levelDb < VOICE_BALANCE_FLOOR_DBFS) return state.gainDb
  const desiredGainDb = clamp(targetDb - levelDb, -VOICE_BALANCE_GAIN_CLAMP_DB, VOICE_BALANCE_GAIN_CLAMP_DB)
  const tau = desiredGainDb < state.gainDb ? VOICE_BALANCE_ATTACK_TAU_S : VOICE_BALANCE_RELEASE_TAU_S
  const alpha = 1 - Math.exp(-VOICE_BALANCE_CONTROL_INTERVAL_S / tau)
  state.gainDb = clamp(
    state.gainDb + alpha * (desiredGainDb - state.gainDb),
    -VOICE_BALANCE_GAIN_CLAMP_DB,
    VOICE_BALANCE_GAIN_CLAMP_DB,
  )
  return state.gainDb
}

// 修正增益（dB）→ 线性系数，供合成层（applyVolume）相乘。
export function voiceBalanceGainLinear(gainDb: number): number {
  return 10 ** (gainDb / 20)
}
