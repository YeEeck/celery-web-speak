import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef, type Ref } from 'vue'
import { useVoiceDevices, type DeviceKind, type VoiceDevicesContext } from '../src/stores/voice-devices.ts'
import type { VoiceStatus } from '../src/stores/voice-mute-deafen.ts'

const PREFERRED_INPUT_DEVICE_KEY = 'cws.preferredInputDevice'
const PREFERRED_OUTPUT_DEVICE_KEY = 'cws.preferredOutputDevice'
const DEFAULT_DEVICE_ID = 'default'

const memoryStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => memoryStore.get(k) ?? null,
    setItem: (k: string, v: string) => void memoryStore.set(k, v),
    removeItem: (k: string) => void memoryStore.delete(k),
    clear: () => memoryStore.clear(),
    key: () => null,
    length: 0,
  },
  configurable: true,
  writable: true,
})

function device(id: string, label: string, kind: 'audioinput' | 'audiooutput'): MediaDeviceInfo {
  return { deviceId: id, label, kind, groupId: '' } as MediaDeviceInfo
}

interface FakeRoom {
  active: Record<'audioinput' | 'audiooutput', string>
  switchCalls: Array<{ kind: 'audioinput' | 'audiooutput', id: string }>
  switchResult: (kind: 'audioinput' | 'audiooutput', id: string) => boolean
  pending: Array<{ resolve: (value: boolean) => void }>
  getActiveDevice: (kind: 'audioinput' | 'audiooutput') => string
  switchActiveDevice: (kind: 'audioinput' | 'audiooutput', id: string) => Promise<boolean>
}

function makeRoom(): FakeRoom {
  const room: FakeRoom = {
    active: { audioinput: '', audiooutput: '' },
    switchCalls: [],
    switchResult: () => true,
    pending: [],
    getActiveDevice: (kind) => room.active[kind],
    switchActiveDevice: (kind, id) => {
      room.switchCalls.push({ kind, id })
      if (room.pending.length > 0) {
        const pending = room.pending.shift()!
        return new Promise((resolve) => pending.resolve(resolve))
      }
      const result = room.switchResult(kind, id)
      if (result) room.active[kind] = id
      return Promise.resolve(result)
    },
  }
  return room
}

interface Harness {
  ctx: VoiceDevicesContext
  module: ReturnType<typeof useVoiceDevices>
  calls: string[]
  roomRef: Ref<FakeRoom | null>
  voiceSessionRef: Ref<number>
  statusRef: Ref<VoiceStatus>
  joinedRef: Ref<boolean>
  inputDevicesRef: Ref<MediaDeviceInfo[]>
  outputDevicesRef: Ref<MediaDeviceInfo[]>
  permissionResult: { current: (() => boolean) | null }
  supportsOutput: { current: boolean }
  sinks: string[]
  permissionRequests: { count: number }
}

function makeHarness(initial: {
  supportsOutput?: boolean
  preseeInput?: { deviceId: string, label: string }
  preseeOutput?: { deviceId: string, label: string }
  status?: VoiceStatus
  joined?: boolean
} = {}): Harness {
  memoryStore.clear()
  if (initial.preseeInput) memoryStore.set(PREFERRED_INPUT_DEVICE_KEY, JSON.stringify(initial.preseeInput))
  if (initial.preseeOutput) memoryStore.set(PREFERRED_OUTPUT_DEVICE_KEY, JSON.stringify(initial.preseeOutput))

  const calls: string[] = []
  const sinks: string[] = []
  const permissionRequests = { count: 0 }
  const permissionResult: Harness['permissionResult'] = { current: null }
  const supportsOutput = { current: initial.supportsOutput ?? true }
  const roomRef = shallowRef<FakeRoom | null>(null)
  const voiceSessionRef = ref(0)
  const statusRef = ref<VoiceStatus>(initial.status ?? 'idle')
  const joinedRef = ref(initial.joined ?? false)
  const inputDevicesRef = ref<MediaDeviceInfo[]>([])
  const outputDevicesRef = ref<MediaDeviceInfo[]>([])
  const listeners: Array<() => void> = []

  const ctx: VoiceDevicesContext = {
    room: () => roomRef.value,
    voiceSession: () => voiceSessionRef.value,
    status: () => statusRef.value,
    joined: () => joinedRef.value,
    requestMicPermission: async () => {
      permissionRequests.count += 1
      if (permissionResult.current && !permissionResult.current()) throw new Error('麦克风权限被拒绝')
      return true
    },
    getLocalDevices: (kind) => Promise.resolve(
      kind === 'audioinput' ? inputDevicesRef.value : outputDevicesRef.value,
    ),
    listenDeviceChange: (callback) => {
      listeners.push(callback)
    },
    supportsOutputSelection: () => supportsOutput.current,
    applyOutputSink: (deviceId) => {
      sinks.push(deviceId)
    },
    syncSoundPlayback: () => {
      calls.push('syncSoundPlayback')
    },
    notifyPreferenceChange: () => {
      calls.push('notifyPreferenceChange')
    },
  }
  const module = useVoiceDevices(ctx)
  return {
    ctx,
    module,
    calls,
    roomRef,
    voiceSessionRef,
    statusRef,
    joinedRef,
    inputDevicesRef,
    outputDevicesRef,
    permissionResult,
    supportsOutput,
    sinks,
    permissionRequests,
  } as unknown as Harness
}

