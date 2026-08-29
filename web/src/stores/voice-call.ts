import { computed, markRaw, ref, watch } from 'vue'
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
import { ApiError } from '../api.ts'
import { MicrophonePublishOrchestrator } from '../audio/MicrophonePublishOrchestrator.ts'
import { VoiceAudioContextController } from '../audio/VoiceAudioContextController.ts'
import type { VoiceCredentials } from '../types.ts'
import {
  type CallEndReason,
  type CallPeer,
  type CallSignal,
  type CallStatus,
  normalizeCallEndReason,
} from './call-signal.ts'
import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  participantUserId,
  resolveNoiseSuppression,
  type NoiseSuppressionOption,
  type VoiceTransmissionMode,
} from './voice-utils.ts'

// 1:1 临时语音通话的会话状态机（spec 04/05）。与 voice-session 并列：两者各
// 自持有一条 LiveKit Room 连接（频道房间与通话房间并存，ADR-0032），互不侵入。
// 事件形状与终态归类归 call-signal module（ADR-0033）；这里只消费 typed signal。

// POST /api/calls 的响应。
export interface StartCallResult {
  callId: string
  state: string
  reason?: string
}

export interface VoiceCallContext {
  currentUser(): { id: number } | null
  createRoom(options: RoomOptions): Room
  createAudioContext(): AudioContext | null
  audioInteractionTarget(): EventTarget
  loadRnnoiseBinary(): Promise<ArrayBuffer | null>
  microphoneGainInitial(): number
  transmissionMode(): VoiceTransmissionMode
  noiseSuppressionOption(): NoiseSuppressionOption

  // HTTP 信令动作（后端仲裁，见 spec 05）。
  startCallRequest(calleeUserId: number): Promise<StartCallResult>
  acceptRequest(callId: string): Promise<void>
  rejectRequest(callId: string): Promise<void>
  // 来电浮层「暂时屏蔽 24 小时」先持久化单向屏蔽、再拒绝当前来电。
  setTemporaryBlockRequest(targetUserId: number): Promise<void>
  cancelRequest(callId: string): Promise<void>
  hangupRequest(callId: string): Promise<void>
  fetchCallToken(callId: string): Promise<VoiceCredentials>

  // 设备/采集偏好。麦克风发布走本会话的编排器实例（ADR-0034）。
  resolvedPreferredInputDeviceId(): string
  resolvedPreferredOutputDeviceId(): string
  echoCancellation(): boolean
  microphoneEnabledPreference(): boolean
  // 切换全局麦克风静音偏好（通话中麦克风静音与快捷键共用同一偏好，spec 07/08）。
  toggleMicrophonePreference(): Promise<void>
  // 全局耳机静音会静音通话远端音频（spec 07）；false 时恢复。
  deafenedPreference(): boolean
  setRemoteAudioMuted(muted: boolean): void

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
  let callAudioContext: AudioContext | null = null
  let callAudioContextController: VoiceAudioContextController | null = null
  // 发起 HTTP 请求尚未返回期间，WS 信令（对方秒接/秒拒等）可能先到；先缓存，
  // 拿到 callId 后再按序回放（HTTP 与 WS 是两条连接，无到达顺序保证）。
  let startCallInFlight = false
  const pendingSignals: CallSignal[] = []

  const microphoneOrchestrator = new MicrophonePublishOrchestrator({
    gain: ctx.microphoneGainInitial(),
    noiseSuppressionOption: () => ctx.noiseSuppressionOption(),
    webRtcNoiseSuppression: () => resolveNoiseSuppression(
      ctx.noiseSuppressionOption(),
      callAudioContext !== null && callAudioContext.state !== 'closed' && callAudioContext.sampleRate === 48_000,
    ),
    resolvedPreferredInputDeviceId: () => ctx.resolvedPreferredInputDeviceId(),
    echoCancellation: () => ctx.echoCancellation(),
    publishSettings: () => ({ audioBitrateKbps: DEFAULT_AUDIO_BITRATE_KBPS, audioRedEnabled: true }),
    isAudioContextAvailable: () => callAudioContext !== null && callAudioContext.state !== 'closed',
    transmissionMode: () => ctx.transmissionMode(),
    isSessionLive: () => status.value === 'active',
    loadRnnoiseBinary: () => ctx.loadRnnoiseBinary(),
  })

