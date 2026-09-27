// 播放与采集拆开的 AudioContext 工厂（ADR-0045）。
// 播放走设备原生采样率；采集/RNNoise / 背景音单独 48 kHz，只接到
// MediaStreamDestination，永不进扬声器。长驻语音图一律 balanced：
// interactive（约 128 帧 / ~2.7ms）不够 RNNoise WASM 与背景音 worklet 用。

export const CAPTURE_SAMPLE_RATE = 48_000
export const VOICE_GRAPH_LATENCY: AudioContextLatencyCategory = 'balanced'

export function playbackAudioContextOptions(): AudioContextOptions {
  return { latencyHint: VOICE_GRAPH_LATENCY }
}

export function captureAudioContextOptions(): AudioContextOptions {
  return {
    sampleRate: CAPTURE_SAMPLE_RATE,
    latencyHint: VOICE_GRAPH_LATENCY,
  }
}

export function audioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

export function createPlaybackAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(playbackAudioContextOptions())
  } catch {
    try {
      return new ctor()
    } catch {
      return null
    }
  }
}

export function createCaptureAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(captureAudioContextOptions())
  } catch {
    try {
      return new ctor()
    } catch {
      return null
    }
  }
}

export function isCaptureContextRnnoiseReady(context: AudioContext | null | undefined): boolean {
  return context !== null && context !== undefined && context.state !== 'closed' && context.sampleRate === CAPTURE_SAMPLE_RATE
}
