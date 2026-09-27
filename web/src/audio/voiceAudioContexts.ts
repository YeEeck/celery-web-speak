// 语音 AudioContext 按能力分支，不按 OS（ADR-0045）。
// 媒体时钟是 48 kHz（Opus / RNNoise / 自动音量平衡标定）。
// 播放先请求 48 kHz + interactive（混音与 AGC 同图、低延迟）。
// 浏览器真给了 48 kHz：采集复用同一对象，RNNoise 与测声同一时钟。
// 给不出：播放保持这条原生混音图，RNNoise 另开 48 kHz balanced 图，
// 只接到 MediaStreamDestination，永不进扬声器。

export const CAPTURE_SAMPLE_RATE = 48_000

export interface VoiceAudioContextPair {
  playback: AudioContext | null
  capture: AudioContext | null
}

export function playbackAudioContextOptions(): AudioContextOptions {
  return { latencyHint: 'interactive', sampleRate: CAPTURE_SAMPLE_RATE }
}

export function captureAudioContextOptions(): AudioContextOptions {
  return { sampleRate: CAPTURE_SAMPLE_RATE, latencyHint: 'balanced' }
}

export function audioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

function createAudioContextWithOptions(
  ctor: typeof AudioContext | undefined,
  options: AudioContextOptions,
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(options)
  } catch {
    try {
      return new ctor()
    } catch {
      return null
    }
  }
}

export function createPlaybackAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor, playbackAudioContextOptions())
}

export function createCaptureAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor, captureAudioContextOptions())
}

export function createVoiceAudioContextPair(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): VoiceAudioContextPair {
  const playback = createAudioContextWithOptions(ctor, playbackAudioContextOptions())
  if (playback && playback.sampleRate === CAPTURE_SAMPLE_RATE) {
    return { playback, capture: playback }
  }
  return {
    playback,
    capture: createAudioContextWithOptions(ctor, captureAudioContextOptions()),
  }
}

export function isCaptureContextRnnoiseReady(context: AudioContext | null | undefined): boolean {
  return context !== null && context !== undefined && context.state !== 'closed' && context.sampleRate === CAPTURE_SAMPLE_RATE
}
