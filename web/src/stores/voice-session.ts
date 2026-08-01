import { computed, markRaw, ref, watch } from 'vue'
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RoomOptions,
} from 'livekit-client'
import { MicrophoneActivityMonitor } from '../audio/MicrophoneActivityMonitor.ts'
import { MicrophoneGainProcessor } from '../audio/MicrophoneGainProcessor.ts'
import { buildMicrophoneCaptureOptions } from '../audio/microphoneCaptureOptions.ts'
import { MutedSpeakingReminderMonitor } from '../audio/MutedSpeakingReminderMonitor.ts'
import type { SpeechDetectionEngine, SpeechDetectionEngineCallbacks } from '../audio/SpeechDetectionEngine.ts'
import { VoiceAudioContextController } from '../audio/VoiceAudioContextController.ts'
import type { ApplicationSoundOccurrence } from '../application-sounds/core.ts'
import type { Channel, User, VoiceCredentials } from '../types.ts'
import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEAFENED_ATTRIBUTE,
  MUTED_SPEAKING_REMINDER_KEY,
  compareParticipants,
  defaultConnectedPublishSettings,
  getSavedBackgroundAudioVolume,
  getSavedBoolean,
  getSavedMuted,
  getSavedTransmissionMode,
  getSavedVolume,
  hasBackgroundAudio,
  isBackgroundAudioPlaying,
  participantJoinedAt,
  participantRole,
  participantUserId,
  saveBoolean,
  saveTransmissionMode,
  type VoiceParticipant,
  type VoiceTransmissionMode,
} from './voice-utils.ts'

type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

interface LeaveOptions {
  notifyGuild?: boolean
  intent?: 'active'
}

interface EndedVoiceSession {
  guildId: number
  channelId: number
  deafened: boolean
  endedAt: number
}

const MODERATOR_DISCONNECT_MATCH_WINDOW_MS = 5_000

export interface VoiceSessionContext {
  findChannel(channelId: number): Channel | undefined
  activeGuildInfo(): { id: number; name: string } | null
  currentUser(): Pick<User, 'id' | 'voiceMuted'> | null
  connectedUsers(): User[]
  requestVoiceRoomsRefresh(): void

  muted(): boolean
  deafened(): boolean
  guildMuted(): boolean
  microphoneEnabledPreference(): boolean
  deafenedPreference(): boolean
  muteChanging(): boolean
  deafenChanging(): boolean
  refreshGuildMuted(): void
  setMuted(value: boolean): void
  applyConnectionPreferences(): Promise<void>
  connectionReset(): void
  transportRecovered(): Promise<void>
  notifyPreferenceChange(): void

  resolvedPreferredInputDeviceId(): string
  resolvedPreferredOutputDeviceId(): string
  activeOutputDeviceId(): string | null
  devicePermissionState(): 'idle' | 'requesting' | 'granted' | 'denied'
  supportsOutputSelection(): boolean
  initializeDevices(): Promise<boolean>
  refreshDevices(force: boolean): Promise<void>
  applyPreferredDevicesToRoom(room: Room, voiceSession: number): Promise<void>

  stopApplicationAudio(): Promise<void>
  republishBackgroundAudio(): Promise<void>
  applicationAudioHasActiveTrack(): boolean

  applyAllVolumes(): void
  applyVolume(userId: number): void

  signal(occurrence: ApplicationSoundOccurrence): void
  followPlayback(options: { deafened: boolean; outputDeviceId: string }): void
  mutedSpeakingReminderAudible(): boolean

  microphoneGainInitial(): number
  echoCancellation(): boolean
  noiseSuppression(): boolean

  fetchVoiceToken(guildId: number, channelId: number, deafened: boolean): Promise<VoiceCredentials>
  postVoiceLeave(guildId: number): Promise<void>
  createRoom(options: RoomOptions): Room
  createAudioContext(): AudioContext | null
  audioInteractionTarget(): EventTarget
  createSpeechDetectionEngine(callbacks: SpeechDetectionEngineCallbacks): SpeechDetectionEngine
  appendAudioElement(element: HTMLAudioElement): void
  removeAllAudioElements(): void
  applyAudioSink(element: HTMLAudioElement, deviceId: string): void
  subscribePageHide(callback: () => void): void
  sendBeacon(url: string): void
}

