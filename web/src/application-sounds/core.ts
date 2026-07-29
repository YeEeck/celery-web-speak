import { computed, reactive, type ComputedRef } from 'vue'
import {
  DEFAULT_PRESETS,
  SOUND_PRESETS,
  isSoundPresetId,
  type OperationSoundEvent,
  type SoundPresetId,
} from './patterns.ts'
import type {
  CustomSoundRecord,
  CustomSoundStorageAdapter,
  SoundPreferenceAdapter,
} from './storage'

export type ApplicationSoundOccurrence =
  | 'voice-self-joined'
  | 'voice-self-left'
  | 'voice-moderator-disconnected'
  | 'voice-participant-joined'
  | 'voice-participant-left'
  | 'text-message-received'
  | 'muted-speaking-reminder'

export interface ApplicationSoundPlaybackContext {
  deafened: boolean
  outputDeviceId: string
}

export interface DecodedCustomSound {
  duration: number
  value: unknown
}

export interface ApplicationSoundAudioAdapter {
  start(): void
  decode(blob: Blob): Promise<DecodedCustomSound>
  playPreset(preset: SoundPresetId, volume: number): Promise<void>
  playCustom(sound: DecodedCustomSound, volume: number): Promise<void>
  playMutedSpeakingReminder(volume: number): Promise<void>
  followOutput(deviceId: string): void
  dispose(): Promise<void> | void
}

export interface ApplicationSoundDependencies {
  preferences: SoundPreferenceAdapter
  customSounds: CustomSoundStorageAdapter
  audio: ApplicationSoundAudioAdapter
  monotonicNow: () => number
  timestamp: () => number
  diagnose: (message: string, error?: unknown) => void
}

export type SoundIssueCode =
  | 'invalid-choice'
  | 'invalid-volume'
  | 'file-too-large'
  | 'unsupported-format'
  | 'decode-failed'
  | 'duration-exceeded'
  | 'custom-unavailable'
  | 'persistence-failed'
  | 'playback-failed'

export interface SoundIssue {
  code: SoundIssueCode
  message: string
}

export type SoundChangeResult = { ok: true } | { ok: false; issue: SoundIssue }

export interface SoundChoice {
  key: string
  label: string
  kind: 'system-preset' | 'custom'
}

export interface CustomSoundSummary {
  name: string
  size: number
  mime: string
  addedAt: number
}

export type CustomSoundPresentation =
  | { state: 'empty' }
  | ({ state: 'playable' } & CustomSoundSummary)
  | ({ state: 'unavailable'; reason: 'unreadable' | 'invalid' | 'undecodable' } & Partial<CustomSoundSummary>)

export interface MasterSoundControl {
  enabled: boolean
  volume: number
  phase: 'ready' | 'changing'
  issue: SoundIssue | null
  setEnabled(value: boolean): Promise<SoundChangeResult>
  setVolume(value: number): Promise<SoundChangeResult>
}

export interface OperationSoundControl {
  event: OperationSoundEvent
  label: string
  enabled: boolean
  choices: readonly SoundChoice[]
  selectedChoice: string
  custom: CustomSoundPresentation
  phase: 'loading' | 'ready' | 'changing'
  issue: SoundIssue | null
  setEnabled(value: boolean): Promise<SoundChangeResult>
  select(choice: string): Promise<SoundChangeResult>
  upload(file: File): Promise<SoundChangeResult>
  removeCustom(): Promise<SoundChangeResult>
  preview(): Promise<SoundChangeResult>
}

export interface ApplicationSoundSettings {
  master: MasterSoundControl
  operationSounds: readonly OperationSoundControl[]
  customAccept: string
}

export interface ApplicationSounds {
  settings: ApplicationSoundSettings
  mutedSpeakingReminderAudible: ComputedRef<boolean>
  signal(occurrence: ApplicationSoundOccurrence): void
  followPlayback(context: ApplicationSoundPlaybackContext): void
}

export interface ApplicationSoundsRuntime extends ApplicationSounds {
  whenReady(): Promise<void>
  dispose(): Promise<void>
}

type SelectedSource =
  | { kind: 'preset'; preset: SoundPresetId }
  | { kind: 'custom'; sound: DecodedCustomSound }