function storedPreference(key: string): { deviceId: string, label: string } | null {
  const raw = memoryStore.get(key)
  if (!raw) return null
  return JSON.parse(raw) as { deviceId: string, label: string }
}

test('switch success applies device, saves preference and returns true', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  h.joinedRef.value = true
  await h.module.refreshDevices(false)

  const result = await h.module.switchInput('mic-2')
  assert.equal(result, true)
  assert.deepEqual(room.switchCalls, [{ kind: 'audioinput', id: 'mic-2' }])
  assert.equal(h.module.activeInputId.value, 'mic-2')
  const stored = storedPreference(PREFERRED_INPUT_DEVICE_KEY)!
  assert.equal(stored.deviceId, 'mic-2')
  assert.equal(stored.label, '麦克风 2')
  assert.ok(h.calls.includes('notifyPreferenceChange'))
})

test('switch failure rolls back to the previous device and sets the error channel', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  h.joinedRef.value = true
  await h.module.refreshDevices(false)
  room.switchResult = (kind, id) => {
    if (id === 'mic-2') throw new Error('切换失败')
    return true
  }

  const result = await h.module.switchInput('mic-2')
  assert.equal(result, false)
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.equal(h.module.deviceChangeError.value, '切换失败')
  assert.equal(h.module.deviceChangeErrorKind.value, 'input')
  assert.equal(h.module.deviceChangingKind.value, null)
  assert.deepEqual(room.switchCalls, [
    { kind: 'audioinput', id: 'mic-2' },
    { kind: 'audioinput', id: 'mic-1' },
  ])
  // 回滚后偏好不变
  assert.equal(storedPreference(PREFERRED_INPUT_DEVICE_KEY), null)
})

test('switch rejected while another switch is in flight', async () => {
  const h = makeHarness()
  const room = makeRoom()
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  h.joinedRef.value = true
  await h.module.refreshDevices(false)

  const first = h.module.switchInput('mic-1')
  assert.equal(h.module.deviceChangingKind.value, 'input')
  const result = await h.module.switchInput('mic-2')
  assert.equal(result, false)
  await first
  assert.deepEqual(room.switchCalls.map((call) => call.id), ['mic-1'])
})

test('output switch without output selection support is a no-op', async () => {
  const h = makeHarness({ supportsOutput: false })
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput')]
  await h.module.refreshDevices(false)

  const result = await h.module.switchOutput('spk-1')
  assert.equal(result, false)
  assert.equal(storedPreference(PREFERRED_OUTPUT_DEVICE_KEY), null)
  assert.equal(h.roomRef.value, null)
})

test('switch without a room or while connecting only saves the preference', async () => {
  const h = makeHarness()
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  await h.module.refreshDevices(false)

  const result = await h.module.switchInput('mic-1')
  assert.equal(result, true)
  const stored = storedPreference(PREFERRED_INPUT_DEVICE_KEY)!
  assert.equal(stored.deviceId, 'mic-1')
  assert.equal(stored.label, '麦克风 1')
  assert.equal(h.module.activeInputId.value, '')

  const h2 = makeHarness({ status: 'connecting' })
  h2.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  await h2.module.refreshDevices(false)
  const result2 = await h2.module.switchInput('mic-1')
  assert.equal(result2, true)
  const stored2 = storedPreference(PREFERRED_INPUT_DEVICE_KEY)!
  assert.equal(stored2.deviceId, 'mic-1')
  assert.equal(stored2.label, '麦克风 1')
})

test('switch to an unavailable option is rejected', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'gone-mic', label: '已拔出的麦克风' } })
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  h.roomRef.value = makeRoom()
  await h.module.refreshDevices(false)

  const result = await h.module.switchInput('gone-mic')
  assert.equal(result, false)
})

