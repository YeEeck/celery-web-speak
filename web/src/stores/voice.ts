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
import { MicrophoneGainProcessor } from '../audio/MicrophoneGainProcessor'
import type { Role, User, VoiceCredentials } from '../types'
import { useAppStore } from './app'
import { useSoundStore } from './sounds'

const DEFAULT_VOLUME = 1
const MAX_VOLUME = 3
const MICROPHONE_GAIN_KEY = 'cws.microphoneGain'
const OUTPUT_VOLUME_KEY = 'cws.outputVolume'
const DEAFENED_ATTRIBUTE = 'deafened'

export interface VoiceParticipant {
  identity: string
  userId: number
  name: string
  isLocal: boolean
  isSpeaking: boolean
  microphoneEnabled: boolean
  deafened: boolean
  quality: ConnectionQuality
  volume: number
  role: Role
  joinedAt: number | null
}

export const useVoiceStore = defineStore('voice', () => {
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const errorMessage = ref('')
  const muted = ref(false)
  const deafened = ref(false)
  const deafenChanging = ref(false)
  const deafenedSyncError = ref('')
  const participantStates = ref<VoiceParticipant[]>([])
  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const activeInputId = ref('')
  const activeOutputId = ref('')
  const microphoneGain = ref(getSavedLevel(MICROPHONE_GAIN_KEY))
  const outputVolume = ref(getSavedLevel(OUTPUT_VOLUME_KEY))
  const microphoneGainProcessor = new MicrophoneGainProcessor(microphoneGain.value)
  let room: Room | null = null
  let participantSoundsReady = false
  let microphoneBeforeDeafen = false
  let pendingDeafenedSync: boolean | null = null
  let deafenedSyncSession: number | null = null
  let voiceSession = 0

  const joined = computed(() => status.value !== 'idle' && status.value !== 'error')
  const participants = computed(() => {
    const app = useAppStore()
    return [...participantStates.value].sort((a, b) => compareParticipants(a, b, app.users))
  })

  async function join() {
    if (room || status.value === 'connecting') return
    voiceSession += 1
    const app = useAppStore()
    status.value = 'connecting'
    errorMessage.value = ''
    deafenedSyncError.value = ''
    pendingDeafenedSync = null
    microphoneBeforeDeafen = false
    try {
      const credentials = await request<VoiceCredentials>('/api/voice/token', { method: 'POST' })
      const nextRoom = markRaw(new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: true,
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
        await attachMicrophoneGain(nextRoom)
      }
      muted.value = app.user?.voiceMuted ?? false
      status.value = 'connected'
      await refreshDevices(true)
      syncParticipants()
      participantSoundsReady = true
      useSoundStore().play('join')
    } catch (error) {
      participantSoundsReady = false
      room?.disconnect()
      room = null
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : '无法连接语音频道'
      throw error
    }
  }

  async function leave() {
    voiceSession += 1
    participantSoundsReady = false
    if (room) {
      room.disconnect()
      room = null
    }
    document.querySelectorAll('#voice-audio-root audio').forEach((element) => element.remove())
    participantStates.value = []
    status.value = 'idle'
    muted.value = false
    deafened.value = false
    microphoneBeforeDeafen = false
    pendingDeafenedSync = null
    deafenedSyncError.value = ''
    useSoundStore().setSuppressed(false)
  }

  async function toggleMute() {
    if (!room || deafened.value) return
    const app = useAppStore()
    if (app.user?.voiceMuted) return
    const enabled = muted.value
    await room.localParticipant.setMicrophoneEnabled(enabled, undefined, publishOptions())
    if (enabled) await attachMicrophoneGain(room)
    muted.value = !enabled
    syncParticipants()
  }

  async function toggleDeafen() {
    if (!room || deafenChanging.value) return
    const target = room
    const session = voiceSession
    const app = useAppStore()
    const nextDeafened = !deafened.value
    deafenChanging.value = true
    errorMessage.value = ''
    try {
      if (nextDeafened) {
        microphoneBeforeDeafen = !muted.value && !app.user?.voiceMuted
        deafened.value = true
        useSoundStore().setSuppressed(true)
        applyAllVolumes()
        if (microphoneBeforeDeafen) {
          await target.localParticipant.setMicrophoneEnabled(false)
          if (session !== voiceSession || room !== target) return
          muted.value = true
        }
      } else {
        deafened.value = false
        useSoundStore().setSuppressed(false)
        applyAllVolumes()
        const shouldRestoreMicrophone = microphoneBeforeDeafen && !app.user?.voiceMuted
        microphoneBeforeDeafen = false
        if (shouldRestoreMicrophone) {
          await target.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
          if (session !== voiceSession || room !== target) return
          await attachMicrophoneGain(target)
          if (session !== voiceSession || room !== target) return
          muted.value = false
        }
      }
      syncParticipants()
      queueDeafenedSync(nextDeafened)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '无法切换耳机静音状态'
      syncParticipants()
      queueDeafenedSync(deafened.value)
    } finally {
      deafenChanging.value = false
    }
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
    useSoundStore().setOutputDevice(deviceId)
    document.querySelectorAll<HTMLAudioElement>('#voice-audio-root audio').forEach((element) => {
      void setAudioSink(element, deviceId)
    })
  }

  function setParticipantVolume(userId: number, volume: number) {
    const normalized = clampVolume(volume)
    localStorage.setItem(`cws.volume.${userId}`, String(normalized))
    const participant = participantStates.value.find((item) => item.userId === userId)
    if (participant) participant.volume = normalized
    applyVolume(userId)
  }

  function setMicrophoneGain(volume: number) {
    const normalized = clampVolume(volume)
    microphoneGain.value = normalized
    localStorage.setItem(MICROPHONE_GAIN_KEY, String(normalized))
    microphoneGainProcessor.setGain(normalized)
  }

  function setOutputVolume(volume: number) {
    const normalized = clampVolume(volume)
    outputVolume.value = normalized
    localStorage.setItem(OUTPUT_VOLUME_KEY, String(normalized))
    applyAllVolumes()
  }

  async function applyBitrateChange() {
    if (!room || muted.value || useAppStore().user?.voiceMuted) return
    await room.localParticipant.setMicrophoneEnabled(false)
    await room.localParticipant.setMicrophoneEnabled(true, undefined, publishOptions())
    await attachMicrophoneGain(room)
    syncParticipants()
  }

  async function syncServerMute(serverMuted: boolean) {
    if (!room || !serverMuted) return
    await room.localParticipant.setMicrophoneEnabled(false)
    microphoneBeforeDeafen = false
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
    useSoundStore().setOutputDevice(activeOutputId.value)
  }

  function bindRoom(target: Room) {
    target
      .on(RoomEvent.TrackSubscribed, attachTrack)
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.ParticipantConnected, () => handleParticipantChange(target, 'join'))
      .on(RoomEvent.ParticipantDisconnected, () => handleParticipantChange(target, 'leave'))
      .on(RoomEvent.ActiveSpeakersChanged, syncParticipants)
      .on(RoomEvent.TrackMuted, syncParticipants)
      .on(RoomEvent.TrackUnmuted, syncParticipants)
      .on(RoomEvent.ParticipantAttributesChanged, syncParticipants)
      .on(RoomEvent.ConnectionQualityChanged, syncParticipants)
      .on(RoomEvent.Reconnecting, () => {
        participantSoundsReady = false
        status.value = 'reconnecting'
      })
      .on(RoomEvent.Reconnected, () => {
        if (room !== target) return
        status.value = 'connected'
        syncParticipants()
        queueDeafenedSync(deafened.value)
        participantSoundsReady = true
      })
      .on(RoomEvent.Disconnected, () => {
        if (room === target) {
          voiceSession += 1
          participantSoundsReady = false
          room = null
          status.value = 'idle'
          participantStates.value = []
          muted.value = false
          deafened.value = false
          microphoneBeforeDeafen = false
          pendingDeafenedSync = null
          deafenedSyncError.value = ''
          useSoundStore().setSuppressed(false)
        }
      })
  }

  function handleParticipantChange(target: Room, sound: 'join' | 'leave') {
    if (room !== target) return
    syncParticipants()
    if (participantSoundsReady && status.value === 'connected') useSoundStore().play(sound)
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
    participantStates.value = values
  }

  function toVoiceParticipant(participant: Participant, isLocal: boolean, userId: number): VoiceParticipant {
    const existing = participantStates.value.find((item) => item.identity === participant.identity)
    return {
      identity: participant.identity,
      userId,
      name: participant.name || participant.identity,
      isLocal,
      isSpeaking: participant.isSpeaking,
      microphoneEnabled: participant.isMicrophoneEnabled,
      deafened: isLocal ? deafened.value : participant.attributes[DEAFENED_ATTRIBUTE] === 'true',
      quality: participant.connectionQuality,
      volume: getSavedVolume(userId),
      role: participantRole(participant),
      joinedAt: existing ? existing.joinedAt : participantJoinedAt(participant),
    }
  }

  function queueDeafenedSync(value: boolean) {
    if (!room) return
    pendingDeafenedSync = value
    if (deafenedSyncSession !== voiceSession) void flushDeafenedSync()
  }

  function retryDeafenedSync() {
    if (deafenedSyncError.value) queueDeafenedSync(deafened.value)
  }

  async function flushDeafenedSync() {
    const session = voiceSession
    if (deafenedSyncSession === session) return
    deafenedSyncSession = session
    try {
      while (room && session === voiceSession && pendingDeafenedSync !== null) {
        const value = pendingDeafenedSync
        pendingDeafenedSync = null
        try {
          await request<void>('/api/voice/state', {
            method: 'PATCH',
            body: JSON.stringify({ deafened: value }),
          })
          if (session === voiceSession) deafenedSyncError.value = ''
        } catch {
          if (session === voiceSession) {
            pendingDeafenedSync = deafened.value
            deafenedSyncError.value = '耳机静音状态同步失败，将在连接恢复后重试'
          }
          break
        }
      }
    } finally {
      if (deafenedSyncSession === session) deafenedSyncSession = null
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

  async function attachMicrophoneGain(target: Room) {
    const track = target.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (track && track.getProcessor() !== microphoneGainProcessor) {
      await track.setProcessor(microphoneGainProcessor)
    }
  }

  function getSavedVolume(userId: number): number {
    return getSavedLevel(`cws.volume.${userId}`)
  }

  function applyAllVolumes() {
    participantStates.value.forEach((participant) => applyVolume(participant.userId))
  }

  function applyVolume(userId: number) {
    if (!room) return
    const gain = deafened.value ? 0 : clampVolume(getSavedVolume(userId) * outputVolume.value)
    room.remoteParticipants.forEach((participant) => {
      if (participantUserId(participant) === userId) {
        participant.setVolume(gain, Track.Source.Microphone)
      }
    })
  }

  return {
    status,
    errorMessage,
    deafenedSyncError,
    muted,
    deafened,
    deafenChanging,
    participants,
    inputDevices,
    outputDevices,
    activeInputId,
    activeOutputId,
    microphoneGain,
    outputVolume,
    joined,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    switchInput,
    switchOutput,
    setParticipantVolume,
    setMicrophoneGain,
    setOutputVolume,
    applyBitrateChange,
    syncServerMute,
    retryDeafenedSync,
    refreshDevices,
  }
})

function clampVolume(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_VOLUME, value)) : DEFAULT_VOLUME
}

