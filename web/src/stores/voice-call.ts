import { computed, markRaw, ref } from 'vue'
import {
  Room,
  RoomEvent,
  Track,
  RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RoomOptions,
} from 'livekit-client'
import { buildMicrophoneCaptureOptions } from '../audio/microphoneCaptureOptions.ts'
import type { VoiceCredentials } from '../types.ts'
import { participantUserId } from './voice-utils.ts'

// 1:1 临时语音通话的会话状态机（spec 04/05）。与 voice-session 并列：两者各
// 自持有一条 LiveKit Room 连接（频道房间与通话房间并存，ADR-0032），互不侵入。
// 终端原因仅在结束时记录，用于浮层清理；本票不为各原因做专属文案（06）。
export type CallStatus = 'idle' | 'outgoing' | 'ringing' | 'active'
export type CallEndReason = 'busy' | 'unreachable' | 'rejected' | 'canceled' | 'timeout' | 'ended' | 'disconnected'

// 通话对方的最小渲染字段，取自后端信令的 peer 或发起来源（个人信息卡片成员）。
export interface CallPeer {
  userId: number
  username: string
  displayName: string
}

// 后端 CallSignal 的 shape（hub.SendUser 点到点事件 data）。
export interface CallSignal {
  type: string
  callId: string
  peer: CallPeer
  state: string
  reason?: string
}

// POST /api/calls 的响应。
export interface StartCallResult {
  callId: string
  state: string
  reason?: string
}

export interface VoiceCallContext {
  currentUser(): { id: number } | null
  createRoom(options: RoomOptions): Room

  // HTTP 信令动作（后端仲裁，见 spec 05）。
  startCallRequest(calleeUserId: number): Promise<StartCallResult>
  acceptRequest(callId: string): Promise<void>
  rejectRequest(callId: string): Promise<void>
  cancelRequest(callId: string): Promise<void>
  hangupRequest(callId: string): Promise<void>
  fetchCallToken(callId: string): Promise<VoiceCredentials>

  // 设备/采集偏好（复用 voice-devices 与既有偏好，不重造降噪链；spec 07）。
  resolvedPreferredInputDeviceId(): string
  resolvedPreferredOutputDeviceId(): string
  echoCancellation(): boolean
  noiseSuppression(): boolean
  microphoneEnabledPreference(): boolean

  // 远端音频挂载（独立于频道语音的 #call-audio-root；避免频道 leave/join 误删）。
  appendAudioElement(element: HTMLAudioElement): void
  removeAudioElements(): void
  applyAudioSink(element: HTMLAudioElement, deviceId: string): void
}

