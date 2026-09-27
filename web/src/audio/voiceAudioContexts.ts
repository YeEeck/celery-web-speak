// 播放与采集 AudioContext 工厂（ADR-0045）。
// 安卓：播放用设备原生采样率 + balanced；采集/RNNoise 单独 48 kHz + balanced。
// 桌面：混音与 RNNoise 共用一条 48 kHz interactive 图（0.4.41 之前的拓扑）。
// 0.4.43 把桌面播放也改成 balanced 且保持拆分，听感断续仍在，AGC 还忽大忽小。

export const CAPTURE_SAMPLE_RATE = 48_000

export interface VoiceAudioEnvironment {
  celeryShell?: unknown
  userAgent: string
}

export interface VoiceAudioContextPair {
  playback: AudioContext | null
  capture: AudioContext | null
}

export function isAndroidVoiceClient(env: VoiceAudioEnvironment): boolean {
  return env.celeryShell !== undefined || /Android/i.test(env.userAgent)
}

export function playbackAudioContextOptions(android: boolean): AudioContextOptions {
  return android
    ? { latencyHint: 'balanced' }
    : { latencyHint: 'interactive', sampleRate: CAPTURE_SAMPLE_RATE }
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
  env: VoiceAudioEnvironment = browserVoiceAudioEnvironment(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor, playbackAudioContextOptions(isAndroidVoiceClient(env)))
}

export function createCaptureAudioContext(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
  env: VoiceAudioEnvironment = browserVoiceAudioEnvironment(),
): AudioContext | null {
  return createAudioContextWithOptions(ctor, captureAudioContextOptions(isAndroidVoiceClient(env)))
}

export function createVoiceAudioContextPair(
  ctor: typeof AudioContext | undefined = audioContextConstructor(),
  env: VoiceAudioEnvironment = browserVoiceAudioEnvironment(),
): VoiceAudioContextPair {
  const android = isAndroidVoiceClient(env)
  const playback = createAudioContextWithOptions(ctor, playbackAudioContextOptions(android))
  if (!android && playback && playback.sampleRate === CAPTURE_SAMPLE_RATE) {
    return { playback, capture: playback }
  }
  return {
    playback,
    capture: createAudioContextWithOptions(ctor, captureAudioContextOptions(android)),
  }
}

export function isCaptureContextRnnoiseReady(context: AudioContext | null | undefined): boolean {
  return context !== null && context !== undefined && context.state !== 'closed' && context.sampleRate === CAPTURE_SAMPLE_RATE
}
