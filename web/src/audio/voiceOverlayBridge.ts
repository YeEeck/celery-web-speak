export const VOICE_OVERLAY_MIN_PROTOCOL = 1
export const VOICE_OVERLAY_PROTOCOL = 2

const REQUIRED_CAPABILITIES = [
  'voice_overlay',
] as const

export interface VoiceOverlayParticipant {
  identity: string
  name: string
  avatarUrl: string | null
  isLocal: boolean
  speaking: boolean
  microphoneMuted: boolean
  deafened: boolean
}

export interface VoiceOverlayState {
  channel: { name: string } | null
  participants: VoiceOverlayParticipant[]
}

export interface VoiceOverlayConfig {
  scalePercent: number
  positionXPercent: number
  positionYPercent: number
  speakingOpacityPercent: number
  silentOpacityPercent: number
}

export interface DesktopVoiceOverlayBridge {
  hello(input: { minProtocol: number; maxProtocol: number }): Promise<{ protocol: number; capabilities: string[] }>
  setEnabled(enabled: boolean): Promise<void>
  pushState(state: VoiceOverlayState): void
  /** 协议 2 起可用；协议 1 的旧壳不提供。 */
  setConfig?(config: VoiceOverlayConfig): void
}

export interface VoiceOverlayBridgeConnection {
  bridge: DesktopVoiceOverlayBridge
  protocol: number
}

export async function connectVoiceOverlayBridge(): Promise<VoiceOverlayBridgeConnection | null> {
  const bridge = window.desktopVoiceOverlay
  if (!isBridge(bridge)) return null
  try {
    const result = await bridge.hello({
      minProtocol: VOICE_OVERLAY_MIN_PROTOCOL,
      maxProtocol: VOICE_OVERLAY_PROTOCOL,
    })
    if (result.protocol < VOICE_OVERLAY_MIN_PROTOCOL) return null
    if (!REQUIRED_CAPABILITIES.every((capability) => result.capabilities.includes(capability))) return null
    return { bridge, protocol: result.protocol }
  } catch {
    return null
  }
}

function isBridge(value: unknown): value is DesktopVoiceOverlayBridge {
  if (!value || typeof value !== 'object') return false
  return ['hello', 'setEnabled', 'pushState'].every((method) => typeof (value as Record<string, unknown>)[method] === 'function')
}