export function useVoiceSession(ctx: VoiceSessionContext) {
  const status = ref<VoiceStatus>('idle')
  const connectedChannelId = ref<number | null>(null)
  const connectedGuildId = ref<number | null>(null)
  const connectedGuildName = ref('')
  const connectedChannelName = ref('')
  const connectedPublishSettings = ref(defaultConnectedPublishSettings())
  const errorMessage = ref('')
  const participantStates = ref<VoiceParticipant[]>([])
  const mutedSpeakingReminderEnabled = ref(getSavedBoolean(MUTED_SPEAKING_REMINDER_KEY, true))
  const mutedSpeakingReminderVisible = ref(false)
  const transmissionMode = ref<VoiceTransmissionMode>(getSavedTransmissionMode())
  const transmissionModeChanging = ref(false)
  const transmissionModeError = ref('')
  const microphoneGainProcessor = new MicrophoneGainProcessor(ctx.microphoneGainInitial())
  const microphoneActivity = new MicrophoneActivityMonitor((identity, speaking) => {
    const participant = participantStates.value.find((item) => item.identity === identity)
    if (participant) participant.isSpeaking = speaking
  })
  let room: Room | null = null
  let voiceAudioContextController: VoiceAudioContextController | null = null
  let participantSoundsReady = false
  let voiceSession = 0
  let appliedTransmissionMode: VoiceTransmissionMode | null = null
  let mutedSpeakingReminderTimer: number | null = null
  let recentEndedSession: EndedVoiceSession | null = null

  const joined = computed(() => status.value !== 'idle' && status.value !== 'error')
  const connectedAudioBitrateKbps = computed(() => connectedPublishSettings.value.audioBitrateKbps)
  const dtxEnabled = computed(() => transmissionMode.value === 'voice-activity')

  const mutedSpeakingReminderInputDeviceId = computed(() => ctx.resolvedPreferredInputDeviceId())
  const shouldRunMutedSpeakingReminder = computed(() => (
    status.value === 'connected'
    && !ctx.microphoneEnabledPreference()
    && !ctx.deafenedPreference()
    && !ctx.guildMuted()
    && mutedSpeakingReminderEnabled.value
    && ctx.mutedSpeakingReminderAudible()
    && ctx.devicePermissionState() === 'granted'
  ))
  const speechDetection = ctx.createSpeechDetectionEngine({
    onError: (error) => console.warn('静音说话检测已停用', error),
  })
  const mutedSpeakingReminder = new MutedSpeakingReminderMonitor(speechDetection, {
    onReminder: showMutedSpeakingReminder,
  })

  watch(
    () => ({
      enabled: shouldRunMutedSpeakingReminder.value,
      deviceId: mutedSpeakingReminderInputDeviceId.value,
    }),
    (current, previous) => {
      if (!current.enabled) {
        mutedSpeakingReminder.stop()
        clearMutedSpeakingReminder()
        return
      }
      if (!previous?.enabled || current.deviceId !== previous.deviceId) {
        void mutedSpeakingReminder.start(current.deviceId)
      }
    },
    { flush: 'sync' },
  )

  const participants = computed(() => {
    const connectedUsers = ctx.connectedUsers()
    return [...participantStates.value].sort((a, b) => compareParticipants(a, b, connectedUsers))
  })

  // 页面关闭时主动通知后端离开语音频道，避免依赖 LiveKit 的断开检测延迟（关闭标签页/窗口时
  // LiveKit 可能需要数十秒才能通过心跳超时发现连接已断开，导致成员列表出现幽灵状态）。
  ctx.subscribePageHide(() => {
    const guildId = connectedGuildId.value
    if (!joined.value || guildId === null) return
    ctx.sendBeacon(`/api/guilds/${guildId}/voice/leave`)
  })

  function showMutedSpeakingReminder() {
    if (!shouldRunMutedSpeakingReminder.value) return
    mutedSpeakingReminderVisible.value = true
    if (mutedSpeakingReminderTimer !== null) clearTimeout(mutedSpeakingReminderTimer)
    mutedSpeakingReminderTimer = setTimeout(() => {
      mutedSpeakingReminderVisible.value = false
      mutedSpeakingReminderTimer = null
    }, 3_000)
    ctx.signal('muted-speaking-reminder')
  }

  function clearMutedSpeakingReminder() {
    mutedSpeakingReminderVisible.value = false
    if (mutedSpeakingReminderTimer !== null) clearTimeout(mutedSpeakingReminderTimer)
    mutedSpeakingReminderTimer = null
  }

  function setMutedSpeakingReminderEnabled(value: boolean) {
    mutedSpeakingReminderEnabled.value = value
    saveBoolean(MUTED_SPEAKING_REMINDER_KEY, value)
  }

  async function destroyVoiceAudioContext() {
    const controller = voiceAudioContextController
    if (!controller) return
    voiceAudioContextController = null
    await controller.destroy()
  }

  async function join(channelId: number) {
    if (room && connectedChannelId.value === channelId) return
    if (status.value === 'connecting') return
    if (room) await leave({ intent: 'active' })
    await destroyVoiceAudioContext()
    voiceSession += 1
    mutedSpeakingReminder.resetFailure()
    clearMutedSpeakingReminder()
    const session = voiceSession
    recentEndedSession = null
    status.value = 'connecting'
    errorMessage.value = ''
    transmissionModeError.value = ''
    ctx.connectionReset()
    appliedTransmissionMode = null
    syncApplicationSoundPlayback()
    try {
      const channel = ctx.findChannel(channelId)
      if (!channel) throw new Error('语音频道不存在')
      const guild = ctx.activeGuildInfo()
      if (!guild) throw new Error('未选择服务器')
      const guildId = guild.id
      ctx.refreshGuildMuted()
      connectedChannelId.value = channelId
      connectedGuildId.value = guildId
      connectedGuildName.value = guild.name
      connectedChannelName.value = channel.name
      setConnectedChannelSettings(channel)
      await ctx.initializeDevices()
      if (session !== voiceSession) return
      const tokenDeafened = ctx.deafenedPreference()
      const credentials = await ctx.fetchVoiceToken(guildId, channelId, tokenDeafened)
      if (session !== voiceSession) return
      const audioContext = ctx.createAudioContext()
      const nextRoom = markRaw(ctx.createRoom({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: audioContext ? { audioContext } : true,
        audioCaptureDefaults: microphoneCaptureOptions(),
        publishDefaults: {
          audioPreset: { maxBitrate: (channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS) * 1000 },
          dtx: dtxEnabled.value,
          red: channel.audioRedEnabled ?? true,
          forceStereo: false,
        },
        audioOutput: ctx.supportsOutputSelection()
          ? { deviceId: ctx.resolvedPreferredOutputDeviceId() }
          : undefined,
      }))
      room = nextRoom
      if (audioContext) {
        voiceAudioContextController = new VoiceAudioContextController(audioContext, {
          startAudio: () => nextRoom.startAudio(),
          shouldResume: () => room === nextRoom && status.value === 'connected' && !ctx.deafened(),
          interactionTarget: ctx.audioInteractionTarget(),
          onError: (error) => console.warn('语音音频自动恢复失败', error),
        })
      }
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token, { autoSubscribe: true, maxRetries: 5 })
      if (session !== voiceSession || room !== nextRoom) return
      await ctx.refreshDevices(false)
      if (session !== voiceSession || room !== nextRoom) return
      await ctx.applyConnectionPreferences()
      if (session !== voiceSession || room !== nextRoom) return
      status.value = 'connected'
      voiceAudioContextController?.resumeIfNeeded()
      await ctx.refreshDevices(false)
      syncParticipants()
      participantSoundsReady = true
      ctx.signal('voice-self-joined')
      ctx.requestVoiceRoomsRefresh()
    } catch (error) {
      if (session !== voiceSession) return
      participantSoundsReady = false
      room?.disconnect()
      room = null
      await destroyVoiceAudioContext()
      clearConnectedChannelSummary()
      status.value = 'error'
      ctx.connectionReset()
      syncApplicationSoundPlayback()
      errorMessage.value = error instanceof Error ? error.message : '无法连接语音频道'
      throw error
    }
  }

  async function leave(options: LeaveOptions = {}) {
    const targetRoom = room
    const guildId = connectedGuildId.value
    rememberEndedSession()
    mutedSpeakingReminder.stop()
    clearMutedSpeakingReminder()
    await ctx.stopApplicationAudio()
    const wasJoined = targetRoom !== null && room === targetRoom
    voiceSession += 1
    participantSoundsReady = false
    if (wasJoined) {
      targetRoom.disconnect()
      room = null
    }
    await destroyVoiceAudioContext()
    clearConnectedChannelSummary()
    ctx.removeAllAudioElements()
    participantStates.value = []
    status.value = 'idle'
    ctx.connectionReset()
    appliedTransmissionMode = null
    transmissionModeError.value = ''
    microphoneActivity.destroy()
    if (wasJoined && options.intent === 'active') ctx.signal('voice-self-left')
    syncApplicationSoundPlayback()
    if (wasJoined && guildId !== null && options.notifyGuild !== false) {
      await ctx.postVoiceLeave(guildId)
      ctx.requestVoiceRoomsRefresh()
    }
  }

  function applyMicrophoneGain(volume: number) {
    microphoneGainProcessor.setGain(volume)
  }

  async function toggleTransmissionMode() {
    if (transmissionModeChanging.value || ctx.muteChanging() || ctx.deafenChanging()) return
    const previous = transmissionMode.value
    const next: VoiceTransmissionMode = previous === 'voice-activity' ? 'continuous' : 'voice-activity'
    transmissionMode.value = next
    saveTransmissionMode(next)
    ctx.notifyPreferenceChange()
    transmissionModeError.value = ''

    if (!room || status.value !== 'connected' || ctx.muted() || ctx.deafened() || ctx.guildMuted()) return
    const target = room
    const session = voiceSession
    transmissionModeChanging.value = true
    try {
      await republishMicrophone()
      if (session !== voiceSession || room !== target) return
      syncParticipants()
    } catch (error) {
      if (session !== voiceSession || room !== target) return
      transmissionMode.value = previous
      saveTransmissionMode(previous)
      ctx.notifyPreferenceChange()
      try {
        await republishMicrophone()
      } catch {
        ctx.setMuted(!target.localParticipant.isMicrophoneEnabled)
      }
      transmissionModeError.value = error instanceof Error ? `无法切换传输模式：${error.message}` : '无法切换传输模式'
      syncParticipants()
    } finally {
      transmissionModeChanging.value = false
    }
  }

  async function applyPublishSettingsChange(microphoneChanged: boolean, backgroundAudioChanged: boolean) {
    if (!room) return
    if (microphoneChanged && !ctx.muted() && !ctx.guildMuted()) {
      await republishMicrophone()
    }
    if (backgroundAudioChanged && ctx.applicationAudioHasActiveTrack()) {
      await ctx.republishBackgroundAudio()
    }
    syncParticipants()
  }

  function updateConnectedChannelSettings(channel: Channel) {
    if (channel.id !== connectedChannelId.value) return { microphoneChanged: false, backgroundAudioChanged: false }
    const previous = connectedPublishSettings.value
    const next = {
      audioBitrateKbps: channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
      backgroundAudioBitrateKbps: channel.backgroundAudioBitrateKbps ?? 128,
      audioRedEnabled: channel.audioRedEnabled ?? true,
      backgroundAudioRedEnabled: channel.backgroundAudioRedEnabled ?? false,
    }
    setConnectedChannelSettings(channel)
    return {
      microphoneChanged: previous.audioBitrateKbps !== next.audioBitrateKbps || previous.audioRedEnabled !== next.audioRedEnabled,
      backgroundAudioChanged: previous.backgroundAudioBitrateKbps !== next.backgroundAudioBitrateKbps || previous.backgroundAudioRedEnabled !== next.backgroundAudioRedEnabled,
    }
  }

  function syncApplicationSoundPlayback() {
    ctx.followPlayback({
      deafened: ctx.deafened(),
      outputDeviceId: room !== null && status.value !== 'connecting'
        ? (ctx.activeOutputDeviceId() ?? '')
        : ctx.resolvedPreferredOutputDeviceId(),
    })
  }

  function bindRoom(target: Room) {
    target
      .on(RoomEvent.TrackSubscribed, attachTrack)
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.ParticipantConnected, () => handleParticipantChange(target, 'join'))
      .on(RoomEvent.ParticipantDisconnected, () => handleParticipantChange(target, 'leave'))
      .on(RoomEvent.ActiveSpeakersChanged, syncParticipants)
      .on(RoomEvent.TrackPublished, syncParticipants)
      .on(RoomEvent.TrackUnpublished, syncParticipants)
      .on(RoomEvent.TrackMuted, syncParticipants)
      .on(RoomEvent.TrackUnmuted, syncParticipants)
      .on(RoomEvent.LocalTrackPublished, syncParticipants)
      .on(RoomEvent.LocalTrackUnpublished, syncParticipants)
      .on(RoomEvent.ParticipantAttributesChanged, syncParticipants)
      .on(RoomEvent.ConnectionQualityChanged, syncParticipants)
      .on(RoomEvent.Reconnecting, () => {
        participantSoundsReady = false
        status.value = 'reconnecting'
      })
      .on(RoomEvent.Reconnected, () => {
        if (room !== target) return
        status.value = 'connected'
        voiceAudioContextController?.resumeIfNeeded()
        void ctx.transportRecovered().then(() => {
          if (room !== target) return
          syncParticipants()
          participantSoundsReady = true
          ctx.requestVoiceRoomsRefresh()
        })
      })
      .on(RoomEvent.Disconnected, () => {
        if (room === target) {
          void ctx.stopApplicationAudio()
          voiceSession += 1
          participantSoundsReady = false
          rememberEndedSession()
          room = null
          clearConnectedChannelSummary()
          status.value = 'idle'
          participantStates.value = []
          ctx.connectionReset()
          appliedTransmissionMode = null
          microphoneActivity.destroy()
          void destroyVoiceAudioContext()
          syncApplicationSoundPlayback()
          ctx.requestVoiceRoomsRefresh()
        }
      })
  }

  function handleParticipantChange(target: Room, sound: 'join' | 'leave') {
    if (room !== target) return
    syncParticipants()
    ctx.requestVoiceRoomsRefresh()
    if (participantSoundsReady && status.value === 'connected') {
      ctx.signal(sound === 'join' ? 'voice-participant-joined' : 'voice-participant-left')
    }
  }

  function attachTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (track.kind !== Track.Kind.Audio || !(track instanceof RemoteAudioTrack)) return
    const element = track.attach()
    element.dataset.userId = String(participantUserId(participant))
    element.dataset.trackSource = publication.source
    element.autoplay = true
    element.style.display = 'none'
    ctx.appendAudioElement(element)
    if (ctx.activeOutputDeviceId()) void ctx.applyAudioSink(element, ctx.activeOutputDeviceId() ?? '')
    ctx.applyVolume(participantUserId(participant))
    syncParticipants()
  }

  function detachTrack(track: RemoteTrack) {
    track.detach().forEach((element) => element.remove())
    syncParticipants()
  }

  function syncParticipants() {
    if (!room) return
    const user = ctx.currentUser()
    const values: VoiceParticipant[] = []
    if (user) values.push(toVoiceParticipant(room.localParticipant, true, user.id))
    room.remoteParticipants.forEach((participant) => {
      values.push(toVoiceParticipant(participant, false, participantUserId(participant)))
    })
    participantStates.value = values
    microphoneActivity.sync([room.localParticipant, ...room.remoteParticipants.values()].flatMap((participant) => {
      const publication = participant.getTrackPublication(Track.Source.Microphone)
      const track = publication?.audioTrack
      return track ? [{
        identity: participant.identity,
        mediaTrack: track.mediaStreamTrack,
        muted: publication.isMuted,
      }] : []
    }))
  }

  function toVoiceParticipant(participant: Participant, isLocal: boolean, userId: number): VoiceParticipant {
    const existing = participantStates.value.find((item) => item.identity === participant.identity)
    return {
      identity: participant.identity,
      userId,
      name: participant.name || participant.identity,
      isLocal,
      isSpeaking: microphoneActivity.isSpeaking(participant.identity),
      microphoneEnabled: participant.isMicrophoneEnabled,
      backgroundAudioAvailable: hasBackgroundAudio(participant),
      backgroundAudioPlaying: isBackgroundAudioPlaying(participant),
      deafened: isLocal ? ctx.deafened() : participant.attributes[DEAFENED_ATTRIBUTE] === 'true',
      quality: participant.connectionQuality,
      microphoneVolume: getSavedVolume(userId),
      backgroundAudioVolume: getSavedBackgroundAudioVolume(userId),
      microphoneMuted: getSavedMuted(`cws.muted.${userId}`),
      backgroundAudioMuted: getSavedMuted(`cws.backgroundAudioMuted.${userId}`),
      role: participantRole(participant),
      joinedAt: existing ? existing.joinedAt : participantJoinedAt(participant),
    }
  }

  function setConnectedChannelSettings(channel: Channel) {
    connectedPublishSettings.value = {
      audioBitrateKbps: channel.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
      backgroundAudioBitrateKbps: channel.backgroundAudioBitrateKbps ?? 128,
      audioRedEnabled: channel.audioRedEnabled ?? true,
      backgroundAudioRedEnabled: channel.backgroundAudioRedEnabled ?? false,
    }
  }

  function clearConnectedChannelSummary() {
    connectedChannelId.value = null
    connectedGuildId.value = null
    connectedGuildName.value = ''
    connectedChannelName.value = ''
    connectedPublishSettings.value = defaultConnectedPublishSettings()
  }

  function rememberEndedSession() {
    if (connectedGuildId.value === null || connectedChannelId.value === null) return
    recentEndedSession = {
      guildId: connectedGuildId.value,
      channelId: connectedChannelId.value,
      deafened: ctx.deafened(),
      endedAt: Date.now(),
    }
  }

  function handleModeratorDisconnect(guildId: number, channelId: number) {
    const matchesCurrent = connectedGuildId.value === guildId && connectedChannelId.value === channelId
    const matchesRecent = recentEndedSession?.guildId === guildId
      && recentEndedSession.channelId === channelId
      && Date.now() - recentEndedSession.endedAt <= MODERATOR_DISCONNECT_MATCH_WINDOW_MS
    if (!matchesCurrent && !matchesRecent) return false

    const wasDeafened = matchesCurrent ? ctx.deafened() : recentEndedSession?.deafened === true
    recentEndedSession = null
    if (!wasDeafened) ctx.signal('voice-moderator-disconnected')
    return true
  }

  function publishOptions(mode: VoiceTransmissionMode = transmissionMode.value) {
    const settings = connectedPublishSettings.value
    return {
      audioPreset: { maxBitrate: settings.audioBitrateKbps * 1000 },
      dtx: mode === 'voice-activity',
      red: settings.audioRedEnabled,
      forceStereo: false,
    }
  }

  function microphoneCaptureOptions() {
    return buildMicrophoneCaptureOptions({
      deviceId: ctx.resolvedPreferredInputDeviceId(),
      echoCancellation: ctx.echoCancellation(),
      noiseSuppression: ctx.noiseSuppression(),
    })
  }

  async function enableMicrophone(enabled: boolean) {
    const target = room
    if (!target) return
    if (target.localParticipant.isMicrophoneEnabled === enabled) return
    const mode = transmissionMode.value
    await target.localParticipant.setMicrophoneEnabled(
      enabled,
      enabled ? microphoneCaptureOptions() : undefined,
      enabled ? publishOptions(mode) : undefined,
    )
    if (enabled && room === target) appliedTransmissionMode = mode
  }

  async function attachMicrophoneGain() {
    const target = room
    if (!target) return
    const track = target.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack
    if (track && track.getProcessor() !== microphoneGainProcessor) {
      await track.setProcessor(microphoneGainProcessor)
    }
  }

  async function republishMicrophone() {
    const target = room
    if (!target) return
    const nextTransmissionMode = transmissionMode.value
    await target.localParticipant.setMicrophoneEnabled(false)
    await target.localParticipant.setMicrophoneEnabled(true, microphoneCaptureOptions(), publishOptions(nextTransmissionMode))
    if (room === target) appliedTransmissionMode = nextTransmissionMode
    await attachMicrophoneGain()
  }

  function resumeVoiceAudioContext() {
    return voiceAudioContextController?.resumeIfNeeded()
  }

  function applyPreferredDevicesToCurrentRoom() {
    return room ? ctx.applyPreferredDevicesToRoom(room, voiceSession) : Promise.resolve()
  }

  return {
    status,
    connectedChannelId,
    connectedGuildId,
    connectedGuildName,
    connectedChannelName,
    connectedPublishSettings,
    connectedAudioBitrateKbps,
    errorMessage,
    participantStates,
    joined,
    participants,
    mutedSpeakingReminderEnabled,
    mutedSpeakingReminderVisible,
    transmissionMode,
    transmissionModeChanging,
    transmissionModeError,
    dtxEnabled,
    join,
    leave,
    setMutedSpeakingReminderEnabled,
    toggleTransmissionMode,
    applyPublishSettingsChange,
    updateConnectedChannelSettings,
    handleModeratorDisconnect,
    applyMicrophoneGain,
    syncApplicationSoundPlayback,
    enableMicrophone,
    republishMicrophone,
    attachMicrophoneGain,
    syncParticipants,
    resumeVoiceAudioContext,
    applyPreferredDevicesToCurrentRoom,
    room: () => room,
    voiceSession: () => voiceSession,
    statusValue: () => status.value,
    joinedValue: () => joined.value,
    connectedChannelIdValue: () => connectedChannelId.value,
    connectedGuildIdValue: () => connectedGuildId.value,
    transmissionModeValue: () => transmissionMode.value,
    appliedTransmissionModeValue: () => appliedTransmissionMode,
  }
}
