import type { Ref } from 'vue'
import type { Room } from 'livekit-client'
import { Track } from 'livekit-client'
import {
  DEFAULT_VOLUME,
  clampVolume,
  getSavedBackgroundAudioVolume,
  getSavedMuted,
  getSavedPreMuteVolume,
  getSavedVolume,
  participantUserId,
  type VoiceParticipant,
} from './voice-utils'

export interface ParticipantVolumeContext {
  room: () => Room | null
  deafened: Ref<boolean>
  outputVolume: Ref<number>
  participantStates: Ref<VoiceParticipant[]>
}

export function useParticipantVolume(ctx: ParticipantVolumeContext) {
  function setParticipantMicrophoneVolume(userId: number, volume: number) {
    const normalized = clampVolume(volume)
    localStorage.setItem(`cws.volume.${userId}`, String(normalized))
    localStorage.removeItem(`cws.muted.${userId}`)
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (participant) {
      participant.microphoneVolume = normalized
      participant.microphoneMuted = false
    }
    applyVolume(userId)
  }

  function setParticipantBackgroundAudioVolume(userId: number, volume: number) {
    const normalized = clampVolume(volume)
    localStorage.setItem(`cws.backgroundAudioVolume.${userId}`, String(normalized))
    localStorage.removeItem(`cws.backgroundAudioMuted.${userId}`)
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (participant) {
      participant.backgroundAudioVolume = normalized
      participant.backgroundAudioMuted = false
    }
    applyVolume(userId)
  }

  function toggleParticipantMicrophoneMute(userId: number) {
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (!participant) return
    if (participant.microphoneMuted) {
      const preMute = getSavedPreMuteVolume(`cws.preMuteVolume.${userId}`)
      localStorage.removeItem(`cws.muted.${userId}`)
      localStorage.setItem(`cws.volume.${userId}`, String(preMute))
      participant.microphoneMuted = false
      participant.microphoneVolume = preMute
    } else {
      localStorage.setItem(`cws.preMuteVolume.${userId}`, String(participant.microphoneVolume))
      localStorage.setItem(`cws.muted.${userId}`, 'true')
      participant.microphoneMuted = true
    }
    applyVolume(userId)
  }

  function toggleParticipantBackgroundAudioMute(userId: number) {
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (!participant) return
    if (participant.backgroundAudioMuted) {
      const preMute = getSavedPreMuteVolume(`cws.backgroundAudioPreMuteVolume.${userId}`)
      localStorage.removeItem(`cws.backgroundAudioMuted.${userId}`)
      localStorage.setItem(`cws.backgroundAudioVolume.${userId}`, String(preMute))
      participant.backgroundAudioMuted = false
      participant.backgroundAudioVolume = preMute
    } else {
      localStorage.setItem(`cws.backgroundAudioPreMuteVolume.${userId}`, String(participant.backgroundAudioVolume))
      localStorage.setItem(`cws.backgroundAudioMuted.${userId}`, 'true')
      participant.backgroundAudioMuted = true
    }
    applyVolume(userId)
  }

  function resetParticipantMicrophoneVolume(userId: number) {
    localStorage.removeItem(`cws.muted.${userId}`)
    localStorage.removeItem(`cws.preMuteVolume.${userId}`)
    localStorage.setItem(`cws.volume.${userId}`, String(DEFAULT_VOLUME))
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (participant) {
      participant.microphoneVolume = DEFAULT_VOLUME
      participant.microphoneMuted = false
    }
    applyVolume(userId)
  }

  function resetParticipantBackgroundAudioVolume(userId: number) {
    localStorage.removeItem(`cws.backgroundAudioMuted.${userId}`)
    localStorage.removeItem(`cws.backgroundAudioPreMuteVolume.${userId}`)
    localStorage.setItem(`cws.backgroundAudioVolume.${userId}`, String(DEFAULT_VOLUME))
    const participant = ctx.participantStates.value.find((item) => item.userId === userId)
    if (participant) {
      participant.backgroundAudioVolume = DEFAULT_VOLUME
      participant.backgroundAudioMuted = false
    }
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
