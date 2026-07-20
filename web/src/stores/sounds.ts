import { ref } from 'vue'
import { defineStore } from 'pinia'

export type NotificationSound = 'join' | 'leave' | 'message'

const DEFAULT_VOLUME = 0.6
const MIN_INTERVAL_MS = 300
const STORAGE_PREFIX = 'cws.notificationSounds'

const soundNotes: Record<NotificationSound, Array<{ delay: number; duration: number; from: number; to: number }>> = {
  join: [
    { delay: 0, duration: 0.1, from: 440, to: 500 },
    { delay: 0.075, duration: 0.14, from: 620, to: 700 },
  ],
  leave: [
    { delay: 0, duration: 0.1, from: 560, to: 500 },
    { delay: 0.075, duration: 0.15, from: 390, to: 320 },
  ],
  message: [
    { delay: 0, duration: 0.13, from: 720, to: 840 },
  ],
}

export const useSoundStore = defineStore('sounds', () => {
  const enabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.enabled`))
  const volume = ref(getSavedVolume())
  const joinEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.join`))
  const leaveEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.leave`))
  const messageEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.message`))
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

  function play(sound: NotificationSound) {
    if (!enabled.value || volume.value === 0 || suppressed.value || !isSoundEnabled(sound) || !context) return
    const now = performance.now()
    if (now - lastPlayed[sound] < MIN_INTERVAL_MS) return
    lastPlayed[sound] = now

    const target = context
    const ready = target.state === 'running' ? Promise.resolve() : target.resume()
    void ready.then(async () => {
      if (target.state !== 'running' || volume.value === 0 || suppressed.value || !enabled.value || !isSoundEnabled(sound)) return
      await applyOutputDevice(target)
      scheduleSound(target, sound, volume.value)
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
    installInteractionUnlock,
    removeInteractionUnlock,
    play,
    setEnabled,
    setVolume,
    setSoundEnabled,
    setSuppressed,
    setOutputDevice,
  }
})

function scheduleSound(context: AudioContext, sound: NotificationSound, volume: number) {
  const start = context.currentTime + 0.005
  const master = context.createGain()
  master.gain.setValueAtTime(volume * 0.18, start)
  master.connect(context.destination)

  const notes = soundNotes[sound]
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
