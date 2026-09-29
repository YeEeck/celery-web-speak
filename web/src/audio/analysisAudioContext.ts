// 分析图需要 AudioContext 才能跑 worklet / analyser，但不能打开扬声器。
// 接到 destination 即使 gain=0，只要上下文绑着默认输出，安卓上仍会占一条
// 播放流；16 kHz VAD 图会与 48 kHz 混音抢 HAL（ADR-0045）。
// MediaStreamDestination 只挡住图里的样本，AudioContext 照样打开输出设备。
// `{ sinkId: { type: 'none' } }` 让上下文在哑 destination 上调度，不打开硬件。

// 当前 TypeScript DOM 库的 AudioContextOptions 还没有 sinkId（Chrome 110+）。
interface AnalysisAudioContextOptions extends AudioContextOptions {
  sinkId?: string | { type: 'none' }
}

const NONE_SINK = { type: 'none' } as const

export function analysisAudioContextOptions(sampleRate?: number): AnalysisAudioContextOptions {
  return sampleRate === undefined ? { sinkId: NONE_SINK } : { sampleRate, sinkId: NONE_SINK }
}

export function analysisAudioContextFallbackOptions(sampleRate?: number): AudioContextOptions {
  return sampleRate === undefined ? {} : { sampleRate }
}

function defaultAudioContextConstructor(): typeof AudioContext | undefined {
  const global = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return global.AudioContext ?? global.webkitAudioContext
}

export function createAnalysisAudioContext(
  sampleRate?: number,
  ctor: typeof AudioContext | undefined = defaultAudioContextConstructor(),
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(analysisAudioContextOptions(sampleRate) as AudioContextOptions)
  } catch {
    try {
      return new ctor(analysisAudioContextFallbackOptions(sampleRate))
    } catch {
      return null
    }
  }
}
