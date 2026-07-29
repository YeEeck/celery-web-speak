import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createApplicationSounds,
  type ApplicationSoundAudioAdapter,
  type DecodedCustomSound,
} from '../src/application-sounds/core.ts'
import { MUTED_SPEAKING_NOTES, type OperationSoundEvent, type SoundPresetId } from '../src/application-sounds/patterns.ts'
import type {
  CustomSoundRecord,
  CustomSoundStorageAdapter,
  SoundPreferenceAdapter,
} from '../src/application-sounds/storage.ts'
import { BrowserApplicationSoundAudioAdapter } from '../src/application-sounds/web-audio.ts'

class MemoryPreferences implements SoundPreferenceAdapter {
  readonly values = new Map<string, string>()
  failWrites = false

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value)
  }

  get(key: string) {
    return this.values.get(key) ?? null
  }

  set(key: string, value: string) {
    if (this.failWrites) throw new Error('preference write failed')
    this.values.set(key, value)
  }

  remove(key: string) {
    if (this.failWrites) throw new Error('preference remove failed')
    this.values.delete(key)
  }
}

class MemoryCustomSounds implements CustomSoundStorageAdapter {
  readonly records = new Map<OperationSoundEvent, CustomSoundRecord>()
  getOverride: ((event: OperationSoundEvent) => Promise<CustomSoundRecord | null>) | null = null
  failPut = false

  async get(event: OperationSoundEvent) {
    if (this.getOverride) return this.getOverride(event)
    return this.records.get(event) ?? null
  }

  async put(record: CustomSoundRecord) {
    if (this.failPut) throw new Error('custom write failed')
    this.records.set(record.event, record)
  }

  async remove(event: OperationSoundEvent) {
    this.records.delete(event)
  }
}

class RecordingAudio implements ApplicationSoundAudioAdapter {
  readonly plays: string[] = []
  readonly outputs: string[] = []
  started = false
  disposed = false
  decodeDuration = 1
  failDecode = false
  failPlayback = false

  start() {
    this.started = true
  }

  async decode(blob: Blob): Promise<DecodedCustomSound> {
    if (this.failDecode) throw new Error('decode failed')
    return { duration: this.decodeDuration, value: blob }
  }

  async playPreset(preset: SoundPresetId) {
    if (this.failPlayback) throw new Error('playback failed')
    this.plays.push(`preset:${preset}`)
  }

  async playCustom() {
    if (this.failPlayback) throw new Error('playback failed')
    this.plays.push('custom')
  }

  async playMutedSpeakingReminder() {
    if (this.failPlayback) throw new Error('playback failed')
    this.plays.push('muted-speaking-reminder')
  }

  followOutput(deviceId: string) {
    this.outputs.push(deviceId)
  }

  async dispose() {
    this.disposed = true
  }
}

function createHarness(options: {
  preferences?: MemoryPreferences
  customSounds?: MemoryCustomSounds
  audio?: RecordingAudio
} = {}) {
  const preferences = options.preferences ?? new MemoryPreferences()
  const customSounds = options.customSounds ?? new MemoryCustomSounds()
  const audio = options.audio ?? new RecordingAudio()
  let now = 1_000
  let timestamp = 10_000
  const diagnostics: string[] = []
  const sounds = createApplicationSounds({
    preferences,
    customSounds,
    audio,
    monotonicNow: () => now,
    timestamp: () => timestamp,
    diagnose: (message) => diagnostics.push(message),
  })
  return {
    sounds,
    preferences,
    customSounds,
    audio,
    diagnostics,
    advance(milliseconds: number) {
      now += milliseconds
      timestamp += milliseconds
    },
  }
}

function slot(harness: ReturnType<typeof createHarness>, event: OperationSoundEvent) {
  return harness.sounds.settings.operationSounds.find((item) => item.event === event)!
}