interface InternalSlot {
  event: OperationSoundEvent
  control: OperationSoundControl
  enabled: boolean
  retainedPreset: SoundPresetId
  preferredSource: 'preset' | 'custom'
  selected: SelectedSource
  record: CustomSoundRecord | null
  decoded: DecodedCustomSound | null
  custom: CustomSoundPresentation
  queue: Promise<void>
  hydration: Promise<void>
  hydrating: boolean
  pending: number
  lastPlayedAt: number
  playbackPolicy: () => { enabled: boolean; volume: number; deafened: boolean }
}

const DEFAULT_VOLUME = 0.6
const MIN_INTERVAL_MS = 300
const STORAGE_PREFIX = 'cws.notificationSounds'
const CUSTOM_CHOICE_KEY = 'custom'
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
] as const

export const CUSTOM_SOUND_ACCEPT = ALLOWED_CUSTOM_MIME_TYPES.join(',')

const OPERATION_SOUNDS: readonly { event: OperationSoundEvent; label: string }[] = [
  { event: 'join', label: '加入语音' },
  { event: 'leave', label: '退出语音' },
  { event: 'message', label: '新文字消息' },
]

export function createApplicationSounds(dependencies: ApplicationSoundDependencies): ApplicationSoundsRuntime {
  const playback = reactive<ApplicationSoundPlaybackContext>({ deafened: false, outputDeviceId: '' })
  const master = createMasterControl(dependencies)
  const slots = new Map<OperationSoundEvent, InternalSlot>()

  dependencies.audio.start()
  for (const definition of OPERATION_SOUNDS) {
    const slot = createSlot(definition.event, definition.label, dependencies, () => ({
      enabled: master.enabled,
      volume: master.volume,
      deafened: playback.deafened,
    }))
    slots.set(definition.event, slot)
  }

  const settings = reactive<ApplicationSoundSettings>({
    master,
    operationSounds: OPERATION_SOUNDS.map(({ event }) => slots.get(event)!.control),
    customAccept: CUSTOM_SOUND_ACCEPT,
  })
  const mutedSpeakingReminderAudible = computed(() => (
    master.enabled && master.volume > 0 && !playback.deafened
  ))

  function signal(occurrence: ApplicationSoundOccurrence) {
    if (occurrence === 'muted-speaking-reminder') {
      if (!mutedSpeakingReminderAudible.value) return
      void dependencies.audio.playMutedSpeakingReminder(master.volume).catch((error) => {
        dependencies.diagnose('静音说话提示音播放失败', error)
      })
      return
    }

    const target = operationForOccurrence(occurrence)
    const slot = slots.get(target.event)!
    if (!master.enabled || master.volume === 0 || playback.deafened || !slot.enabled) return

    const now = dependencies.monotonicNow()
    if (!target.bypassRateLimit && now - slot.lastPlayedAt < MIN_INTERVAL_MS) return
    slot.lastPlayedAt = now

    void playSelected(slot, master.volume, dependencies.audio).catch((error) => {
      dependencies.diagnose(`${slot.control.label}提示音播放失败`, error)
    })
  }

  function followPlayback(context: ApplicationSoundPlaybackContext) {
    playback.deafened = context.deafened
    playback.outputDeviceId = context.outputDeviceId
    dependencies.audio.followOutput(context.outputDeviceId)
  }

  return {
    settings,
    mutedSpeakingReminderAudible,
    signal,
    followPlayback,
    whenReady: () => Promise.all([...slots.values()].map((slot) => slot.hydration)).then(() => undefined),
    async dispose() {
      await dependencies.audio.dispose()
    },
  }
}

function createMasterControl(dependencies: ApplicationSoundDependencies): MasterSoundControl {
  const master: MasterSoundControl = reactive<MasterSoundControl>({
    enabled: getSavedBoolean(dependencies.preferences, `${STORAGE_PREFIX}.enabled`),
    volume: getSavedVolume(dependencies.preferences),
    phase: 'ready',
    issue: null,
    async setEnabled(value): Promise<SoundChangeResult> {
      master.phase = 'changing'
      master.issue = null
      try {
        dependencies.preferences.set(`${STORAGE_PREFIX}.enabled`, String(value))
        master.enabled = value
        return success()
      } catch (error) {
        return fail(master, persistenceIssue('保存提示音总开关失败，请重试'), error, dependencies)
      } finally {
        master.phase = 'ready'
      }
    },
    async setVolume(value): Promise<SoundChangeResult> {
      master.phase = 'changing'
      master.issue = null
      if (!Number.isFinite(value)) {
        master.phase = 'ready'
        return fail(master, issue('invalid-volume', '提示音音量无效'), undefined, dependencies)
      }
      const normalized = Math.max(0, Math.min(1, value))
      try {
        dependencies.preferences.set(`${STORAGE_PREFIX}.volume`, String(normalized))
        master.volume = normalized
        return success()
      } catch (error) {
        return fail(master, persistenceIssue('保存提示音音量失败，请重试'), error, dependencies)
      } finally {
        master.phase = 'ready'
      }
    },
  })
  return master
}

