import { ref } from 'vue'
import { defineStore } from 'pinia'

export type NotificationSound = 'join' | 'leave' | 'message'

interface PlaySoundOptions {
  bypassRateLimit?: boolean
}

const DEFAULT_VOLUME = 0.6
const MIN_INTERVAL_MS = 300
const STORAGE_PREFIX = 'cws.notificationSounds'

export type SoundPresetId = 'rise-duo' | 'fall-duo' | 'bright-single' | 'low-pulse' | 'gentle-triple'

interface NotePattern { delay: number; duration: number; from: number; to: number }

export const SOUND_PRESETS: Record<SoundPresetId, { name: string; notes: NotePattern[] }> = {
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
    notes: [
      { delay: 0, duration: 0.13, from: 720, to: 840 },
    ],
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

const DEFAULT_PRESETS: Record<NotificationSound, SoundPresetId> = {
  join: 'rise-duo',
  leave: 'fall-duo',
  message: 'bright-single',
}

export const useSoundStore = defineStore('sounds', () => {
  const enabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.enabled`))
  const volume = ref(getSavedVolume())
  const joinEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.join`))
  const leaveEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.leave`))
  const messageEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.message`))
  const joinPreset = ref<SoundPresetId>(getSavedPreset('join'))
  const leavePreset = ref<SoundPresetId>(getSavedPreset('leave'))
  const messagePreset = ref<SoundPresetId>(getSavedPreset('message'))
  const suppressed = ref(false)
  let context: AudioContext | null = null
  let outputDeviceId = ''
  let appliedOutputDeviceId: string | null = null
  let listenersInstalled = false
  const lastPlayed: Record<NotificationSound, number> = { join: -Infinity, leave: -Infinity, message: -Infinity }

  function installInteractionUnlock() {
    if (listenersInstalled) return
    listenersInstalled = true
    document.addEventListener('pointerdown', unlockAudio, true)
    document.addEventListener('keydown', unlockAudio, true)
  }

  function removeInteractionUnlock() {
    if (!listenersInstalled) return
    listenersInstalled = false
    document.removeEventListener('pointerdown', unlockAudio, true)
    document.removeEventListener('keydown', unlockAudio, true)
  }

  function play(sound: NotificationSound, options: PlaySoundOptions = {}) {
    if (!enabled.value || volume.value === 0 || suppressed.value || !isSoundEnabled(sound) || !context) return
    const now = performance.now()
    if (!options.bypassRateLimit && now - lastPlayed[sound] < MIN_INTERVAL_MS) return
    lastPlayed[sound] = now

    const target = context
    const ready = target.state === 'running' ? Promise.resolve() : target.resume()
    void ready.then(async () => {
      if (target.state !== 'running' || volume.value === 0 || suppressed.value || !enabled.value || !isSoundEnabled(sound)) return
      await applyOutputDevice(target)
      scheduleSound(target, sound, volume.value, getSoundPreset(sound))
    }).catch(() => undefined)
  }

  function setEnabled(value: boolean) {
    enabled.value = value
    saveBoolean(`${STORAGE_PREFIX}.enabled`, value)
  }

  function setVolume(value: number) {
    const normalized = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_VOLUME
    volume.value = normalized
    localStorage.setItem(`${STORAGE_PREFIX}.volume`, String(normalized))
  }

  function setSoundEnabled(sound: NotificationSound, value: boolean) {
    if (sound === 'join') joinEnabled.value = value
    if (sound === 'leave') leaveEnabled.value = value
    if (sound === 'message') messageEnabled.value = value
    saveBoolean(`${STORAGE_PREFIX}.${sound}`, value)
  }

  function setSoundPreset(sound: NotificationSound, preset: SoundPresetId) {
    if (sound === 'join') joinPreset.value = preset
    if (sound === 'leave') leavePreset.value = preset
    if (sound === 'message') messagePreset.value = preset
    localStorage.setItem(`${STORAGE_PREFIX}.preset.${sound}`, preset)
  }

  function setSuppressed(value: boolean) {
    suppressed.value = value
  }

  function setOutputDevice(deviceId: string) {
    outputDeviceId = deviceId
    appliedOutputDeviceId = null
    if (context) void applyOutputDevice(context)
  }

  function unlockAudio() {
    const target = getAudioContext()
    if (target.state !== 'running') void target.resume().catch(() => undefined)
  }

  function getAudioContext() {
    if (!context) context = new AudioContext()
    return context
  }

  function isSoundEnabled(sound: NotificationSound) {
    if (sound === 'join') return joinEnabled.value
    if (sound === 'leave') return leaveEnabled.value
    return messageEnabled.value
  }

  function getSoundPreset(sound: NotificationSound): SoundPresetId {
    if (sound === 'join') return joinPreset.value
    if (sound === 'leave') return leavePreset.value
    return messagePreset.value
  }

  async function applyOutputDevice(target: AudioContext) {
    const routable = target as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> }
    if (!routable.setSinkId || appliedOutputDeviceId === outputDeviceId) return
    try {
      await routable.setSinkId(outputDeviceId)
      appliedOutputDeviceId = outputDeviceId
    } catch {
      if (!outputDeviceId) return
      try {
        await routable.setSinkId('')
        appliedOutputDeviceId = ''
      } catch {
        // The browser keeps its current or system-default output when routing is unavailable.
      }
    }
  }

  return {
    enabled,
    volume,
    joinEnabled,
    leaveEnabled,
    messageEnabled,
    joinPreset,
    leavePreset,
    messagePreset,
    installInteractionUnlock,
    removeInteractionUnlock,
    play,
    setEnabled,
    setVolume,
    setSoundEnabled,
    setSoundPreset,
    setSuppressed,
    setOutputDevice,
  }
})

function scheduleSound(context: AudioContext, sound: NotificationSound, volume: number, preset: SoundPresetId) {
  const start = context.currentTime + 0.005
  const master = context.createGain()
  master.gain.setValueAtTime(volume * 0.18, start)
  master.connect(context.destination)

  const notes = SOUND_PRESETS[preset].notes
  for (const [index, note] of notes.entries()) {
    const noteStart = start + note.delay
    const noteEnd = noteStart + note.duration
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(note.from, noteStart)
    oscillator.frequency.exponentialRampToValueAtTime(note.to, noteEnd)
    envelope.gain.setValueAtTime(0.0001, noteStart)
    envelope.gain.exponentialRampToValueAtTime(1, noteStart + 0.012)
    envelope.gain.exponentialRampToValueAtTime(0.0001, noteEnd)
    oscillator.connect(envelope)
    envelope.connect(master)
    if (index === notes.length - 1) oscillator.addEventListener('ended', () => master.disconnect(), { once: true })
    oscillator.start(noteStart)
    oscillator.stop(noteEnd + 0.01)
  }
}

function getSavedBoolean(key: string) {
  return localStorage.getItem(key) !== 'false'
}

function getSavedVolume() {
  const saved = Number(localStorage.getItem(`${STORAGE_PREFIX}.volume`))
  if (!Number.isFinite(saved) || localStorage.getItem(`${STORAGE_PREFIX}.volume`) === null) return DEFAULT_VOLUME
  return Math.max(0, Math.min(1, saved))
}

function saveBoolean(key: string, value: boolean) {
  localStorage.setItem(key, String(value))
}

function getSavedPreset(sound: NotificationSound): SoundPresetId {
  const saved = localStorage.getItem(`${STORAGE_PREFIX}.preset.${sound}`)
  if (saved && saved in SOUND_PRESETS) return saved as SoundPresetId
  return DEFAULT_PRESETS[sound]
}