test('session race mid-switch leaves no state written and no error set', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  h.joinedRef.value = true
  await h.module.refreshDevices(false)

  const pendingSwitch = h.module.switchInput('mic-2')
  h.voiceSessionRef.value += 1
  await pendingSwitch
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.equal(h.module.deviceChangeError.value, '')
  assert.equal(h.module.deviceChangingKind.value, null)
})

test('refresh with no room re-syncs sound playback without touching devices', async () => {
  const h = makeHarness()
  await h.module.refreshDevices(false)
  assert.ok(h.calls.includes('syncSoundPlayback'))
  assert.equal(h.module.inputDevices.value.length, 0)
})

test('refresh falls back to default when the active device disappeared', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = 'gone-mic'
  h.roomRef.value = room
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput')]
  room.active.audiooutput = 'spk-1'
  h.joinedRef.value = true

  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.deepEqual(room.switchCalls, [{ kind: 'audioinput', id: DEFAULT_DEVICE_ID }])
  assert.equal(h.module.activeOutputId.value, 'spk-1')
})

test('refresh keeps the active device when it is still available', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.roomRef.value = room
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput')]
  h.joinedRef.value = true

  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.deepEqual(room.switchCalls, [])
})

test('applyPreferredDevicesToRoom applies the preferred input and output', async () => {
  const h = makeHarness({
    preseeInput: { deviceId: 'mic-1', label: '麦克风 1' },
    preseeOutput: { deviceId: 'spk-1', label: '扬声器 1' },
  })
  const room = makeRoom()
  h.roomRef.value = room
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput')]
  await h.module.refreshDevices(false)

  await h.module.applyPreferredDevicesToRoom(room, h.voiceSessionRef.value)
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.equal(h.module.activeOutputId.value, 'spk-1')
  assert.deepEqual(room.switchCalls, [
    { kind: 'audioinput', id: 'mic-1' },
    { kind: 'audiooutput', id: 'spk-1' },
  ])
  assert.deepEqual(h.sinks, ['spk-1'])
})

test('applyPreferredDevicesToRoom falls back to default on failure', async () => {
  const h = makeHarness({
    preseeInput: { deviceId: 'mic-1', label: '麦克风 1' },
  })
  const room = makeRoom()
  h.roomRef.value = room
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  await h.module.refreshDevices(false)
  room.switchResult = (kind, id) => {
    if (id !== DEFAULT_DEVICE_ID) throw new Error('应用失败')
    return true
  }

  await h.module.applyPreferredDevicesToRoom(room, h.voiceSessionRef.value)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
})

test('permission grant transitions to granted and refreshes devices', async () => {
  const h = makeHarness()
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]

  const granted = await h.module.requestMicrophonePermission()
  assert.equal(granted, true)
  assert.equal(h.module.devicePermissionState.value, 'granted')
  assert.equal(h.permissionRequests.count, 1)
  assert.equal(h.module.inputDevices.value.length, 1)
})

test('permission denial keeps the error message and stays denied', async () => {
  const h = makeHarness()
  h.permissionResult.current = () => false

  const granted = await h.module.requestMicrophonePermission()
  assert.equal(granted, false)
  assert.equal(h.module.devicePermissionState.value, 'denied')
  assert.equal(h.module.devicePermissionError.value, '麦克风权限被拒绝')
})

test('initializeDevices installs the devicechange listener once and shares the permission promise', async () => {
  const h = makeHarness()
  await h.module.initializeDevices()
  await h.module.initializeDevices()
  assert.equal(h.permissionRequests.count, 1)
})

test('output switch applies the sink and re-syncs sound playback', async () => {
  const h = makeHarness({ preseeOutput: { deviceId: 'spk-1', label: '扬声器 1' } })
  const room = makeRoom()
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput')]
  h.roomRef.value = room
  h.joinedRef.value = true
  await h.module.refreshDevices(false)

  const result = await h.module.switchOutput('spk-1')
  assert.equal(result, true)
  assert.equal(h.module.activeOutputId.value, 'spk-1')
  assert.deepEqual(h.sinks, ['spk-1'])
  assert.ok(h.calls.includes('syncSoundPlayback'))
  assert.ok(h.calls.includes('notifyPreferenceChange'))
})

test('resolvedPreferredDeviceId falls back to default when the preference is unavailable', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'gone-mic', label: '已拔出' } })
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  await h.module.refreshDevices(false)
  assert.equal(h.module.resolvedPreferredDeviceId('input'), DEFAULT_DEVICE_ID)
  h.inputDevicesRef.value = [device('gone-mic', '已拔出', 'audioinput')]
  await h.module.refreshDevices(false)
  assert.equal(h.module.resolvedPreferredDeviceId('input'), 'gone-mic')
})
