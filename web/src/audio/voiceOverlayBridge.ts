// 协议 3 起浮层可用（尺寸由浮层页面按内容上报）；协议 ≤ 2 的旧壳不提供，
// 协商回退时视为浮层整体不可用。
export const VOICE_OVERLAY_MIN_PROTOCOL = 3
export const VOICE_OVERLAY_PROTOCOL = 3

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

// 浮层配置契约：默认值与范围与桌面壳 shared 常量一致（设计文档「浮层配置语义」）。
export const DEFAULT_VOICE_OVERLAY_CONFIG: VoiceOverlayConfig = {
  scalePercent: 100,
  positionXPercent: 9,
  positionYPercent: 50,
  speakingOpacityPercent: 80,
  silentOpacityPercent: 40,
}

export const VOICE_OVERLAY_CONFIG_LIMITS = {
  scalePercent: { min: 50, max: 150 },
  positionPercent: { min: 0, max: 100 },
  opacityPercent: { min: 10, max: 100 },
} as const

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
