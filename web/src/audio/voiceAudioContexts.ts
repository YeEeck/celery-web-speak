// 语音混音保持一条 48 kHz 图（ADR-0045）：webAudioMix、RNNoise、自动音量
// 平衡测声共用同一对象。桌面 latencyHint 仍是 interactive（v0.4.40）。
// 安卓改为 balanced，给欠载留缓冲；不拆采集/播放，不为断续改采样率。

export const CAPTURE_SAMPLE_RATE = 48_000

export interface VoiceAudioContextPair {
  playback: AudioContext | null
  capture: AudioContext | null
}

export interface AndroidVoiceClientHint {
  celeryShell?: unknown
  userAgent?: string
}

export function isAndroidVoiceClient(
  hint: AndroidVoiceClientHint = {
    celeryShell: typeof window !== 'undefined' ? window.celeryShell : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  },
): boolean {
  if (hint.celeryShell !== undefined) return true
  return /Android/i.test(hint.userAgent ?? '')
}

export function voiceMixLatencyHint(android = isAndroidVoiceClient()): AudioContextLatencyCategory {
  return android ? 'balanced' : 'interactive'
}

export function voiceAudioContextOptions(android = isAndroidVoiceClient()): AudioContextOptions {
  return { latencyHint: voiceMixLatencyHint(android), sampleRate: CAPTURE_SAMPLE_RATE }
}

export function voiceAudioContextFallbackOptions(android = isAndroidVoiceClient()): AudioContextOptions {
  return { latencyHint: voiceMixLatencyHint(android) }
}

export function audioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

function publishMixLatency(android: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.voiceMixLatency = voiceMixLatencyHint(android)
}

function createAudioContextWithOptions(
  ctor: typeof AudioContext | undefined,
  android = isAndroidVoiceClient(),
): AudioContext | null {
  if (!ctor) return null
  try {
    const context = new ctor(voiceAudioContextOptions(android))
    publishMixLatency(android)
    return context
  } catch {
    try {
      const context = new ctor(voiceAudioContextFallbackOptions(android))
      publishMixLatency(android)
      return context
    } catch {
      return null
    }
  }
}

export function createPlaybackAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
  android = isAndroidVoiceClient(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor, android)
}

export function createCaptureAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
  android = isAndroidVoiceClient(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor, android)
}

export function createVoiceAudioContextPair(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
  android = isAndroidVoiceClient(),
): VoiceAudioContextPair {
  const context = createAudioContextWithOptions(ctor, android)
  return { playback: context, capture: context }
}

export function isCaptureContextRnnoiseReady(context: AudioContext | null | undefined): boolean {
  return context !== null && context !== undefined && context.state !== 'closed' && context.sampleRate === CAPTURE_SAMPLE_RATE
}
