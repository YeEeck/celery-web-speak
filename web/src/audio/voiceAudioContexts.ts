// 语音混音时钟保持 v0.4.40（ADR-0045）：一条 48 kHz interactive 图，
// webAudioMix、RNNoise、自动音量平衡测声共用。浏览器拒绝显式采样率时
// 退回 interactive、不锁 sampleRate。不按 OS 拆图，不为断续改这条时钟。

export const CAPTURE_SAMPLE_RATE = 48_000

export interface VoiceAudioContextPair {
  playback: AudioContext | null
  capture: AudioContext | null
}

export function voiceAudioContextOptions(): AudioContextOptions {
  return { latencyHint: 'interactive', sampleRate: CAPTURE_SAMPLE_RATE }
}

export function voiceAudioContextFallbackOptions(): AudioContextOptions {
  return { latencyHint: 'interactive' }
}

export function audioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

function createAudioContextWithOptions(
  ctor: typeof AudioContext | undefined,
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(voiceAudioContextOptions())
  } catch {
    try {
      return new ctor(voiceAudioContextFallbackOptions())
    } catch {
      return null
    }
  }
}

export function createPlaybackAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor)
}

export function createCaptureAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor)
}

export function createVoiceAudioContextPair(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
): VoiceAudioContextPair {
  const context = createAudioContextWithOptions(ctor)
  return { playback: context, capture: context }
}

export function isCaptureContextRnnoiseReady(context: AudioContext | null | undefined): boolean {
  return context !== null && context !== undefined && context.state !== 'closed' && context.sampleRate === CAPTURE_SAMPLE_RATE
}
