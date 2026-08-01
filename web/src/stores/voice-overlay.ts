import { ref, watch } from 'vue'
import {
  connectVoiceOverlayBridge,
  type DesktopVoiceOverlayBridge,
  type VoiceOverlayConfig,
  type VoiceOverlayParticipant,
  type VoiceOverlayState,
} from '../audio/voiceOverlayBridge.ts'
import type { User } from '../types.ts'
import type { VoiceParticipant } from './voice-utils.ts'
import { getSavedBoolean, saveBoolean } from './voice-utils.ts'

export const VOICE_OVERLAY_ENABLED_KEY = 'cws.voiceOverlay.enabled'
export const VOICE_OVERLAY_CONFIG_KEY = 'cws.voiceOverlay.config'

const VOICE_OVERLAY_THROTTLE_MS = 100
const VOICE_OVERLAY_CONFIG_THROTTLE_MS = 50

export const DEFAULT_VOICE_OVERLAY_CONFIG: VoiceOverlayConfig = {
  scalePercent: 100,
  positionXPercent: 9,
  positionYPercent: 50,
  speakingOpacityPercent: 80,
  silentOpacityPercent: 40,
}

const VOICE_OVERLAY_CONFIG_LIMITS = {
  scalePercent: { min: 50, max: 150 },
  positionPercent: { min: 0, max: 100 },
  opacityPercent: { min: 10, max: 100 },
} as const

export interface VoiceOverlayContext {
  status(): string
  connectedChannelName(): string
  participants(): VoiceParticipant[]
  connectedUsers(): User[]
}

export function useVoiceOverlay(ctx: VoiceOverlayContext) {
  const supported = ref(false)
  const enabled = ref(getSavedBoolean(VOICE_OVERLAY_ENABLED_KEY, false))
  const config = ref<VoiceOverlayConfig>(loadSavedConfig())
  const configSupported = ref(false)
  let bridge: DesktopVoiceOverlayBridge | null = null
  let initialized = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let configTimer: ReturnType<typeof setTimeout> | null = null
  let lastUrgentSignature: string | null = null

  async function initializeVoiceOverlay() {
    if (initialized) return
    initialized = true
    const connection = await connectVoiceOverlayBridge()
    if (!connection) return
    bridge = connection.bridge
    supported.value = true
    configSupported.value = connection.protocol >= 2
    try {
      await bridge.setEnabled(enabled.value)
    } catch {
      supported.value = false
      configSupported.value = false
      bridge = null
      return
    }
    if (configSupported.value) bridge.setConfig?.(config.value)
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

  function setOverlayConfig(partial: Partial<VoiceOverlayConfig>) {
    config.value = clampConfig({ ...config.value, ...partial })
    saveConfig(config.value)
    scheduleConfigPush()
  }

  function schedulePush() {
    if (pendingTimer !== null || !bridge || !enabled.value) return
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      pushNow()
    }, VOICE_OVERLAY_THROTTLE_MS)
  }

  function scheduleConfigPush() {
    if (configTimer !== null || !bridge || !configSupported.value) return
    configTimer = setTimeout(() => {
      configTimer = null
      bridge?.setConfig?.(config.value)
    }, VOICE_OVERLAY_CONFIG_THROTTLE_MS)
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
    config,
    configSupported,
    initializeVoiceOverlay,
    setOverlayEnabled,
    setOverlayConfig,
  }
}

function loadSavedConfig(): VoiceOverlayConfig {
  const config: VoiceOverlayConfig = { ...DEFAULT_VOICE_OVERLAY_CONFIG }
  try {
    const raw = localStorage.getItem(VOICE_OVERLAY_CONFIG_KEY)
    if (raw) Object.assign(config, JSON.parse(raw))
  } catch {
    // 损坏的存储回退到默认配置
  }
  return clampConfig(config)
}

function clampConfig(config: VoiceOverlayConfig): VoiceOverlayConfig {
  return {
    scalePercent: clampConfigValue(config.scalePercent, VOICE_OVERLAY_CONFIG_LIMITS.scalePercent),
    positionXPercent: clampConfigValue(config.positionXPercent, VOICE_OVERLAY_CONFIG_LIMITS.positionPercent),
    positionYPercent: clampConfigValue(config.positionYPercent, VOICE_OVERLAY_CONFIG_LIMITS.positionPercent),
    speakingOpacityPercent: clampConfigValue(config.speakingOpacityPercent, VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent),
    silentOpacityPercent: clampConfigValue(config.silentOpacityPercent, VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent),
  }
}

function saveConfig(config: VoiceOverlayConfig): void {
  localStorage.setItem(VOICE_OVERLAY_CONFIG_KEY, JSON.stringify(config))
}

function clampConfigValue(value: number, limit: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return limit.min
  return Math.min(limit.max, Math.max(limit.min, value))
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