function getSavedLevel(key: string) {
  const saved = localStorage.getItem(key)
  if (saved === null) return DEFAULT_VOLUME
  return clampVolume(Number(saved))
}

function compareParticipants(a: VoiceParticipant, b: VoiceParticipant, users: User[]) {
  const roleDifference = roleRank(currentRole(b, users)) - roleRank(currentRole(a, users))
  if (roleDifference !== 0) return roleDifference
  if (a.joinedAt !== null && b.joinedAt !== null && a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt
  return a.userId - b.userId || a.identity.localeCompare(b.identity)
}

function currentRole(participant: VoiceParticipant, users: User[]): Role {
  return users.find((user) => user.id === participant.userId)?.role ?? participant.role
}

function roleRank(role: Role) {
  if (role === 'server_admin') return 2
  if (role === 'channel_admin') return 1
  return 0
}

function participantRole(participant: Participant): Role {
  const role = participant.attributes.role
  return role === 'server_admin' || role === 'channel_admin' ? role : 'member'
}

function participantJoinedAt(participant: Participant): number | null {
  const timestamp = participant.joinedAt?.getTime()
  return timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : null
}

async function setAudioSink(element: HTMLAudioElement, deviceId: string) {
  const sinkElement = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (sinkElement.setSinkId) await sinkElement.setSinkId(deviceId)
}
