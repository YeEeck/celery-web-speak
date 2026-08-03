export interface MicrophoneCapturePreferences {
  deviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
}

export function buildMicrophoneCaptureOptions(preferences: MicrophoneCapturePreferences) {
  return {
    // deviceId 一律以 {exact} 传入：Chromium 以字符串（ideal）传 'default' 时
    // 可能解析到错误的默认设备（实测落到静音源），{exact: 'default'} 才解析到
    // 操作系统默认输入；与 VAD 引擎采集同一语义。
    deviceId: { exact: preferences.deviceId },
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
