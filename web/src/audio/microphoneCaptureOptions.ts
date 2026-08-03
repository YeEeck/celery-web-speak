export interface MicrophoneCapturePreferences {
  deviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
}

export function buildMicrophoneCaptureOptions(preferences: MicrophoneCapturePreferences) {
  return {
    deviceId: preferences.deviceId,
    echoCancellation: preferences.echoCancellation,
    noiseSuppression: preferences.noiseSuppression,
    autoGainControl: true,
    // LiveKit 的 audioCaptureDefaults 默认请求 voiceIsolation: true（浏览器 AI
    // 语音隔离预处理）。它游离于"降噪选项"三值语义之外（用户选"关闭"时仍在
    // 隔离），且与 RNNoise/WebRTC 形成不可控的双重降噪，会干扰 RNNoise 的 VAD。
    // 降噪完全交给"降噪选项"管辖，显式声明浏览器不做这层处理。
    voiceIsolation: false,
    channelCount: 1,
  }
}
