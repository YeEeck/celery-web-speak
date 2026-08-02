import type { Participant } from 'livekit-client'
import { Track } from 'livekit-client'
import type { GuildRole, User } from '../types'
import type { ApplicationAudioError, ApplicationAudioSnapshot } from '../audio/applicationAudioBridge'

export const DEFAULT_VOLUME = 1
export const MAX_VOLUME = 3
export const MICROPHONE_GAIN_KEY = 'cws.microphoneGain'
export const OUTPUT_VOLUME_KEY = 'cws.outputVolume'
export const MICROPHONE_ENABLED_KEY = 'cws.microphoneEnabled'
export const DEAFENED_PREFERENCE_KEY = 'cws.deafened'
export const PREFERRED_INPUT_DEVICE_KEY = 'cws.preferredInputDevice'
export const PREFERRED_OUTPUT_DEVICE_KEY = 'cws.preferredOutputDevice'
export const DEFAULT_DEVICE_ID = 'default'
export const DEAFENED_ATTRIBUTE = 'deafened'
export const ECHO_CANCELLATION_KEY = 'cws.echoCancellation'
export const NOISE_SUPPRESSION_KEY = 'cws.noiseSuppression'
export const MUTED_SPEAKING_REMINDER_KEY = 'cws.mutedSpeakingReminder.enabled'
export const TRANSMISSION_MODE_KEY = 'cws.voiceTransmissionMode'
export const APPLICATION_AUDIO_VOLUME_KEY = 'cws.applicationAudioVolume'
export const APPLICATION_AUDIO_DEFAULT_VOLUME = 0.5
export const APPLICATION_AUDIO_PORT_TIMEOUT_MS = 10_000
export const DEFAULT_AUDIO_BITRATE_KBPS = 64

export type VoiceTransmissionMode = 'voice-activity' | 'continuous'

export type NoiseSuppressionOption = 'off' | 'webrtc' | 'rnnoise'
export const DEFAULT_NOISE_SUPPRESSION_OPTION: NoiseSuppressionOption = 'rnnoise'

// 降噪选项复用旧的 cws.noiseSuppression 键：旧布尔值（true→增强降噪、false→关闭）
// 在读取时一次性迁移，写入后即为枚举字符串。
export function parseNoiseSuppressionOption(saved: string | null): NoiseSuppressionOption {
  if (saved === 'off' || saved === 'webrtc' || saved === 'rnnoise') return saved
  if (saved === 'true') return 'rnnoise'
  if (saved === 'false') return 'off'
  return DEFAULT_NOISE_SUPPRESSION_OPTION
}

export function getSavedNoiseSuppressionOption(): NoiseSuppressionOption {
  return parseNoiseSuppressionOption(localStorage.getItem(NOISE_SUPPRESSION_KEY))
}

export function saveNoiseSuppressionOption(option: NoiseSuppressionOption) {
  localStorage.setItem(NOISE_SUPPRESSION_KEY, option)
}

// 选项与 RNNoise 管线能力合成 WebRTC 约束值：增强降噪启用时由管线承担降噪，
// WebRTC 约束关闭避免双重降噪；管线能力不可用时按回退链视作系统降噪（约束开启）。
export function resolveNoiseSuppression(option: NoiseSuppressionOption, rnnoiseAvailable: boolean): boolean {
  if (option === 'off') return false
  if (option === 'webrtc') return true
  return !rnnoiseAvailable
}

export interface VoiceDevicePreference {
  deviceId: string
  label: string
}

export interface VoiceDeviceOption extends VoiceDevicePreference {
  unavailable: boolean
  current: boolean
}

export interface VoiceParticipant {
  identity: string
  userId: number
  name: string
  isLocal: boolean
  isSpeaking: boolean
  microphoneEnabled: boolean
  backgroundAudioAvailable: boolean
  backgroundAudioPlaying: boolean
  deafened: boolean
  quality: import('livekit-client').ConnectionQuality
  microphoneVolume: number
  backgroundAudioVolume: number
  microphoneMuted: boolean
  backgroundAudioMuted: boolean
  role: GuildRole
  joinedAt: number | null
}

export function defaultConnectedPublishSettings() {
  return {
    audioBitrateKbps: DEFAULT_AUDIO_BITRATE_KBPS,
    backgroundAudioBitrateKbps: 128,
    audioRedEnabled: true,
    backgroundAudioRedEnabled: false,
  }
}

export function clampVolume(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_VOLUME, value)) : DEFAULT_VOLUME
}

export function getSavedLevel(key: string) {
  const saved = localStorage.getItem(key)
  if (saved === null) return DEFAULT_VOLUME
  return clampVolume(Number(saved))
}

export function getSavedMuted(key: string) {
  return localStorage.getItem(key) === 'true'
}

export function getSavedBoolean(key: string, defaultValue: boolean) {
  const saved = localStorage.getItem(key)
  if (saved === null) return defaultValue
  return saved !== 'false'
}

export function saveBoolean(key: string, value: boolean) {
  localStorage.setItem(key, String(value))
}

