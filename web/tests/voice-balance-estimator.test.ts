// 自动音量平衡——估算器纯函数测试（seam 1）。
// 数学转正自原型 AGC 模拟器（web/prototype/agc-sim.test.ts，01 标定验证）。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VOICE_BALANCE_TARGET_DBFS,
  VOICE_BALANCE_GAIN_CLAMP_DB,
  VOICE_BALANCE_FLOOR_DBFS,
  createVoiceBalanceState,
  estimateVoiceBalanceGain,
  rmsToDbFS,
} from '../src/audio/voice-balance-estimator.ts'

function simulate(levels: number[], targetDb = VOICE_BALANCE_TARGET_DBFS, steps = 200) {
  const state = createVoiceBalanceState()
  const trajectory: number[] = []
  for (let i = 0; i < steps; i += 1) {
    trajectory.push(estimateVoiceBalanceGain(state, levels[Math.min(i, levels.length - 1)], targetDb))
  }
  return trajectory
}

function assertConverged(trajectory: number[], expectedDb: number, toleranceDb: number, label: string) {
  const last = trajectory[trajectory.length - 1]
  assert.ok(Math.abs(last - expectedDb) <= toleranceDb, `${label}: 末值 ${last.toFixed(2)}dB，期望 ${expectedDb}±${toleranceDb}dB`)
}

test('新状态从 0dB 中性增益起步', () => {
  assert.equal(createVoiceBalanceState().gainDb, 0)
})

test('稳态大声说话收敛到目标（增益≈目标-电平）', () => {
  const trajectory = simulate([-12]) // 稳态 -12dBFS，10s
  assertConverged(trajectory, VOICE_BALANCE_TARGET_DBFS - -12, 0.5, '大声说话')
  assert.ok(Math.abs(-12 + trajectory.at(-1)! - VOICE_BALANCE_TARGET_DBFS) < 0.5)
})

test('稳态轻声说话同样收敛到目标', () => {
  const trajectory = simulate([-30])
  assertConverged(trajectory, VOICE_BALANCE_TARGET_DBFS - -30, 0.5, '轻声说话')
})

test('增益钳制 ±12dB：极响不无限压、极静不无限抬', () => {
  const loud = simulate([-5]) // 需要 -15dB，钳到 -12
  assertConverged(loud, -VOICE_BALANCE_GAIN_CLAMP_DB, 0.01, '极响')
  const quiet = simulate([-45]) // 需要 +25dB，钳到 +12
  assertConverged(quiet, VOICE_BALANCE_GAIN_CLAMP_DB, 0.01, '极静')
})

test('底噪冻结：低于阈值不调增益（不漂向 +12dB 放大底噪）', () => {
  const state = createVoiceBalanceState()
  estimateVoiceBalanceGain(state, -12, VOICE_BALANCE_TARGET_DBFS)
  estimateVoiceBalanceGain(state, -12, VOICE_BALANCE_TARGET_DBFS)
  const settled = state.gainDb
  for (let i = 0; i < 100; i += 1) estimateVoiceBalanceGain(state, VOICE_BALANCE_FLOOR_DBFS - 5, VOICE_BALANCE_TARGET_DBFS)
  assert.equal(state.gainDb, settled, '静音期间增益必须保持冻结')
})

test('快 attack 慢 release：压降 1s 内完成，回升远慢于压降', () => {
  // 稳态 -12dBFS（增益 ≈ -8）→ 突变为 -4dBFS（需要 -16，钳 -12）
  const state = createVoiceBalanceState()
  for (let i = 0; i < 200; i += 1) estimateVoiceBalanceGain(state, -12, VOICE_BALANCE_TARGET_DBFS)
  const steady = state.gainDb
  for (let i = 0; i < 5; i += 1) estimateVoiceBalanceGain(state, -4, VOICE_BALANCE_TARGET_DBFS) // 1s（5 步 @200ms）
  const afterAttack = state.gainDb
  assert.ok(afterAttack <= -10, `attack 1s 后应接近钳制：${afterAttack.toFixed(2)}`)
  for (let i = 0; i < 5; i += 1) estimateVoiceBalanceGain(state, -12, VOICE_BALANCE_TARGET_DBFS) // 1s
  const afterOneSecRelease = state.gainDb
  const attacked = steady - afterAttack
  const recovered = afterOneSecRelease - afterAttack
  assert.ok(recovered > 0, 'release 开始回升')
  assert.ok(recovered < attacked * 0.5, `release 1s 回升 ${recovered.toFixed(2)}dB 应显著慢于 attack 的 ${attacked.toFixed(2)}dB`)
})

test('标定原则：目标取典型电平 → 典型说话者增益≈0dB', () => {
  const typicalLevelDb = 20 * Math.log10(0.19)
  const trajectory = simulate([typicalLevelDb], typicalLevelDb)
  assertConverged(trajectory, 0, 0.5, '典型电平增益')
})

test('两人差异平衡：-30dBFS 与 -12dBFS 输出电平差收敛到 0', () => {
  const quiet = createVoiceBalanceState()
  const loud = createVoiceBalanceState()
  for (let i = 0; i < 200; i += 1) {
    estimateVoiceBalanceGain(quiet, -30, VOICE_BALANCE_TARGET_DBFS)
    estimateVoiceBalanceGain(loud, -12, VOICE_BALANCE_TARGET_DBFS)
  }
  const quietOut = -30 + quiet.gainDb
  const loudOut = -12 + loud.gainDb
  assert.ok(Math.abs(quietOut - loudOut) < 0.5, `输出差 ${(quietOut - loudOut).toFixed(2)}dB 应≈0`)
})

test('rmsToDbFS：静音帧映射到底噪下限以下、幅度映射到 dBFS', () => {
  assert.equal(rmsToDbFS(0), -100)
  assert.equal(rmsToDbFS(0.1), -20)
  assert.ok(rmsToDbFS(0.377) > VOICE_BALANCE_FLOOR_DBFS)
  assert.ok(rmsToDbFS(0.377) < -8) // 01 标定：fixture 语音峰值 ≈ -8.5dBFS
})