  // 浮层三形态：outgoing=呼出中、ringing=来电、active=通话中；idle 表示浮层关闭。
  const overlayOpen = computed(() => status.value !== 'idle')

  function callMicrophoneEnabled() {
    return ctx.microphoneEnabledPreference() && !ctx.deafenedPreference()
  }

  async function syncCallMicrophone() {
    const target = room
    if (!target || status.value !== 'active') return
    const session = callSession
    const enabled = callMicrophoneEnabled()
    try {
      await microphoneOrchestrator.applyMicrophoneState({
        enabled,
        transmissionMode: ctx.transmissionMode(),
      })
      if (session === callSession && room === target) microphoneMuted.value = !enabled
    } catch {
      // 静音切换失败保留当前状态；下一次偏好变化会重试。
    }
  }

  async function destroyCallAudioContext() {
    const controller = callAudioContextController
    callAudioContextController = null
    callAudioContext = null
    if (controller) await controller.destroy()
  }

  // 全局耳机静音联动通话远端音频（spec 07：通话中主动耳机静音会静音通话）。
  watch(() => ctx.deafenedPreference(), (deafened) => {
    ctx.setRemoteAudioMuted(deafened)
    void syncCallMicrophone()
    // ADR-0005 / ADR-0031：解除全局耳机静音时对通话房间走门控 startAudio，
    // 不经过频道 mute-deafen 的 startAudio（只打频道房间）。
    if (!deafened) void callAudioContextController?.ensureRunning()
  })