function customRecord(event: OperationSoundEvent, name = `${event}.wav`): CustomSoundRecord {
  const blob = new Blob(['audio'], { type: 'audio/wav' })
  return {
    event,
    blob,
    name,
    size: blob.size,
    mime: blob.type,
    addedAt: 123,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

test('repairs a selected custom source when its record is absent', async () => {
  const preferences = new MemoryPreferences({
    'cws.notificationSounds.source.join': 'custom',
    'cws.notificationSounds.preset.join': 'gentle-triple',
  })
  const harness = createHarness({ preferences })

  await harness.sounds.whenReady()

  assert.equal(slot(harness, 'join').selectedChoice, 'preset:gentle-triple')
  assert.equal(slot(harness, 'join').custom.state, 'empty')
  assert.equal(preferences.get('cws.notificationSounds.source.join'), 'preset')
})

test('keeps an undecodable record recoverable but never selectable', async () => {
  const preferences = new MemoryPreferences({
    'cws.notificationSounds.source.join': 'custom',
  })
  const customSounds = new MemoryCustomSounds()
  customSounds.records.set('join', customRecord('join', 'broken.wav'))
  const audio = new RecordingAudio()
  audio.failDecode = true
  const harness = createHarness({ preferences, customSounds, audio })

  await harness.sounds.whenReady()

  const join = slot(harness, 'join')
  assert.equal(join.selectedChoice, 'preset:rise-duo')
  assert.equal(join.custom.state, 'unavailable')
  assert.equal(join.choices.some((choice) => choice.kind === 'custom'), false)
  assert.equal(customSounds.records.get('join')?.name, 'broken.wav')
  assert.equal(preferences.get('cws.notificationSounds.source.join'), 'preset')
})

test('serializes hydration before a newer upload for the same slot', async () => {
  const pendingJoin = deferred<CustomSoundRecord | null>()
  const customSounds = new MemoryCustomSounds()
  customSounds.getOverride = (event) => event === 'join'
    ? pendingJoin.promise
    : Promise.resolve(customSounds.records.get(event) ?? null)
  const harness = createHarness({ customSounds })
  const upload = slot(harness, 'join').upload(new File(['new'], 'new.wav', { type: 'audio/wav' }))

  pendingJoin.resolve(customRecord('join', 'old.wav'))
  assert.equal((await upload).ok, true)

  assert.equal(slot(harness, 'join').selectedChoice, 'custom')
  assert.equal(slot(harness, 'join').custom.state, 'playable')
  assert.equal(customSounds.records.get('join')?.name, 'new.wav')
})

test('keeps the committed source when a later upload fails', async () => {
  const harness = createHarness()
  await harness.sounds.whenReady()
  const join = slot(harness, 'join')
  assert.equal((await join.upload(new File(['first'], 'first.wav', { type: 'audio/wav' }))).ok, true)
  harness.customSounds.failPut = true

  const result = await join.upload(new File(['second'], 'second.wav', { type: 'audio/wav' }))

  assert.equal(result.ok, false)
  assert.equal(join.selectedChoice, 'custom')
  assert.equal(join.custom.state === 'playable' ? join.custom.name : '', 'first.wav')
  assert.equal(harness.customSounds.records.get('join')?.name, 'first.wav')
})

test('applies operation gates and independent accepted-event rate limits', async () => {
  const harness = createHarness()
  await harness.sounds.whenReady()

  harness.sounds.signal('voice-participant-joined')
  harness.sounds.signal('voice-participant-joined')
  harness.sounds.signal('text-message-received')
  await Promise.resolve()
  assert.deepEqual(harness.audio.plays, ['preset:rise-duo', 'preset:bright-single'])

  harness.advance(301)
  harness.sounds.signal('voice-participant-joined')
  harness.sounds.signal('voice-self-left')
  harness.sounds.signal('voice-self-left')
  await Promise.resolve()
  assert.deepEqual(harness.audio.plays.slice(-3), ['preset:rise-duo', 'preset:fall-duo', 'preset:fall-duo'])

  harness.sounds.followPlayback({ deafened: true, outputDeviceId: 'headphones' })
  harness.advance(301)
  harness.sounds.signal('text-message-received')
  await Promise.resolve()
  assert.equal(harness.audio.plays.at(-1), 'preset:fall-duo')
})

test('preview ignores the slot switch but obeys master playback policy', async () => {
  const harness = createHarness()
  await harness.sounds.whenReady()
  const join = slot(harness, 'join')
  await join.setEnabled(false)

  assert.equal((await join.preview()).ok, true)
  assert.equal(harness.audio.plays.at(-1), 'preset:rise-duo')

  await harness.sounds.settings.master.setEnabled(false)
  assert.equal((await join.preview()).ok, true)
  assert.equal(harness.audio.plays.length, 1)

  await harness.sounds.settings.master.setEnabled(true)
  harness.sounds.followPlayback({ deafened: true, outputDeviceId: '' })
  assert.equal((await join.preview()).ok, true)
  assert.equal(harness.audio.plays.length, 1)
})

test('projects muted-speaking audibility and keeps reminder outside operation limits', async () => {
  const harness = createHarness()
  await harness.sounds.whenReady()
  assert.equal(harness.sounds.mutedSpeakingReminderAudible.value, true)

  harness.sounds.signal('muted-speaking-reminder')
  harness.sounds.signal('muted-speaking-reminder')
  await Promise.resolve()
  assert.deepEqual(harness.audio.plays, ['muted-speaking-reminder', 'muted-speaking-reminder'])

  harness.sounds.followPlayback({ deafened: true, outputDeviceId: 'device-1' })
  assert.equal(harness.sounds.mutedSpeakingReminderAudible.value, false)
  assert.deepEqual(harness.audio.outputs, ['device-1'])

  await harness.sounds.dispose()
  assert.equal(harness.audio.disposed, true)
})

test('applies the latest output route revision before playback', async () => {
  const firstRoute = deferred<void>()
  const context = new FakeAudioContext((deviceId) => (
    deviceId === 'speaker-a' ? firstRoute.promise : Promise.resolve()
  ))
  const adapter = createBrowserAudioAdapter(context)

  adapter.followOutput('speaker-a')
  const decode = adapter.decode(new Blob(['audio']))
  await Promise.resolve()
  adapter.followOutput('speaker-b')
  firstRoute.resolve()
  await decode
  await adapter.playMutedSpeakingReminder(0.5)

  assert.deepEqual(context.sinkIds, ['speaker-a', 'speaker-b'])
})

test('falls back to the default output when routing fails', async () => {
  const diagnostics: string[] = []
  const context = new FakeAudioContext((deviceId) => (
    deviceId === 'missing-speaker'
      ? Promise.reject(new Error('missing output'))
      : Promise.resolve()
  ))
  const adapter = createBrowserAudioAdapter(context, diagnostics)

  adapter.followOutput('missing-speaker')
  await adapter.decode(new Blob(['audio']))
  await adapter.playMutedSpeakingReminder(0.5)

  assert.deepEqual(context.sinkIds, ['missing-speaker', ''])
  assert.deepEqual(diagnostics, ['提示音输出设备切换失败，将回退到系统默认设备'])
})

test('schedules the fixed muted-speaking reminder note pattern', async () => {
  const context = new FakeAudioContext()
  const adapter = createBrowserAudioAdapter(context)
  await adapter.decode(new Blob(['audio']))

  await adapter.playMutedSpeakingReminder(0.5)

  assert.equal(context.oscillators.length, MUTED_SPEAKING_NOTES.length)
  for (const [index, note] of MUTED_SPEAKING_NOTES.entries()) {
    const oscillator = context.oscillators[index]
    assert.deepEqual(oscillator.frequency.values, [
      { kind: 'set', value: note.from, time: context.currentTime + 0.005 + note.delay },
      { kind: 'ramp', value: note.to, time: context.currentTime + 0.005 + note.delay + note.duration },
    ])
    assert.equal(oscillator.startedAt, context.currentTime + 0.005 + note.delay)
    assert.equal(oscillator.stoppedAt, context.currentTime + 0.015 + note.delay + note.duration)
  }
})

function createBrowserAudioAdapter(context: FakeAudioContext, diagnostics: string[] = []) {
  return new BrowserApplicationSoundAudioAdapter({
    createContext: () => context as unknown as AudioContext,
    interactionTarget: new EventTarget(),
    diagnose: (message) => diagnostics.push(message),
  })
}

class FakeAudioContext {
  readonly currentTime = 4
  readonly destination = {}
  readonly oscillators: FakeOscillator[] = []
  readonly sinkIds: string[] = []
  state: AudioContextState = 'running'
  private readonly route: (deviceId: string) => Promise<void>

  constructor(route: (deviceId: string) => Promise<void> = () => Promise.resolve()) {
    this.route = route
  }

  async decodeAudioData() {
    return { duration: 1 }
  }

  async resume() {
    this.state = 'running'
  }

  async close() {
    this.state = 'closed'
  }

  async setSinkId(deviceId: string) {
    this.sinkIds.push(deviceId)
    await this.route(deviceId)
  }

  createGain() {
    return new FakeGain()
  }

  createOscillator() {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator
  }
}

class FakeGain {
  readonly gain = new FakeAudioParam()
  connect() {}
  disconnect() {}
}

class FakeOscillator {
  readonly frequency = new FakeAudioParam()
  type: OscillatorType = 'sine'
  startedAt = -1
  stoppedAt = -1

  connect() {}
  addEventListener() {}
  start(time: number) { this.startedAt = time }
  stop(time: number) { this.stoppedAt = time }
}

class FakeAudioParam {
  readonly values: Array<{ kind: 'set' | 'ramp'; value: number; time: number }> = []

  setValueAtTime(value: number, time: number) {
    this.values.push({ kind: 'set', value, time })
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.values.push({ kind: 'ramp', value, time })
  }
}
