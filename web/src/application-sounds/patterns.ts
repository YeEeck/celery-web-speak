export type OperationSoundEvent = 'join' | 'leave' | 'message'

export type SoundPresetId =
  | 'rise-duo'
  | 'fall-duo'
  | 'bright-single'
  | 'low-pulse'
  | 'gentle-triple'

export interface NotePattern {
  delay: number
  duration: number
  from: number
  to: number
}

export interface SoundPreset {
  name: string
  notes: readonly NotePattern[]
}

export const SOUND_PRESETS: Record<SoundPresetId, SoundPreset> = {
  'rise-duo': {
    name: '上升双音',
    notes: [
      { delay: 0, duration: 0.1, from: 440, to: 500 },
      { delay: 0.075, duration: 0.14, from: 620, to: 700 },
    ],
  },
  'fall-duo': {
    name: '下降双音',
    notes: [
      { delay: 0, duration: 0.1, from: 560, to: 500 },
      { delay: 0.075, duration: 0.15, from: 390, to: 320 },
    ],
  },
  'bright-single': {
    name: '清脆单音',
    notes: [{ delay: 0, duration: 0.13, from: 720, to: 840 }],
  },
  'low-pulse': {
    name: '低沉脉冲',
    notes: [
      { delay: 0, duration: 0.18, from: 280, to: 220 },
      { delay: 0.12, duration: 0.18, from: 280, to: 220 },
    ],
  },
  'gentle-triple': {
    name: '柔和三音',
    notes: [
      { delay: 0, duration: 0.1, from: 520, to: 560 },
      { delay: 0.08, duration: 0.1, from: 620, to: 660 },
      { delay: 0.16, duration: 0.12, from: 740, to: 780 },
    ],
  },
}

export const DEFAULT_PRESETS: Record<OperationSoundEvent, SoundPresetId> = {
  join: 'rise-duo',
  leave: 'fall-duo',
  message: 'bright-single',
}

export const MUTED_SPEAKING_NOTES: readonly NotePattern[] = [
  { delay: 0, duration: 0.14, from: 540, to: 430 },
  { delay: 0.2, duration: 0.16, from: 540, to: 400 },
]

export function isSoundPresetId(value: string | null): value is SoundPresetId {
  return value !== null && value in SOUND_PRESETS
}
