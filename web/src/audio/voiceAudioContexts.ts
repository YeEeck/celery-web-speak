// 语音混音保持一条 48 kHz balanced 图（ADR-0045）：webAudioMix、RNNoise、
// 自动音量平衡测声共用同一对象。低延迟不是产品需求；interactive 在安卓上
// 欠载顿卡。不按 OS 分支，不拆采集/播放，不为断续改采样率。

export const CAPTURE_SAMPLE_RATE = 48_000
export const VOICE_MIX_LATENCY_HINT: AudioContextLatencyCategory = 'balanced'

export interface VoiceAudioContextPair {
  playback: AudioContext | null
  capture: AudioContext | null
}

export function voiceAudioContextOptions(): AudioContextOptions {
  return { latencyHint: VOICE_MIX_LATENCY_HINT, sampleRate: CAPTURE_SAMPLE_RATE }
}

export function voiceAudioContextFallbackOptions(): AudioContextOptions {
  return { latencyHint: VOICE_MIX_LATENCY_HINT }
}

export function audioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

function publishMixLatency() {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.voiceMixLatency = VOICE_MIX_LATENCY_HINT
}

function createAudioContextWithOptions(
  ctor: typeof AudioContext | undefined,
): AudioContext | null {
  if (!ctor) return null
  try {
    const context = new ctor(voiceAudioContextOptions())
    publishMixLatency()
    return context
  } catch {
    try {
      const context = new ctor(voiceAudioContextFallbackOptions())
      publishMixLatency()
      return context
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