export function useVoiceCall(ctx: VoiceCallContext) {
  const status = ref<CallStatus>('idle')
  const reconnecting = ref(false)
  const callId = ref<string | null>(null)
  const peer = ref<CallPeer | null>(null)
  const endedReason = ref<CallEndReason | null>(null)
  const microphoneMuted = ref(false)
  const connectedAt = ref<number | null>(null)

  let room: Room | null = null
  let callSession = 0

  const joined = computed(() => room !== null && (status.value === 'active' || status.value === 'ringing'))
  // 浮层三形态：outgoing=呼出中、ringing=来电、active=通话中；idle 表示浮层关闭。
  const overlayOpen = computed(() => status.value !== 'idle')

  function resetLocalState() {
    status.value = 'idle'
    reconnecting.value = false
    callId.value = null
    peer.value = null
    microphoneMuted.value = false
    connectedAt.value = null
  }

  function endSession(reason: CallEndReason) {
    callSession += 1
    endedReason.value = reason
    const target = room
    if (target) {
      target.disconnect()
      room = null
    }
    ctx.removeAudioElements()
    resetLocalState()
  }

  // 发起通话：POST /api/calls，进入呼出中或即时终态（busy/unreachable）。
  async function startCall(target: CallPeer): Promise<void> {
    const user = ctx.currentUser()
    if (!user) return
    if (status.value !== 'idle') return
    status.value = 'outgoing'
    callId.value = null
    peer.value = target
    endedReason.value = null
    try {
      const result = await ctx.startCallRequest(target.userId)
      if (result.state === 'ended') {
        endedReason.value = normalizeEndReason(result.reason)
        resetLocalState()
        return
      }
      callId.value = String(result.callId)
    } catch (error) {
      endedReason.value = null
      resetLocalState()
      throw error
    }
  }

  // 接听（被叫）：POST /api/calls/{callId}/accept 后加入通话房间。
  async function accept(): Promise<void> {
    const id = callId.value
    if (status.value !== 'ringing' || id === null) return
    await ctx.acceptRequest(id)
    status.value = 'active'
    await joinRoom()
  }

  async function reject(): Promise<void> {
    const id = callId.value
    if (status.value !== 'ringing' || id === null) return
    await ctx.rejectRequest(id)
    endSession('rejected')
  }

  async function cancel(): Promise<void> {
    const id = callId.value
    if (status.value !== 'outgoing' || id === null) return
    await ctx.cancelRequest(id)
    endSession('canceled')
  }

  async function hangup(): Promise<void> {
    const id = callId.value
    if (status.value !== 'active' || id === null) return
    await ctx.hangupRequest(id)
    endSession('ended')
  }

  // 通话中麦克风静音（复用全局静音偏好语义；spec 07 / UI 08）。
  async function toggleMicrophoneMute(): Promise<void> {
    const target = room
    if (!target || status.value !== 'active') return
    const next = !microphoneMuted.value
    if (next) {
      await target.localParticipant.setMicrophoneEnabled(false)
      microphoneMuted.value = true
    } else {
      const captureOptions = buildCaptureOptions()
      if (!ctx.microphoneEnabledPreference()) {
        // 全局静音偏好仍在时，通话内解除静音不开启麦克风。
        microphoneMuted.value = false
        return
      }
      await target.localParticipant.setMicrophoneEnabled(true, captureOptions)
      microphoneMuted.value = false
    }
  }

  function buildCaptureOptions() {
    return buildMicrophoneCaptureOptions({
      deviceId: ctx.resolvedPreferredInputDeviceId(),
      echoCancellation: ctx.echoCancellation(),
      noiseSuppression: ctx.noiseSuppression(),
    })
  }

  // 加入通话房间：双方在 accept 后各自取 token 并 connect 到 call-<callID>。
  async function joinRoom(): Promise<void> {
    const id = callId.value
    if (id === null) return
    callSession += 1
    const session = callSession
    try {
      const credentials = await ctx.fetchCallToken(id)
      if (session !== callSession || status.value !== 'active') return
      const nextRoom = markRaw(ctx.createRoom({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: buildCaptureOptions(),
        publishDefaults: {
          audioPreset: { maxBitrate: 64_000 },
          dtx: true,
          red: true,
          forceStereo: false,
        },
        audioOutput: { deviceId: ctx.resolvedPreferredOutputDeviceId() },
      }))
      room = nextRoom
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token)
      if (session !== callSession || room !== nextRoom) return
      connectedAt.value = Date.now()
      // 尊重全局麦克风静音偏好：全局静音时不发布麦克风。
      if (ctx.microphoneEnabledPreference()) {
        await nextRoom.localParticipant.setMicrophoneEnabled(true, buildCaptureOptions())
        if (session !== callSession || room !== nextRoom) return
      } else {
        microphoneMuted.value = true
      }
    } catch (error) {
      if (session !== callSession) return
      endSession('disconnected')
      throw error
    }
  }

  function bindRoom(target: Room) {
    target
      .on(RoomEvent.TrackSubscribed, attachTrack)
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.Reconnecting, () => {
        if (room !== target) return
        reconnecting.value = true
      })
      .on(RoomEvent.Reconnected, () => {
        if (room !== target) return
        reconnecting.value = false
      })
      .on(RoomEvent.Disconnected, () => {
        if (room !== target) return
        // 终端断开（LiveKit 掉线）即 ended(disconnected)，见 spec 04。
        room = null
        endSession('disconnected')
      })
  }

  function attachTrack(track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (track.kind !== Track.Kind.Audio || !(track instanceof RemoteAudioTrack)) return
    const element = track.attach()
    element.dataset.userId = String(participantUserId(participant))
    element.autoplay = true
    element.style.display = 'none'
    ctx.appendAudioElement(element)
    ctx.applyAudioSink(element, ctx.resolvedPreferredOutputDeviceId())
  }

  function detachTrack(track: RemoteTrack) {
    track.detach().forEach((element) => element.remove())
  }

  // WS 点到点信令（app.ts handleEvent 路由到这里）。
  function handleSignal(signal: CallSignal): void {
    if (signal.callId === '') return
    if (signal.callId !== callId.value && status.value !== 'idle') return
    switch (signal.type) {
      case 'call_invite': {
        // 被叫：进入来电态，记录对方与 callId。
        status.value = 'ringing'
        callId.value = signal.callId
        peer.value = signal.peer
        endedReason.value = null
        break
      }
      case 'call_accept': {
        // 主叫：对方接听，加入通话房间。
        if (status.value !== 'outgoing') return
        status.value = 'active'
        void joinRoom()
        break
      }
      case 'call_busy':
      case 'call_unreachable':
      case 'call_reject':
      case 'call_cancel':
      case 'call_timeout':
      case 'call_end': {
        endSession(normalizeTerminalReason(signal.type, signal.reason))
        break
      }
      default:
        break
    }
  }

  return {
    status,
    reconnecting,
    callId,
    peer,
    endedReason,
    microphoneMuted,
    connectedAt,
    joined,
    overlayOpen,
    startCall,
    accept,
    reject,
    cancel,
    hangup,
    toggleMicrophoneMute,
    handleSignal,
    buildCaptureOptions,
  }
}

function normalizeEndReason(reason: string | undefined): CallEndReason {
  if (reason === 'busy' || reason === 'unreachable' || reason === 'rejected' || reason === 'canceled'
    || reason === 'timeout' || reason === 'ended' || reason === 'disconnected') {
    return reason
  }
  return 'ended'
}

// 终端信令事件名 → 终端原因。
function normalizeTerminalReason(type: string, reason: string | undefined): CallEndReason {
  if (reason === 'busy' || reason === 'unreachable' || reason === 'rejected' || reason === 'canceled'
    || reason === 'timeout' || reason === 'ended' || reason === 'disconnected') {
    return reason
  }
  switch (type) {
    case 'call_busy': return 'busy'
    case 'call_unreachable': return 'unreachable'
    case 'call_reject': return 'rejected'
    case 'call_cancel': return 'canceled'
    case 'call_timeout': return 'timeout'
    default: return 'ended'
  }
}
