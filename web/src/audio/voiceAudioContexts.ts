// 播放与采集拆开的 AudioContext 工厂（ADR-0045）。
// 播放走设备原生采样率；安卓用更大缓冲，避免 interactive + 强制 48 kHz 欠载。
// 采集/RNNoise 单独 48 kHz，只接到 MediaStreamDestination，永不进扬声器。
// 安卓采集同样用 balanced：RNNoise WASM 在 audio thread 上超出 interactive
// 预算时，对端会听到掉字和炸音。

export const CAPTURE_SAMPLE_RATE = 48_000

export interface VoiceAudioEnvironment {
  celeryShell?: unknown
  userAgent: string
}

export function isAndroidVoiceClient(env: VoiceAudioEnvironment): boolean {
  return env.celeryShell !== undefined || /Android/i.test(env.userAgent)
}

export function playbackAudioContextOptions(android: boolean): AudioContextOptions {
  return { latencyHint: android ? 'balanced' : 'interactive' }
}

export function captureAudioContextOptions(android: boolean): AudioContextOptions {
  return {
    sampleRate: CAPTURE_SAMPLE_RATE,
    latencyHint: android ? 'balanced' : 'interactive',
  }
}

export function browserVoiceAudioEnvironment(): VoiceAudioEnvironment {
  return {
    celeryShell: window.celeryShell,
    userAgent: navigator.userAgent,
  }
}

export function audioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

export function createPlaybackAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
  env: VoiceAudioEnvironment = browserVoiceAudioEnvironment(),
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(playbackAudioContextOptions(isAndroidVoiceClient(env)))
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
  env: VoiceAudioEnvironment = browserVoiceAudioEnvironment(),
): AudioContext | null {
  if (!ctor) return null
  try {
    return new ctor(captureAudioContextOptions(isAndroidVoiceClient(env)))
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