export function getSavedDevicePreference(key: string): VoiceDevicePreference {
  const saved = localStorage.getItem(key)
  if (!saved) return { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' }
  try {
    const value = JSON.parse(saved) as Partial<VoiceDevicePreference>
    if (typeof value.deviceId === 'string' && value.deviceId) {
      return { deviceId: value.deviceId, label: typeof value.label === 'string' && value.label ? value.label : '未知设备' }
    }
  } catch {
    // Ignore malformed browser-local preferences.
  }
  return { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' }
}

export function saveDevicePreference(key: string, preference: VoiceDevicePreference) {
  localStorage.setItem(key, JSON.stringify(preference))
}

export function buildVoiceDeviceOptions(
  devices: MediaDeviceInfo[],
  kind: 'input' | 'output',
  preferred: VoiceDevicePreference,
  currentDeviceId: string,
  hasCurrentDevice: boolean,
): VoiceDeviceOption[] {
  const defaultOption: VoiceDeviceOption = {
    deviceId: DEFAULT_DEVICE_ID,
    label: '系统默认',
    unavailable: false,
    current: hasCurrentDevice && (!currentDeviceId || currentDeviceId === DEFAULT_DEVICE_ID),
  }
  const visibleDevices = devices.filter((device) => device.deviceId && device.deviceId !== DEFAULT_DEVICE_ID)
  let unnamedCount = 0
  const baseLabels = visibleDevices.map((device) => {
    const label = device.label.trim()
    if (label) return label
    unnamedCount += 1
    return `${kind === 'input' ? '麦克风' : '输出设备'} ${unnamedCount}`
  })
  const labelOccurrences = new Map<string, number>()
  const available = visibleDevices.map((device, index): VoiceDeviceOption => {
    const baseLabel = baseLabels[index]!
    const occurrence = (labelOccurrences.get(baseLabel) ?? 0) + 1
    labelOccurrences.set(baseLabel, occurrence)
    return {
      deviceId: device.deviceId,
      label: occurrence === 1 ? baseLabel : `${baseLabel}（${occurrence}）`,
      unavailable: false,
      current: hasCurrentDevice && currentDeviceId === device.deviceId,
    }
  })
  const preferredAvailable = preferred.deviceId === DEFAULT_DEVICE_ID || available.some((option) => option.deviceId === preferred.deviceId)
  if (!preferredAvailable) {
    available.unshift({ ...preferred, label: preferred.label || '未知设备', unavailable: true, current: false })
  }
  return [defaultOption, ...available]
}

export function getSavedTransmissionMode(): VoiceTransmissionMode {
  return localStorage.getItem(TRANSMISSION_MODE_KEY) === 'continuous' ? 'continuous' : 'voice-activity'
}

export function saveTransmissionMode(mode: VoiceTransmissionMode) {
  localStorage.setItem(TRANSMISSION_MODE_KEY, mode)
}

export function getSavedApplicationAudioVolume() {
  const saved = localStorage.getItem(APPLICATION_AUDIO_VOLUME_KEY)
  if (saved === null) return APPLICATION_AUDIO_DEFAULT_VOLUME
  return clampApplicationAudioVolume(Number(saved))
}

export function clampApplicationAudioVolume(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : APPLICATION_AUDIO_DEFAULT_VOLUME
}

export function isBackgroundAudioPlaying(participant: Participant) {
  const publication = participant.getTrackPublication(Track.Source.ScreenShareAudio)
  return Boolean(publication && !publication.isMuted)
}

export function hasBackgroundAudio(participant: Participant) {
  return Boolean(participant.getTrackPublication(Track.Source.ScreenShareAudio))
}

export function isSourcePickerCancellation(snapshot: ApplicationAudioSnapshot) {
  return snapshot.error?.code === 'source_picker_cancelled' || (snapshot.state === 'idle' && !snapshot.sessionId)
}

export function applicationAudioSnapshotError(snapshot: ApplicationAudioSnapshot, fallback: string) {
  return snapshot.error ?? new Error(fallback)
}

export function applicationAudioErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (isApplicationAudioError(error) && error.message) return error.message
  return '应用背景音操作失败，请重新选择'
}

export function isApplicationAudioError(value: unknown): value is ApplicationAudioError {
  return typeof value === 'object' && value !== null && typeof (value as ApplicationAudioError).code === 'string'
    && typeof (value as ApplicationAudioError).message === 'string'
}

export function compareParticipants(a: VoiceParticipant, b: VoiceParticipant, users: User[]) {
  const roleDifference = roleRank(currentRole(b, users)) - roleRank(currentRole(a, users))
  if (roleDifference !== 0) return roleDifference
  if (a.joinedAt !== null && b.joinedAt !== null && a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt
  return a.userId - b.userId || a.identity.localeCompare(b.identity)
}

export function currentRole(participant: VoiceParticipant, users: User[]): GuildRole {
  const role = users.find((user) => user.id === participant.userId)?.role ?? participant.role
  return role === 'owner' || role === 'admin' ? role : 'member'
}

export function roleRank(role: GuildRole) {
  if (role === 'owner') return 2
  if (role === 'admin') return 1
  return 0
}

export function participantRole(participant: Participant): GuildRole {
  const role = participant.attributes.role
  return role === 'owner' || role === 'admin' ? role : 'member'
}

export function participantJoinedAt(participant: Participant): number | null {
  const timestamp = participant.joinedAt?.getTime()
  return timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : null
}

export async function setAudioSink(element: HTMLAudioElement, deviceId: string) {
  const sinkElement = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (sinkElement.setSinkId) await sinkElement.setSinkId(deviceId)
}

export function participantUserId(participant: Participant): number {
  const fromAttribute = Number(participant.attributes.user_id)
  if (Number.isFinite(fromAttribute) && fromAttribute > 0) return fromAttribute
  const match = participant.identity.match(/^user-(\d+)$/)
  return match ? Number(match[1]) : 0
}

export function getSavedVolume(userId: number): number {
  return getSavedLevel(`cws.volume.${userId}`)
}

export function getSavedBackgroundAudioVolume(userId: number): number {
  return getSavedLevel(`cws.backgroundAudioVolume.${userId}`)
}