function createSlot(
  event: OperationSoundEvent,
  label: string,
  dependencies: ApplicationSoundDependencies,
  playbackPolicy: InternalSlot['playbackPolicy'],
): InternalSlot {
  const retainedPreset = getSavedPreset(dependencies.preferences, event)
  const slot = {} as InternalSlot
  const control: OperationSoundControl = reactive<OperationSoundControl>({
    event,
    label,
    enabled: getSavedBoolean(dependencies.preferences, enabledKey(event)),
    choices: presetChoices(),
    selectedChoice: presetChoiceKey(retainedPreset),
    custom: { state: 'empty' },
    phase: 'loading',
    issue: null,
    setEnabled: (value): Promise<SoundChangeResult> => enqueueSlot(slot, dependencies, async (): Promise<SoundChangeResult> => {
      try {
        dependencies.preferences.set(enabledKey(event), String(value))
      } catch (error) {
        return fail(control, persistenceIssue(`保存${label}开关失败，请重试`), error, dependencies)
      }
      slot.enabled = value
      syncSlotControl(slot)
      return success()
    }),
    select: (choice) => enqueueSlot(slot, dependencies, () => selectSlotChoice(slot, choice, dependencies)),
    upload: (file) => enqueueSlot(slot, dependencies, () => uploadCustomSound(slot, file, dependencies)),
    removeCustom: () => enqueueSlot(slot, dependencies, () => removeCustomSound(slot, dependencies)),
    preview: () => previewSlot(slot, dependencies),
  })

  Object.assign(slot, {
    event,
    control,
    enabled: control.enabled,
    retainedPreset,
    preferredSource: getSavedSource(dependencies.preferences, event),
    selected: { kind: 'preset', preset: retainedPreset },
    record: null,
    decoded: null,
    custom: { state: 'empty' },
    queue: Promise.resolve(),
    hydration: Promise.resolve(),
    hydrating: true,
    pending: 0,
    lastPlayedAt: -Infinity,
    playbackPolicy,
  } satisfies Omit<InternalSlot, 'hydration'> & { hydration: Promise<void> })

  slot.hydration = hydrateSlot(slot, dependencies)
    .catch((error) => dependencies.diagnose(`${label}自定义音效加载失败`, error))
    .finally(() => {
      slot.hydrating = false
      control.phase = slot.pending > 0 ? 'changing' : 'ready'
    })
  slot.queue = slot.hydration
  return slot
}

async function hydrateSlot(slot: InternalSlot, dependencies: ApplicationSoundDependencies) {
  normalizeSavedPreset(slot, dependencies)
  normalizeSavedSource(slot, dependencies)
  try {
    const record = await dependencies.customSounds.get(slot.event)
    if (!record) {
      slot.record = null
      slot.decoded = null
      slot.custom = { state: 'empty' }
      await repairUnavailableCustomSelection(slot, dependencies)
      syncSlotControl(slot)
      return
    }

    slot.record = record
    const summary = customSummary(record)
    if (!isValidCustomRecord(record, slot.event)) {
      slot.decoded = null
      slot.custom = { state: 'unavailable', reason: 'invalid', ...summary }
      slot.control.issue = issue('custom-unavailable', '自定义音效不可用，请替换或删除')
      await repairUnavailableCustomSelection(slot, dependencies)
      syncSlotControl(slot)
      return
    }

    try {
      const decoded = await dependencies.audio.decode(record.blob)
      if (!isValidDecodedSound(decoded)) throw new Error('自定义音效时长无效')
      slot.decoded = decoded
      slot.custom = { state: 'playable', ...summary }
      slot.selected = slot.preferredSource === 'custom'
        ? { kind: 'custom', sound: decoded }
        : { kind: 'preset', preset: slot.retainedPreset }
    } catch (error) {
      slot.decoded = null
      slot.custom = { state: 'unavailable', reason: 'undecodable', ...summary }
      slot.control.issue = issue('custom-unavailable', '自定义音效无法解析，请替换或删除')
      await repairUnavailableCustomSelection(slot, dependencies)
      dependencies.diagnose(`${slot.control.label}自定义音效无法解析`, error)
    }
  } catch (error) {
    slot.record = null
    slot.decoded = null
    slot.custom = { state: 'unavailable', reason: 'unreadable' }
    slot.control.issue = issue('custom-unavailable', '自定义音效存储暂不可用')
    await repairUnavailableCustomSelection(slot, dependencies)
    dependencies.diagnose(`${slot.control.label}自定义音效存储读取失败`, error)
  }
  syncSlotControl(slot)
}

