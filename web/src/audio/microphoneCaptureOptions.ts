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
    channelCount: 1,
  }
}
