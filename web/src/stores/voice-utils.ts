import type { Participant } from 'livekit-client'
import { Track } from 'livekit-client'
import type { GuildRole, User } from '../types'
import type { ApplicationAudioError, ApplicationAudioSnapshot } from '../audio/applicationAudioBridge'

export const DEFAULT_VOLUME = 1
export const MAX_VOLUME = 3
export const MICROPHONE_GAIN_KEY = 'cws.microphoneGain'
export const OUTPUT_VOLUME_KEY = 'cws.outputVolume'
export const DEAFENED_ATTRIBUTE = 'deafened'
export const ECHO_CANCELLATION_KEY = 'cws.echoCancellation'
export const NOISE_SUPPRESSION_KEY = 'cws.noiseSuppression'
export const TRANSMISSION_MODE_KEY = 'cws.voiceTransmissionMode'
export const APPLICATION_AUDIO_VOLUME_KEY = 'cws.applicationAudioVolume'
export const APPLICATION_AUDIO_DEFAULT_VOLUME = 0.5
export const APPLICATION_AUDIO_PORT_TIMEOUT_MS = 10_000
export const DEFAULT_AUDIO_BITRATE_KBPS = 64

export type VoiceTransmissionMode = 'voice-activity' | 'continuous'

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

export function getSavedPreMuteVolume(key: string) {
  const saved = localStorage.getItem(key)
  if (saved === null) return DEFAULT_VOLUME
  return clampVolume(Number(saved))
}

export function getSavedBoolean(key: string, defaultValue: boolean) {
  const saved = localStorage.getItem(key)
  if (saved === null) return defaultValue
  return saved !== 'false'
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