async function repairUnavailableCustomSelection(
  slot: InternalSlot,
  dependencies: ApplicationSoundDependencies,
) {
  slot.selected = { kind: 'preset', preset: slot.retainedPreset }
  if (slot.preferredSource !== 'custom') return
  slot.preferredSource = 'preset'
  try {
    dependencies.preferences.set(sourceKey(slot.event), 'preset')
  } catch (error) {
    dependencies.diagnose(`${slot.control.label}来源偏好修复失败`, error)
  }
}

function enqueueSlot(
  slot: InternalSlot,
  dependencies: ApplicationSoundDependencies,
  operation: () => Promise<SoundChangeResult>,
): Promise<SoundChangeResult> {
  slot.pending += 1
  const task = slot.queue.then(async () => {
    slot.control.phase = 'changing'
    slot.control.issue = null
    return operation()
  })
  slot.queue = task.then(() => undefined, (error) => {
    dependencies.diagnose(`${slot.control.label}设置操作失败`, error)
  })
  return task.finally(() => {
    slot.pending -= 1
    slot.control.phase = slot.hydrating ? 'loading' : slot.pending > 0 ? 'changing' : 'ready'
  })
}

async function selectSlotChoice(
  slot: InternalSlot,
  choice: string,
  dependencies: ApplicationSoundDependencies,
): Promise<SoundChangeResult> {
  if (choice === CUSTOM_CHOICE_KEY) {
    if (!slot.decoded || slot.custom.state !== 'playable') {
      return fail(slot.control, issue('custom-unavailable', '自定义音效不可用，请先上传或替换'), undefined, dependencies)
    }
    try {
      dependencies.preferences.set(sourceKey(slot.event), 'custom')
    } catch (error) {
      return fail(slot.control, persistenceIssue('保存自定义音效选择失败，请重试'), error, dependencies)
    }
    slot.preferredSource = 'custom'
    slot.selected = { kind: 'custom', sound: slot.decoded }
    syncSlotControl(slot)
    return success()
  }

  const preset = presetIdFromChoice(choice)
  if (!preset) {
    return fail(slot.control, issue('invalid-choice', '请选择有效的系统预置音效'), undefined, dependencies)
  }

  const presetKey = savedPresetKey(slot.event)
  const sourcePreferenceKey = sourceKey(slot.event)
  const previousPreset = dependencies.preferences.get(presetKey)
  const previousSource = dependencies.preferences.get(sourcePreferenceKey)
  try {
    dependencies.preferences.set(presetKey, preset)
    dependencies.preferences.set(sourcePreferenceKey, 'preset')
  } catch (error) {
    restorePreference(dependencies.preferences, presetKey, previousPreset, dependencies)
    restorePreference(dependencies.preferences, sourcePreferenceKey, previousSource, dependencies)
    return fail(slot.control, persistenceIssue('保存系统预置音效失败，请重试'), error, dependencies)
  }

  slot.retainedPreset = preset
  slot.preferredSource = 'preset'
  slot.selected = { kind: 'preset', preset }
  syncSlotControl(slot)
  return success()
}

