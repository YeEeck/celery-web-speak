// 降噪测量 fixture：确定性的合成音频样本，由 Chromium 假麦克风文件捕获
// （--use-file-for-fake-audio-capture）循环播放，作为全链路降噪测量的输入。
// 本模块同时被 playwright.config.ts（生成 WAV）与 noise-suppression.spec.ts
// （分析）使用，保证"输入参考"与磁盘文件严格一致。

export const FIXTURE_SAMPLE_RATE = 48_000

export const FIXTURE_SEGMENTS = {
  warmup: 2,
  noise: 4,
  speech: 4,
  pulse: 4,
} as const

export const FIXTURE_LOOP_SECONDS = FIXTURE_SEGMENTS.warmup + FIXTURE_SEGMENTS.noise + FIXTURE_SEGMENTS.speech + FIXTURE_SEGMENTS.pulse

// 分析窗口（相对循环起点、段内取中段，避开段边界与预热区）。
export const FIXTURE_WINDOWS = {
  noise: [3.0, 5.8],
  speech: [7.0, 9.8],
  pulse: [11.0, 13.8],
} as const

// 确定性 PRNG（mulberry32），保证每次生成完全一致。
function makeRandom(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 生成一个循环周期的单声道样本（Float32，48kHz）。
export function generateFixtureFrames(): Float32Array {
  const frames = new Float32Array(FIXTURE_LOOP_SECONDS * FIXTURE_SAMPLE_RATE)
  const random = makeRandom(0xC0FFEE)
  const { warmup, noise, speech, pulse } = FIXTURE_SEGMENTS

  for (let i = 0; i < frames.length; i++) {
    const t = i / FIXTURE_SAMPLE_RATE
    const loopTime = t % FIXTURE_LOOP_SECONDS
    let value = 0
    if (loopTime < warmup || loopTime < warmup + noise) {
      // 风扇类稳态噪声：白噪声 + 100Hz 电源嗡声。
      value = (random() * 2 - 1) * 0.12 + Math.sin(2 * Math.PI * 100 * loopTime) * 0.05
    } else if (loopTime < warmup + noise + speech) {
      // 模拟语音：220Hz 载波 × 4Hz 幅度调制，外加低噪底。
      value = Math.sin(2 * Math.PI * 220 * loopTime) * Math.sin(2 * Math.PI * 4 * loopTime) * 0.4
      value += (random() * 2 - 1) * 0.004
    } else {
      // 键盘类脉冲噪声：短促敲击簇 + 低噪底。
      const pulseTime = loopTime - (warmup + noise + speech)
      const inCluster = Math.floor(pulseTime / 0.55) % 2 === 0
      if (inCluster) {
        const inClick = (pulseTime % 0.55) % 0.14 < 0.012
        if (inClick) {
          const clickLocal = (pulseTime % 0.55) % 0.14
          const click = Math.exp(-clickLocal * 260) * Math.sin(2 * Math.PI * 1800 * clickLocal)
          value = click * 0.35
        }
      }
      value += (random() * 2 - 1) * 0.004
    }
    frames[i] = value
  }
  return frames
}

export function framesToWav(frames: Float32Array): Buffer {
  const buffer = Buffer.alloc(44 + frames.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + frames.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(FIXTURE_SAMPLE_RATE, 24)
  buffer.writeUInt32LE(FIXTURE_SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames.length * 2, 40)
  for (let i = 0; i < frames.length; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(frames[i] * 32767))), 44 + i * 2)
  }
  return buffer
}
