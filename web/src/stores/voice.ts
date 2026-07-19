import { computed, markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  ConnectionQuality,
  Participant,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import { request } from '../api'
import type { VoiceCredentials } from '../types'
import { useAppStore } from './app'

export interface VoiceParticipant {
  identity: string
  userId: number
  name: string
  isLocal: boolean
  isSpeaking: boolean
  microphoneEnabled: boolean
  quality: ConnectionQuality
  volume: number
}

export const useVoiceStore = defineStore('voice', () => {
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const errorMessage = ref('')
  const muted = ref(false)
  const deafened = ref(false)
  const participants = ref<VoiceParticipant[]>([])
  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const activeInputId = ref('')
  const activeOutputId = ref('')
  let room: Room | null = null

  const joined = computed(() => status.value !== 'idle' && status.value !== 'error')

  async function join() {
    if (room || status.value === 'connecting') return
    const app = useAppStore()
    status.value = 'connecting'
    errorMessage.value = ''
    try {
      const credentials = await request<VoiceCredentials>('/api/voice/token', { method: 'POST' })
      const nextRoom = markRaw(new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        publishDefaults: {
          audioPreset: { maxBitrate: app.settings.audioBitrateKbps * 1000 },
          dtx: true,
          red: true,
          forceStereo: false,
        },
      }))
      room = nextRoom
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token, { autoSubscribe: true, maxRetries: 5 })
      await nextRoom.startAudio()
      if (!app.user?.voiceMuted) {
        await nextRoom.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
      }
      muted.value = app.user?.voiceMuted ?? false
      status.value = 'connected'
      await refreshDevices(true)
      syncParticipants()
    } catch (error) {
      room?.disconnect()
      room = null
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : '无法连接语音频道'
      throw error
    }
  }

  async function leave() {
    if (room) {
      room.disconnect()
      room = null
    }
    document.querySelectorAll('#voice-audio-root audio').forEach((element) => element.remove())
    participants.value = []
    status.value = 'idle'
    muted.value = false
    deafened.value = false
  }

  async function toggleMute() {
    if (!room) return
    const app = useAppStore()
    if (app.user?.voiceMuted) return
    const enabled = muted.value
    await room.localParticipant.setMicrophoneEnabled(enabled, undefined, publishOptions())
    muted.value = !enabled
    syncParticipants()
  }

  function toggleDeafen() {
    deafened.value = !deafened.value
    applyAllVolumes()
  }

  async function switchInput(deviceId: string) {
    if (!room) return
    await room.switchActiveDevice('audioinput', deviceId, true)
    activeInputId.value = deviceId
  }

  async function switchOutput(deviceId: string) {
    if (!room) return
    await room.switchActiveDevice('audiooutput', deviceId, true)
    activeOutputId.value = deviceId
    document.querySelectorAll<HTMLAudioElement>('#voice-audio-root audio').forEach((element) => {
      void setAudioSink(element, deviceId)
    })
  }

  function setParticipantVolume(userId: number, volume: number) {
    const normalized = Math.max(0, Math.min(1, volume))
    localStorage.setItem(`cws.volume.${userId}`, String(normalized))
    const participant = participants.value.find((item) => item.userId === userId)
    if (participant) participant.volume = normalized
    applyVolume(userId)
  }

  async function applyBitrateChange() {
    if (!room || muted.value || useAppStore().user?.voiceMuted) return
    await room.localParticipant.setMicrophoneEnabled(false)
    await room.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
    syncParticipants()
  }

  async function syncServerMute(serverMuted: boolean) {
    if (!room || !serverMuted) return
    await room.localParticipant.setMicrophoneEnabled(false)
    muted.value = true
    syncParticipants()
  }

  async function refreshDevices(requestPermissions = false) {
    const [inputs, outputs] = await Promise.all([
      Room.getLocalDevices('audioinput', requestPermissions),
      Room.getLocalDevices('audiooutput', false),
    ])
    inputDevices.value = inputs
    outputDevices.value = outputs
    activeInputId.value = room?.getActiveDevice('audioinput') ?? inputs[0]?.deviceId ?? ''
    activeOutputId.value = room?.getActiveDevice('audiooutput') ?? outputs[0]?.deviceId ?? ''
  }

  function bindRoom(target: Room) {
    target
      .on(RoomEvent.TrackSubscribed, attachTrack)
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.ParticipantConnected, syncParticipants)
      .on(RoomEvent.ParticipantDisconnected, syncParticipants)
      .on(RoomEvent.ActiveSpeakersChanged, syncParticipants)
      .on(RoomEvent.TrackMuted, syncParticipants)
      .on(RoomEvent.TrackUnmuted, syncParticipants)
      .on(RoomEvent.ConnectionQualityChanged, syncParticipants)
      .on(RoomEvent.Reconnecting, () => { status.value = 'reconnecting' })
      .on(RoomEvent.Reconnected, () => { status.value = 'connected' })
      .on(RoomEvent.Disconnected, () => {
        if (room === target) {
          room = null
          status.value = 'idle'
          participants.value = []
        }
      })
  }

  function attachTrack(track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (track.kind !== Track.Kind.Audio || !(track instanceof RemoteAudioTrack)) return
    const element = track.attach()
    element.dataset.userId = String(participantUserId(participant))
    element.autoplay = true
    element.style.display = 'none'
    document.querySelector('#voice-audio-root')?.appendChild(element)
    if (activeOutputId.value) void setAudioSink(element, activeOutputId.value)
    applyVolume(participantUserId(participant))
    syncParticipants()
  }

  function detachTrack(track: RemoteTrack) {
    track.detach().forEach((element) => element.remove())
    syncParticipants()
  }

  function syncParticipants() {
    if (!room) return
    const app = useAppStore()
    const values: VoiceParticipant[] = []
    if (app.user) values.push(toVoiceParticipant(room.localParticipant, true, app.user.id))
    room.remoteParticipants.forEach((participant) => {
      values.push(toVoiceParticipant(participant, false, participantUserId(participant)))
    })
    participants.value = values.sort((a, b) => Number(b.isSpeaking) - Number(a.isSpeaking) || a.name.localeCompare(b.name, 'zh-CN'))
  }

  function toVoiceParticipant(participant: Participant, isLocal: boolean, userId: number): VoiceParticipant {
    return {
      identity: participant.identity,
      userId,
      name: participant.name || participant.identity,
      isLocal,
      isSpeaking: participant.isSpeaking,
      microphoneEnabled: participant.isMicrophoneEnabled,
      quality: participant.connectionQuality,
      volume: getSavedVolume(userId),
    }
  }

  function participantUserId(participant: Participant): number {
    const fromAttribute = Number(participant.attributes.user_id)
    if (Number.isFinite(fromAttribute) && fromAttribute > 0) return fromAttribute
    const match = participant.identity.match(/^user-(\d+)$/)
    return match ? Number(match[1]) : 0
  }

  function publishOptions() {
    return {
      audioPreset: { maxBitrate: useAppStore().settings.audioBitrateKbps * 1000 },
      dtx: true,
      red: true,
      forceStereo: false,
    }
  }

  function getSavedVolume(userId: number): number {
    const value = Number(localStorage.getItem(`cws.volume.${userId}`))
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
  }

  function applyAllVolumes() {
    participants.value.forEach((participant) => applyVolume(participant.userId))
  }

  function applyVolume(userId: number) {
    document.querySelectorAll<HTMLAudioElement>(`#voice-audio-root audio[data-user-id="${userId}"]`).forEach((element) => {
      element.muted = deafened.value
      element.volume = getSavedVolume(userId)
    })
  }

  return {
    status,
    errorMessage,
    muted,
    deafened,
    participants,
    inputDevices,
    outputDevices,
    activeInputId,
    activeOutputId,
    joined,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    switchInput,
    switchOutput,
    setParticipantVolume,
    applyBitrateChange,
    syncServerMute,
    refreshDevices,
  }
})

async function setAudioSink(element: HTMLAudioElement, deviceId: string) {
  const sinkElement = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (sinkElement.setSinkId) await sinkElement.setSinkId(deviceId)
}
