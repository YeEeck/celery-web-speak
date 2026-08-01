import type { VoiceOverlayConfig } from '../audio/voiceOverlayBridge.ts'

// 与 UserAvatar 的初始逻辑保持一致：代理对按码点取首字符并大写。
export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() || '?'
}

export function rowOpacityPercent(config: VoiceOverlayConfig, speaking: boolean): number {
  return speaking ? config.speakingOpacityPercent : config.silentOpacityPercent
}
