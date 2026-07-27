import type { Ref } from 'vue'
import type { Room } from 'livekit-client'
import { Track } from 'livekit-client'
import {
  DEFAULT_VOLUME,
  clampVolume,
  getSavedBackgroundAudioVolume,
  getSavedMuted,
  getSavedVolume,
  participantUserId,
  type VoiceParticipant,
} from './voice-utils'
import { setParticipantTrackVolume, toggleParticipantTrackMuted } from './voice-participant-volume-state'

export interface ParticipantVolumeContext {
  room: () => Room | null
  deafened: Ref<boolean>
  outputVolume: Ref<number>
  participantStates: Ref<VoiceParticipant[]>
}

export function useParticipantVolume(ctx: ParticipantVolumeContext) {
  function setParticipantMicrophoneVolume(userId: number, volume: number) {
    const normalized = clampVolume(volume)
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    setParticipantTrackVolume(localStorage, userId, participant, 'microphone', normalized)
    applyVolume(userId)
  }

  function setParticipantBackgroundAudioVolume(userId: number, volume: number) {
    const normalized = clampVolume(volume)
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    setParticipantTrackVolume(localStorage, userId, participant, 'backgroundAudio', normalized)
    applyVolume(userId)
  }

  function toggleParticipantMicrophoneMute(userId: number) {
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (!participant) return
    toggleParticipantTrackMuted(localStorage, userId, participant, 'microphone')
    applyVolume(userId)
  }

  function toggleParticipantBackgroundAudioMute(userId: number) {
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (!participant) return
    toggleParticipantTrackMuted(localStorage, userId, participant, 'backgroundAudio')
    applyVolume(userId)
  }

  function resetParticipantMicrophoneVolume(userId: number) {
    localStorage.removeItem(`cws.preMuteVolume.${userId}`)
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    setParticipantTrackVolume(localStorage, userId, participant, 'microphone', DEFAULT_VOLUME)
    applyVolume(userId)
  }

  function resetParticipantBackgroundAudioVolume(userId: number) {
    localStorage.removeItem(`cws.backgroundAudioPreMuteVolume.${userId}`)
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    setParticipantTrackVolume(localStorage, userId, participant, 'backgroundAudio', DEFAULT_VOLUME)
    applyVolume(userId)
  }

  function applyAllVolumes() {
    ctx.participantStates.value.forEach((participant) => applyVolume(participant.userId))
  }

  function applyVolume(userId: number) {
    const room = ctx.room()
    if (!room) return
    const micMuted = getSavedMuted(`cws.muted.${userId}`)
    const bgMuted = getSavedMuted(`cws.backgroundAudioMuted.${userId}`)
    const microphoneGain = (ctx.deafened.value || micMuted) ? 0 : clampVolume(getSavedVolume(userId) * ctx.outputVolume.value)
    const backgroundAudioGain = (ctx.deafened.value || bgMuted) ? 0 : clampVolume(getSavedBackgroundAudioVolume(userId) * ctx.outputVolume.value)
    room.remoteParticipants.forEach((participant) => {
      if (participantUserId(participant) === userId) {
        participant.setVolume(microphoneGain, Track.Source.Microphone)
        participant.setVolume(backgroundAudioGain, Track.Source.ScreenShareAudio)
      }
    })
  }

  return {
    setParticipantMicrophoneVolume,
    setParticipantBackgroundAudioVolume,
    toggleParticipantMicrophoneMute,
    toggleParticipantBackgroundAudioMute,
    resetParticipantMicrophoneVolume,
    resetParticipantBackgroundAudioVolume,
    applyAllVolumes,
    applyVolume,
  }
}