async function uploadCustomSound(
  slot: InternalSlot,
  file: File,
  dependencies: ApplicationSoundDependencies,
): Promise<SoundChangeResult> {
  if (file.size > MAX_FILE_SIZE) {
    return fail(slot.control, issue('file-too-large', '音频大小不能超过 512 KB'), undefined, dependencies)
  }
  if (!ALLOWED_CUSTOM_MIME_TYPES.includes(file.type as (typeof ALLOWED_CUSTOM_MIME_TYPES)[number])) {
    return fail(slot.control, issue('unsupported-format', '请选择 MP3、WAV、OGG、M4A 或 WEBM 音频'), undefined, dependencies)
  }

  let decoded: DecodedCustomSound
  try {
    decoded = await dependencies.audio.decode(file)
  } catch (error) {
    return fail(slot.control, issue('decode-failed', '无法解析该音频，请尝试其他文件'), error, dependencies)
  }
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    return fail(slot.control, issue('decode-failed', '无法解析该音频，请尝试其他文件'), undefined, dependencies)
  }
  if (decoded.duration > MAX_DURATION_SECONDS) {
    return fail(slot.control, issue('duration-exceeded', '音频时长不能超过 3 秒'), undefined, dependencies)
  }

  const record: CustomSoundRecord = {
    event: slot.event,
    blob: file,
    name: file.name,
    size: file.size,
    mime: file.type,
    addedAt: dependencies.timestamp(),
  }
  const previousRecord = slot.record
  try {
    await dependencies.customSounds.put(record)
    dependencies.preferences.set(sourceKey(slot.event), 'custom')
  } catch (error) {
    await restoreCustomRecord(slot.event, previousRecord, dependencies)
    return fail(slot.control, persistenceIssue('保存自定义音效失败，请重试'), error, dependencies)
  }

  slot.record = record
  slot.decoded = decoded
  slot.custom = { state: 'playable', ...customSummary(record) }
  slot.preferredSource = 'custom'
  slot.selected = { kind: 'custom', sound: decoded }
  syncSlotControl(slot)
  return success()
}

async function removeCustomSound(
  slot: InternalSlot,
  dependencies: ApplicationSoundDependencies,
): Promise<SoundChangeResult> {
  const previousRecord = slot.record
  try {
    await dependencies.customSounds.remove(slot.event)
    dependencies.preferences.set(sourceKey(slot.event), 'preset')
  } catch (error) {
    await restoreCustomRecord(slot.event, previousRecord, dependencies)
    return fail(slot.control, persistenceIssue('删除自定义音效失败，请重试'), error, dependencies)
  }

  slot.record = null
  slot.decoded = null
  slot.custom = { state: 'empty' }
  slot.preferredSource = 'preset'
  slot.selected = { kind: 'preset', preset: slot.retainedPreset }
  syncSlotControl(slot)
  return success()
}

async function previewSlot(
  slot: InternalSlot,
  dependencies: ApplicationSoundDependencies,
): Promise<SoundChangeResult> {
  slot.control.issue = null
  const policy = slot.playbackPolicy()
  if (!policy.enabled || policy.volume === 0 || policy.deafened) return success()
  try {
    await playSelected(slot, policy.volume, dependencies.audio)
    return success()
  } catch (error) {
    return fail(slot.control, issue('playback-failed', '试听失败，请重试'), error, dependencies)
  }
}

async function playSelected(
  slot: InternalSlot,
  volume: number,
  audio: ApplicationSoundAudioAdapter,
) {
  if (slot.selected.kind === 'custom') {
    await audio.playCustom(slot.selected.sound, volume)
  } else {
    await audio.playPreset(slot.selected.preset, volume)
  }
}

function operationForOccurrence(occurrence: Exclude<ApplicationSoundOccurrence, 'muted-speaking-reminder'>) {
  if (occurrence === 'voice-self-joined' || occurrence === 'voice-participant-joined') {
    return { event: 'join' as const, bypassRateLimit: false }
  }
  if (occurrence === 'text-message-received') {
    return { event: 'message' as const, bypassRateLimit: false }
  }
  return {
    event: 'leave' as const,
    bypassRateLimit: occurrence === 'voice-self-left' || occurrence === 'voice-moderator-disconnected',
  }
}

function syncSlotControl(slot: InternalSlot) {
  slot.control.enabled = slot.enabled
  slot.control.choices = presetChoices(slot.custom.state === 'playable' ? slot.custom : null)
  slot.control.selectedChoice = slot.selected.kind === 'custom'
    ? CUSTOM_CHOICE_KEY
    : presetChoiceKey(slot.selected.preset)
  slot.control.custom = slot.custom
}

function presetChoices(custom: CustomSoundSummary | null = null): SoundChoice[] {
  const choices: SoundChoice[] = Object.entries(SOUND_PRESETS).map(([id, preset]) => ({
    key: presetChoiceKey(id as SoundPresetId),
    label: preset.name,
    kind: 'system-preset' as const,
  }))
  if (custom) choices.push({ key: CUSTOM_CHOICE_KEY, label: `自定义：${custom.name}`, kind: 'custom' })
  return choices
}

function presetChoiceKey(preset: SoundPresetId) {
  return `preset:${preset}`
}

function presetIdFromChoice(choice: string): SoundPresetId | null {
  if (!choice.startsWith('preset:')) return null
  const preset = choice.slice('preset:'.length)
  return isSoundPresetId(preset) ? preset : null
}

