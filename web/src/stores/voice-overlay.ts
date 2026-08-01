import { ref, watch } from 'vue'
import {
  connectVoiceOverlayBridge,
  type DesktopVoiceOverlayBridge,
  type VoiceOverlayParticipant,
  type VoiceOverlayState,
} from '../audio/voiceOverlayBridge.ts'
import type { User } from '../types.ts'
import type { VoiceParticipant } from './voice-utils.ts'
import { getSavedBoolean, saveBoolean } from './voice-utils.ts'

export const VOICE_OVERLAY_ENABLED_KEY = 'cws.voiceOverlay.enabled'

const VOICE_OVERLAY_THROTTLE_MS = 100

export interface VoiceOverlayContext {
  status(): string
  connectedChannelName(): string
  participants(): VoiceParticipant[]
  connectedUsers(): User[]
}

export function useVoiceOverlay(ctx: VoiceOverlayContext) {
  const supported = ref(false)
  const enabled = ref(getSavedBoolean(VOICE_OVERLAY_ENABLED_KEY, false))
  let bridge: DesktopVoiceOverlayBridge | null = null
  let initialized = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let lastUrgentSignature: string | null = null

  async function initializeVoiceOverlay() {
    if (initialized) return
    initialized = true
    const connected = await connectVoiceOverlayBridge()
    if (!connected) return
    bridge = connected
    supported.value = true
    try {
      await bridge.setEnabled(enabled.value)
    } catch {
      supported.value = false
      bridge = null
      return
    }
    pushNow()
    watch(
      () => ctx.participants(),
      (current) => {
        const signature = participantUrgentSignature(current)
        if (signature !== lastUrgentSignature) {
          lastUrgentSignature = signature
          pushNow()
        } else {
          schedulePush()
        }
      },
      { deep: true },
    )
    watch(
      () => [ctx.status(), ctx.connectedChannelName()],
      () => pushNow(),
    )
  }

  function setOverlayEnabled(value: boolean) {
    enabled.value = value
    saveBoolean(VOICE_OVERLAY_ENABLED_KEY, value)
    if (!bridge) return
    void bridge.setEnabled(value).catch(() => undefined)
    if (value) pushNow()
    else cancelPendingPush()
  }

  function schedulePush() {
    if (pendingTimer !== null || !bridge || !enabled.value) return
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      pushNow()
    }, VOICE_OVERLAY_THROTTLE_MS)
  }

  function pushNow() {
    cancelPendingPush()
    if (!bridge || !enabled.value) return
    bridge.pushState(buildState())
  }

  function cancelPendingPush() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  function buildState(): VoiceOverlayState {
    const connected = ctx.status() === 'connected' || ctx.status() === 'reconnecting'
    const channelName = ctx.connectedChannelName()
    if (!connected || !channelName) return { channel: null, participants: [] }
    const users = new Map(ctx.connectedUsers().map((user) => [user.id, user]))
    return {
      channel: { name: channelName },
      participants: ctx.participants().map((participant) => toOverlayParticipant(participant, users)),
    }
  }

  return {
    supported,
    enabled,
    initializeVoiceOverlay,
    setOverlayEnabled,
  }
}

function toOverlayParticipant(participant: VoiceParticipant, users: Map<number, User>): VoiceOverlayParticipant {
  const user = users.get(participant.userId)
  return {
    identity: participant.identity,
    name: participant.name,
    avatarUrl: user && user.hasAvatar && user.avatarVersion >= 1
      ? `${window.location.origin}/api/users/${user.id}/avatar?v=${user.avatarVersion}`
      : null,
    isLocal: participant.isLocal,
    speaking: participant.isSpeaking,
    microphoneMuted: !participant.microphoneEnabled,
    deafened: participant.deafened,
  }
}

// 深度监听的回调不提供可靠的旧值（旧值即当前对象），紧急变化检测改为
// 基于当前参与者快照的签名：成员进出、静音与聋变化都会改变签名。
function participantUrgentSignature(participants: VoiceParticipant[]): string {
  return participants
    .map((item) => `${item.identity}:${item.microphoneEnabled ? 'on' : 'off'}:${item.deafened ? 'deafened' : 'heard'}`)
    .sort()
    .join('|')
}
