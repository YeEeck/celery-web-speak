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
} from './voice-utils.ts'
import { setParticipantTrackVolume, toggleParticipantTrackMuted } from './voice-participant-volume-state.ts'

export interface ParticipantVolumeContext {
  room: () => Room | null
  deafened: Ref<boolean>
  outputVolume: Ref<number>
  participantStates: Ref<VoiceParticipant[]>
  // 自动音量平衡的当前修正系数（线性），功能关闭时为 1（见 ADR-0026）。
  voiceBalanceGain: (userId: number) => number
}

// 麦克风播放增益合成（seam 2）：静音/聋归零；否则
// 手动音量偏置 × 自动平衡修正 × 扬声器音量，按最大音量钳制。
// 自动平衡关闭时 balanceGain=1，行为与旧版完全一致。
export function composeMicrophoneGain(options: {
  manualVolume: number
  outputVolume: number
  balanceGain: number
  muted: boolean
  deafened: boolean
}): number {
  if (options.deafened || options.muted) return 0
  return clampVolume(options.manualVolume * options.outputVolume * options.balanceGain)
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
    const microphoneGain = composeMicrophoneGain({
      manualVolume: getSavedVolume(userId),
      outputVolume: ctx.outputVolume.value,
      balanceGain: ctx.voiceBalanceGain(userId),
      muted: micMuted,
      deafened: ctx.deafened.value,
    })
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