function customSummary(record: CustomSoundRecord): CustomSoundSummary {
  return {
    name: typeof record.name === 'string' ? record.name : '',
    size: typeof record.size === 'number' ? record.size : 0,
    mime: typeof record.mime === 'string' ? record.mime : '',
    addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
  }
}

function isValidCustomRecord(record: CustomSoundRecord, event: OperationSoundEvent) {
  return record.event === event
    && record.blob instanceof Blob
    && typeof record.name === 'string'
    && Number.isFinite(record.size)
    && record.size >= 0
    && record.size <= MAX_FILE_SIZE
    && ALLOWED_CUSTOM_MIME_TYPES.includes(record.mime as (typeof ALLOWED_CUSTOM_MIME_TYPES)[number])
}

function isValidDecodedSound(sound: DecodedCustomSound) {
  return Number.isFinite(sound.duration) && sound.duration > 0 && sound.duration <= MAX_DURATION_SECONDS
}

async function restoreCustomRecord(
  event: OperationSoundEvent,
  record: CustomSoundRecord | null,
  dependencies: ApplicationSoundDependencies,
) {
  try {
    if (record) await dependencies.customSounds.put(record)
    else await dependencies.customSounds.remove(event)
  } catch (error) {
    dependencies.diagnose('自定义音效写入补偿失败', error)
  }
}

function normalizeSavedPreset(slot: InternalSlot, dependencies: ApplicationSoundDependencies) {
  const key = savedPresetKey(slot.event)
  const saved = dependencies.preferences.get(key)
  if (isSoundPresetId(saved)) return
  try {
    dependencies.preferences.set(key, slot.retainedPreset)
  } catch (error) {
    dependencies.diagnose(`${slot.control.label}系统预置偏好修复失败`, error)
  }
}

function normalizeSavedSource(slot: InternalSlot, dependencies: ApplicationSoundDependencies) {
  const key = sourceKey(slot.event)
  const saved = dependencies.preferences.get(key)
  if (saved === 'preset' || saved === 'custom') return
  try {
    dependencies.preferences.set(key, 'preset')
  } catch (error) {
    dependencies.diagnose(`${slot.control.label}来源偏好修复失败`, error)
  }
}

function getSavedBoolean(preferences: SoundPreferenceAdapter, key: string) {
  return preferences.get(key) !== 'false'
}

function getSavedVolume(preferences: SoundPreferenceAdapter) {
  const value = preferences.get(`${STORAGE_PREFIX}.volume`)
  const saved = Number(value)
  if (value === null || !Number.isFinite(saved)) return DEFAULT_VOLUME
  return Math.max(0, Math.min(1, saved))
}

function getSavedPreset(preferences: SoundPreferenceAdapter, event: OperationSoundEvent) {
  const saved = preferences.get(savedPresetKey(event))
  return isSoundPresetId(saved) ? saved : DEFAULT_PRESETS[event]
}

function getSavedSource(preferences: SoundPreferenceAdapter, event: OperationSoundEvent) {
  return preferences.get(sourceKey(event)) === 'custom' ? 'custom' : 'preset'
}

function enabledKey(event: OperationSoundEvent) {
  return `${STORAGE_PREFIX}.${event}`
}

function savedPresetKey(event: OperationSoundEvent) {
  return `${STORAGE_PREFIX}.preset.${event}`
}

function sourceKey(event: OperationSoundEvent) {
  return `${STORAGE_PREFIX}.source.${event}`
}

function restorePreference(
  preferences: SoundPreferenceAdapter,
  key: string,
  value: string | null,
  dependencies: ApplicationSoundDependencies,
) {
  try {
    if (value === null) preferences.remove(key)
    else preferences.set(key, value)
  } catch (error) {
    dependencies.diagnose('提示音偏好写入补偿失败', error)
  }
}

function issue(code: SoundIssueCode, message: string): SoundIssue {
  return { code, message }
}

function persistenceIssue(message: string) {
  return issue('persistence-failed', message)
}

function success(): SoundChangeResult {
  return { ok: true }
}

function fail(
  target: { issue: SoundIssue | null },
  problem: SoundIssue,
  error: unknown,
  dependencies: ApplicationSoundDependencies,
): SoundChangeResult {
  target.issue = problem
  if (error !== undefined) dependencies.diagnose(problem.message, error)
  return { ok: false, issue: problem }
}
