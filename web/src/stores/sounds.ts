import { ref } from 'vue'
import { defineStore } from 'pinia'

export type NotificationSound = 'join' | 'leave' | 'message'

interface PlaySoundOptions {
  bypassRateLimit?: boolean
}

export type SoundSource = 'preset' | 'custom'

export interface CustomSoundRecord {
  event: NotificationSound
  blob: Blob
  name: string
  size: number
  mime: string
  addedAt: number
}

export type CustomSoundUploadResult =
  | { ok: true }
  | { ok: false; error: string }

const DEFAULT_VOLUME = 0.6
const MIN_INTERVAL_MS = 300
const STORAGE_PREFIX = 'cws.notificationSounds'

export type SoundPresetId = 'rise-duo' | 'fall-duo' | 'bright-single' | 'low-pulse' | 'gentle-triple'

interface NotePattern { delay: number; duration: number; from: number; to: number }

const MUTED_SPEAKING_NOTES: NotePattern[] = [
  { delay: 0, duration: 0.14, from: 540, to: 430 },
  { delay: 0.2, duration: 0.16, from: 540, to: 400 },
]

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

const MAX_FILE_SIZE = 512 * 1024
const MAX_DURATION_SECONDS = 3
const ALLOWED_CUSTOM_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
]

const DB_NAME = 'cws.sounds'
const DB_VERSION = 1
const STORE_NAME = 'customSounds'

