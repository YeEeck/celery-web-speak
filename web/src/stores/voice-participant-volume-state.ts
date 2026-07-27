export type ParticipantAudioKind = 'microphone' | 'backgroundAudio'

export interface ParticipantAudioState {
  microphoneVolume: number
  backgroundAudioVolume: number
  microphoneMuted: boolean
  backgroundAudioMuted: boolean
}

export function setParticipantTrackVolume(storage: Storage, userId: number, participant: ParticipantAudioState | undefined, kind: ParticipantAudioKind, volume: number) {
  storage.setItem(volumeKey(userId, kind), String(volume))
  if (!participant) return
  if (kind === 'microphone') participant.microphoneVolume = volume
  else participant.backgroundAudioVolume = volume
}

export function toggleParticipantTrackMuted(storage: Storage, userId: number, participant: ParticipantAudioState, kind: ParticipantAudioKind) {
  if (kind === 'microphone') {
    participant.microphoneMuted = !participant.microphoneMuted
    persistMuted(storage, userId, kind, participant.microphoneMuted)
    return
  }
  participant.backgroundAudioMuted = !participant.backgroundAudioMuted
  persistMuted(storage, userId, kind, participant.backgroundAudioMuted)
}

function persistMuted(storage: Storage, userId: number, kind: ParticipantAudioKind, muted: boolean) {
  const key = mutedKey(userId, kind)
  if (muted) storage.setItem(key, 'true')
  else storage.removeItem(key)
}

function volumeKey(userId: number, kind: ParticipantAudioKind) {
  return kind === 'microphone' ? `cws.volume.${userId}` : `cws.backgroundAudioVolume.${userId}`
}

function mutedKey(userId: number, kind: ParticipantAudioKind) {
  return kind === 'microphone' ? `cws.muted.${userId}` : `cws.backgroundAudioMuted.${userId}`
}