  // 全局麦克风静音偏好联动通话麦克风：入口按偏好发布，通话中切换（按钮或
  // Ctrl+Shift+M 快捷键）同步到通话房间（spec 07/08 同一偏好）。
  watch(() => ctx.microphoneEnabledPreference(), () => {
    void syncCallMicrophone()
  })

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
    microphoneOrchestrator.endSession()
    const target = room
    if (target) {
      target.disconnect()
      room = null
    }
    ctx.removeAudioElements()
    resetLocalState()
    void destroyCallAudioContext()
  }

  // 发起通话：POST /api/calls，进入呼出中或即时终态（busy/unreachable）。
  async function startCall(target: CallPeer): Promise<void> {
    const user = ctx.currentUser()
    if (!user) return
    if (status.value !== 'idle') return
    startCallInFlight = true
    status.value = 'outgoing'
    callId.value = null
    peer.value = target
    endedReason.value = null
    try {
      const result = await ctx.startCallRequest(target.userId)
      if (result.state === 'ended') {
        // 即时终态以 HTTP 响应为准；期间早到的终态信令不再回放（避免覆盖 reason）。
        pendingSignals.length = 0
        endedReason.value = normalizeCallEndReason(result.reason)
        resetLocalState()
        return
      }
      callId.value = String(result.callId)
      // 回放发起期间早到的 WS 信令（如对方秒接的 call_accept / 秒拒的 call_reject）。
      const signals = pendingSignals.splice(0)
      for (const signal of signals) handleSignal(signal)
    } catch (error) {
      pendingSignals.length = 0
      endedReason.value = null
      resetLocalState()
      throw error
    } finally {
      startCallInFlight = false
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

  // 来电态「暂时屏蔽 24 小时」：先设置屏蔽再拒绝。屏蔽成功而通话已不在
  // 振铃（call_not_ringing，例如恰好超时）视为动作成功；其余 reject 失败
  // 保留振铃态并抛出，但不得误报屏蔽失败——屏蔽已生效，重试会重新计时
  // 24 小时（spec：任何变为暂时屏蔽的操作都重新计时），如实提示即可。
  async function rejectAndBlockTemporarily(): Promise<void> {
    const id = callId.value
    const target = peer.value
    if (status.value !== 'ringing' || id === null || target === null) return
    await ctx.setTemporaryBlockRequest(target.userId)
    try {
      await ctx.rejectRequest(id)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'call_not_ringing') {
        endSession('rejected')
        return
      }
      throw new Error('已屏蔽对方，但通话结束失败，请重试')
    }
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

  // 通话中麦克风静音：切换全局麦克风静音偏好（与 Ctrl+Shift+M 同一偏好，spec
  // 07/08）。watch 会把偏好同步到通话房间，本函数不直接操作 LiveKit 轨道。
  async function toggleMicrophoneMute(): Promise<void> {
    if (status.value !== 'active') return
    await ctx.toggleMicrophonePreference()
  }

  // 加入通话房间：双方在 accept 后各自取 token 并 connect 到 call-<callID>。
  // 麦克风发布经本会话的编排器（ADR-0034）。
  async function joinRoom(): Promise<void> {
    const id = callId.value
    if (id === null) return
    callSession += 1
    const session = callSession
    microphoneOrchestrator.invalidate()
    if (callAudioContextController || callAudioContext) await destroyCallAudioContext()
    try {
      const credentials = await ctx.fetchCallToken(id)
      if (session !== callSession || status.value !== 'active') return
      callAudioContext = ctx.createAudioContext()
      const nextRoom = markRaw(ctx.createRoom({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: callAudioContext ? { audioContext: callAudioContext } : true,
        audioCaptureDefaults: microphoneOrchestrator.buildCaptureOptions(),
        publishDefaults: {
          audioPreset: { maxBitrate: DEFAULT_AUDIO_BITRATE_KBPS * 1000 },
          dtx: ctx.transmissionMode() === 'voice-activity',
          red: true,
          forceStereo: false,
        },
        audioOutput: { deviceId: ctx.resolvedPreferredOutputDeviceId() },
      }))
      room = nextRoom
      microphoneOrchestrator.beginSession(nextRoom)
      if (callAudioContext) {
        callAudioContextController = new VoiceAudioContextController(callAudioContext, {
          startAudio: () => nextRoom.startAudio(),
          shouldResume: () => room === nextRoom && status.value === 'active' && !ctx.deafenedPreference(),
          interactionTarget: ctx.audioInteractionTarget(),
          onError: (error) => console.warn('通话音频自动恢复失败', error),
        })
      }
      bindRoom(nextRoom)
      await nextRoom.connect(credentials.url, credentials.token)
      if (session !== callSession || room !== nextRoom) return
      connectedAt.value = Date.now()
      const enabled = callMicrophoneEnabled()
      await microphoneOrchestrator.applyMicrophoneState({
        enabled,
        transmissionMode: ctx.transmissionMode(),
      })
      if (session !== callSession || room !== nextRoom) return
      microphoneMuted.value = !enabled
      callAudioContextController?.resumeIfNeeded()
    } catch {
      if (session !== callSession) return
      // 取 token / 建房失败时先向后端挂断，让对端收到终态信令而不是被留在
      // 只有自己的 active 通话里；挂断请求的失败本身不影响本地清理。
      const id = callId.value
      if (id !== null) {
        await ctx.hangupRequest(id).catch(() => undefined)
      }
      if (session !== callSession) return
      endSession('disconnected')
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
    element.muted = ctx.deafenedPreference()
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
    // 发起请求尚未返回、callId 未知时，信令可能早于 HTTP 响应到达；缓存待回放。
    if (startCallInFlight && status.value === 'outgoing' && callId.value === null) {
      pendingSignals.push(signal)
      return
    }
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
      case 'call_unavailable':
      case 'call_unreachable':
      case 'call_reject':
      case 'call_cancel':
      case 'call_timeout':
      case 'call_end': {
        // typed contract（ADR-0033）：终态事件经 call-signal 解析后 reason 必为
        // 合法值；null 只属于非终态事件，出现于此的畸形信号忽略。
        if (signal.reason === null) return
        endSession(signal.reason)
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
    overlayOpen,
    startCall,
    accept,
    reject,
    rejectAndBlockTemporarily,
    cancel,
    hangup,
    toggleMicrophoneMute,
    handleSignal,
    applyMicrophoneGain: (volume: number) => {
      microphoneOrchestrator.setGain(volume)
    },
    applyNoiseSuppressionOption: (option: NoiseSuppressionOption) => {
      void microphoneOrchestrator.applyMicrophoneState({ noiseSuppression: option })
    },
    applyTransmissionMode: () => {
      void microphoneOrchestrator.applyMicrophoneState({ transmissionMode: ctx.transmissionMode() })
    },
  }
}