export const useSoundStore = defineStore('sounds', () => {
  const enabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.enabled`))
  const volume = ref(getSavedVolume())
  const joinEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.join`))
  const leaveEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.leave`))
  const messageEnabled = ref(getSavedBoolean(`${STORAGE_PREFIX}.message`))
  const joinPreset = ref<SoundPresetId>(getSavedPreset('join'))
  const leavePreset = ref<SoundPresetId>(getSavedPreset('leave'))
  const messagePreset = ref<SoundPresetId>(getSavedPreset('message'))
  const joinSource = ref<SoundSource>(getSavedSource('join'))
  const leaveSource = ref<SoundSource>(getSavedSource('leave'))
  const messageSource = ref<SoundSource>(getSavedSource('message'))
  ;(['join', 'leave', 'message'] as NotificationSound[]).forEach((s) => {
    if (localStorage.getItem(`${STORAGE_PREFIX}.source.${s}`) !== 'custom') {
      localStorage.setItem(`${STORAGE_PREFIX}.source.${s}`, 'preset')
    }
    if (!localStorage.getItem(`${STORAGE_PREFIX}.preset.${s}`)) {
      localStorage.setItem(`${STORAGE_PREFIX}.preset.${s}`, DEFAULT_PRESETS[s])
    }
  })
  const joinCustom = ref<CustomSoundRecord | null>(null)
  const leaveCustom = ref<CustomSoundRecord | null>(null)
  const messageCustom = ref<CustomSoundRecord | null>(null)
  const suppressed = ref(false)
  let context: AudioContext | null = null
  let outputDeviceId = ''
  let appliedOutputDeviceId: string | null = null
  let listenersInstalled = false
  const lastPlayed: Record<NotificationSound, number> = { join: -Infinity, leave: -Infinity, message: -Infinity }
  const bufferCache = new Map<NotificationSound, AudioBuffer>()
  const decodingTasks = new Map<NotificationSound, Promise<AudioBuffer | null>>()

  void loadCustomRecords()

  async function loadCustomRecords() {
    const records = await Promise.all([
      idbGetCustomSound('join'),
      idbGetCustomSound('leave'),
      idbGetCustomSound('message'),
    ])
    joinCustom.value = records[0]
    leaveCustom.value = records[1]
    messageCustom.value = records[2]
  }

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
    resolveAndPlay(sound, context, true)
  }

  function playMutedSpeakingReminder() {
    if (!enabled.value || volume.value === 0 || suppressed.value) return
    const target = getAudioContext()
    const ready = target.state === 'running' ? Promise.resolve() : target.resume()
    void ready.then(async () => {
      if (target.state !== 'running' || volume.value === 0 || suppressed.value || !enabled.value) return
      await applyOutputDevice(target)
      scheduleNotes(target, MUTED_SPEAKING_NOTES, volume.value)
    }).catch((error) => {
      console.warn('静音说话提示音播放失败', error)
    })
  }

  function preview(sound: NotificationSound) {
    if (suppressed.value) return
    resolveAndPlay(sound, getAudioContext(), false)
  }

  function resolveAndPlay(sound: NotificationSound, target: AudioContext, requireEnabled: boolean) {
    const ready = target.state === 'running' ? Promise.resolve() : target.resume()
    void ready.then(async () => {
      if (target.state !== 'running' || volume.value === 0 || suppressed.value) return
      if (requireEnabled && (!enabled.value || !isSoundEnabled(sound))) return
      await applyOutputDevice(target)
      if (getSource(sound) === 'custom') {
        const buffer = await getCustomBuffer(sound)
        if (!buffer) return
        if (target.state !== 'running' || volume.value === 0 || suppressed.value) return
        if (requireEnabled && (!enabled.value || !isSoundEnabled(sound))) return
        scheduleCustomSound(target, buffer, volume.value)
      } else {
        scheduleSound(target, volume.value, getSoundPreset(sound))
      }
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
    setSource(sound, 'preset')
  }

  function setSoundSource(sound: NotificationSound, source: SoundSource) {
    setSource(sound, source)
  }

  function setSuppressed(value: boolean) {
    suppressed.value = value
  }

  function setOutputDevice(deviceId: string) {
    outputDeviceId = deviceId
    appliedOutputDeviceId = null
    if (context) void applyOutputDevice(context)
  }

  async function uploadCustomSound(sound: NotificationSound, file: File): Promise<CustomSoundUploadResult> {
    if (file.size > MAX_FILE_SIZE) {
      return { ok: false, error: '音频大小不能超过 512 KB' }
    }
    if (!isAllowedCustomMime(file.type)) {
      return { ok: false, error: '请选择 MP3、WAV、OGG、M4A 或 WEBM 音频' }
    }
    const target = getAudioContext()
    let buffer: AudioBuffer
    try {
      buffer = await target.decodeAudioData(await file.arrayBuffer())
    } catch {
      return { ok: false, error: '无法解析该音频，请尝试其他文件' }
    }
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration === 0) {
      return { ok: false, error: '无法解析该音频，请尝试其他文件' }
    }
    if (buffer.duration > MAX_DURATION_SECONDS) {
      return { ok: false, error: '音频时长不能超过 3 秒' }
    }
    const record: CustomSoundRecord = {
      event: sound,
      blob: file,
      name: file.name,
      size: file.size,
      mime: file.type,
      addedAt: Date.now(),
    }
    try {
      await idbPutCustomSound(record)
    } catch {
      return { ok: false, error: '保存自定义音效失败，请重试' }
    }
    bufferCache.set(sound, buffer)
    decodingTasks.delete(sound)
    if (sound === 'join') joinCustom.value = record
    if (sound === 'leave') leaveCustom.value = record
    if (sound === 'message') messageCustom.value = record
    setSource(sound, 'custom')
    return { ok: true }
  }

  async function removeCustomSound(sound: NotificationSound) {
    bufferCache.delete(sound)
    decodingTasks.delete(sound)
    try {
      await idbDeleteCustomSound(sound)
    } catch {
      return
    }
    if (sound === 'join') joinCustom.value = null
    if (sound === 'leave') leaveCustom.value = null
    if (sound === 'message') messageCustom.value = null
    setSource(sound, 'preset')
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

  function getSource(sound: NotificationSound): SoundSource {
    if (sound === 'join') return joinSource.value
    if (sound === 'leave') return leaveSource.value
    return messageSource.value
  }

  function setSource(sound: NotificationSound, value: SoundSource) {
    if (sound === 'join') joinSource.value = value
    if (sound === 'leave') leaveSource.value = value
    if (sound === 'message') messageSource.value = value
    localStorage.setItem(`${STORAGE_PREFIX}.source.${sound}`, value)
  }

  async function getCustomBuffer(sound: NotificationSound): Promise<AudioBuffer | null> {
    const cached = bufferCache.get(sound)
    if (cached) return cached
    const existing = decodingTasks.get(sound)
    if (existing) return existing
    const record = await idbGetCustomSound(sound)
    if (!record) return null
    const task = getAudioContext()
      .decodeAudioData(await record.blob.arrayBuffer())
      .then((buffer) => {
        bufferCache.set(sound, buffer)
        decodingTasks.delete(sound)
        return buffer
      })
      .catch(() => {
        decodingTasks.delete(sound)
        return null
      })
    decodingTasks.set(sound, task)
    return task
  }

  async function applyOutputDevice(target: AudioContext) {
    const routable = target as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> }
    if (!routable.setSinkId || appliedOutputDeviceId === outputDeviceId) return
    try {
      await routable.setSinkId(outputDeviceId)
      appliedOutputDeviceId = outputDeviceId
    } catch (error) {
      console.warn('提示音输出设备切换失败，将回退到系统默认设备', error)
      if (!outputDeviceId) return
      try {
        await routable.setSinkId('')
        appliedOutputDeviceId = ''
      } catch (fallbackError) {
        console.warn('提示音回退到系统默认设备失败', fallbackError)
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
    joinSource,
    leaveSource,
    messageSource,
    joinCustom,
    leaveCustom,
    messageCustom,
    installInteractionUnlock,
    removeInteractionUnlock,
    play,
    playMutedSpeakingReminder,
    preview,
    setEnabled,
    setVolume,
    setSoundEnabled,
    setSoundPreset,
    setSoundSource,
    setSuppressed,
    setOutputDevice,
    uploadCustomSound,
    removeCustomSound,
  }
})

function scheduleSound(context: AudioContext, volume: number, preset: SoundPresetId) {
  scheduleNotes(context, SOUND_PRESETS[preset].notes, volume)
}

function scheduleNotes(context: AudioContext, notes: NotePattern[], volume: number) {
  const start = context.currentTime + 0.005
  const master = context.createGain()
  master.gain.setValueAtTime(volume * 0.18, start)
  master.connect(context.destination)

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

function scheduleCustomSound(context: AudioContext, buffer: AudioBuffer, volume: number) {
  const start = context.currentTime + 0.005
  const source = context.createBufferSource()
  source.buffer = buffer
  const gain = context.createGain()
  gain.gain.setValueAtTime(Math.max(0.0001, volume), start)
  source.connect(gain)
  gain.connect(context.destination)
  source.start(start)
}

function isAllowedCustomMime(mime: string): boolean {
  return ALLOWED_CUSTOM_MIME_TYPES.includes(mime)
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

function getSavedSource(sound: NotificationSound): SoundSource {
  const saved = localStorage.getItem(`${STORAGE_PREFIX}.source.${sound}`)
  return saved === 'custom' ? 'custom' : 'preset'
}

async function openCustomSoundsDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'event' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function idbGetCustomSound(event: NotificationSound): Promise<CustomSoundRecord | null> {
  try {
    const db = await openCustomSoundsDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(event)
      request.onsuccess = () => resolve((request.result as CustomSoundRecord | undefined) ?? null)
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => db.close()
    })
  } catch {
    return null
  }
}

async function idbPutCustomSound(record: CustomSoundRecord): Promise<void> {
  const db = await openCustomSoundsDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

async function idbDeleteCustomSound(event: NotificationSound): Promise<void> {
  const db = await openCustomSoundsDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.delete(event)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}