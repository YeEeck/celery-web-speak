export const VOICE_LEVEL_COLOR_CAP = 100

export function voiceLevelColorProgressPercent(level: number): number {
  if (Number.isNaN(level)) return 0
  return (Math.min(VOICE_LEVEL_COLOR_CAP, Math.max(0, level)) / VOICE_LEVEL_COLOR_CAP) * 100
}
