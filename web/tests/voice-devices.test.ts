import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef, type Ref } from 'vue'
import { useVoiceDevices, type VoiceDevicesContext, type VoiceLiveConnection } from '../src/stores/voice-devices.ts'
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

function device(
  id: string,
  label: string,
  kind: 'audioinput' | 'audiooutput',
  groupId = '',
): MediaDeviceInfo {
  return { deviceId: id, label, kind, groupId } as MediaDeviceInfo
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
  extraConnections: Ref<VoiceLiveConnection[]>
  inputDevicesRef: Ref<MediaDeviceInfo[]>
  outputDevicesRef: Ref<MediaDeviceInfo[]>
  permissionResult: { current: (() => boolean) | null }
  supportsOutput: { current: boolean }
  sinks: string[]
  restarts: Array<{ room: FakeRoom, deviceId: string }>
  permissionRequests: { count: number }
}

function makeHarness(initial: {
  supportsOutput?: boolean
  preseeInput?: { deviceId: string, label: string }
  preseeOutput?: { deviceId: string, label: string }
  status?: VoiceStatus
} = {}): Harness {
  memoryStore.clear()
  if (initial.preseeInput) memoryStore.set(PREFERRED_INPUT_DEVICE_KEY, JSON.stringify(initial.preseeInput))
  if (initial.preseeOutput) memoryStore.set(PREFERRED_OUTPUT_DEVICE_KEY, JSON.stringify(initial.preseeOutput))

  const calls: string[] = []
  const sinks: string[] = []
  const restarts: Array<{ room: FakeRoom, deviceId: string }> = []
  const permissionRequests = { count: 0 }
  const permissionResult: Harness['permissionResult'] = { current: null }
  const supportsOutput = { current: initial.supportsOutput ?? true }
  const roomRef = shallowRef<FakeRoom | null>(null)
  const voiceSessionRef = ref(0)
  const statusRef = ref<VoiceStatus>(initial.status ?? 'idle')
  const extraConnections = ref<VoiceLiveConnection[]>([])
  const inputDevicesRef = ref<MediaDeviceInfo[]>([])
  const outputDevicesRef = ref<MediaDeviceInfo[]>([])
  const listeners: Array<() => void> = []

  const ctx: VoiceDevicesContext = {
    liveConnections: () => {
      const extras = extraConnections.value
      const room = roomRef.value
      if (!room) return extras
      return [
        {
          room: room as unknown as VoiceLiveConnection['room'],
          session: voiceSessionRef.value,
          ready: statusRef.value !== 'connecting',
        },
        ...extras,
      ]
    },
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
    restartRoomInput: async (room, deviceId) => {
      restarts.push({ room: room as unknown as FakeRoom, deviceId })
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
    extraConnections,
    inputDevicesRef,
    outputDevicesRef,
    permissionResult,
    supportsOutput,
    sinks,
    restarts,
    permissionRequests,
  } as unknown as Harness
}

function storedPreference(key: string): { deviceId: string, label: string } | null {
  const raw = memoryStore.get(key)
  if (!raw) return null
  return JSON.parse(raw) as { deviceId: string, label: string }
}

test('switch success applies device, saves preference and returns true', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  await h.module.refreshDevices(false)
  room.switchCalls = []

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
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  await h.module.refreshDevices(false)
  room.switchCalls = []
  room.switchResult = (_kind, id) => {
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
  assert.equal(storedPreference(PREFERRED_INPUT_DEVICE_KEY)?.deviceId, 'mic-1')
})

test('switch rejected while another switch is in flight', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const room = makeRoom()
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
  await h.module.refreshDevices(false)
  room.switchCalls = []

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

test('switch without live connections or while connecting only saves the preference', async () => {
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
  const connectingRoom = makeRoom()
  h2.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  h2.roomRef.value = connectingRoom
  await h2.module.refreshDevices(false)
  const result2 = await h2.module.switchInput('mic-1')
  assert.equal(result2, true)
  const stored2 = storedPreference(PREFERRED_INPUT_DEVICE_KEY)!
  assert.equal(stored2.deviceId, 'mic-1')
  assert.equal(stored2.label, '麦克风 1')
  assert.deepEqual(connectingRoom.switchCalls, [])
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
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = room
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
  const h = makeHarness({
    preseeInput: { deviceId: 'gone-mic', label: '已拔出的麦克风' },
    preseeOutput: { deviceId: 'spk-1', label: '扬声器 1' },
  })
  const room = makeRoom()
  room.active.audioinput = 'gone-mic'
  room.active.audiooutput = 'spk-1'
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
    device('spk-1', '扬声器 1', 'audiooutput'),
  ]
  // 建立会话占用为已消失的输入 + 仍可用的输出
  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.activeOutputId.value, 'spk-1')
  assert.ok(room.switchCalls.some((call) => call.kind === 'audioinput' && call.id === DEFAULT_DEVICE_ID))
  assert.equal(h.module.preferredInputId.value, 'gone-mic')
  assert.equal(h.module.deviceChangeError.value, '')
})

test('refresh keeps the preferred specific device when it is still available', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
    device('spk-1', '扬声器 1', 'audiooutput'),
  ]
  await h.module.refreshDevices(false)
  room.switchCalls = []
  h.restarts.length = 0
  const generation = h.module.inputRoutingGeneration.value

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.equal(h.module.preferredInputId.value, 'mic-1')
  assert.deepEqual(room.switchCalls, [])
  assert.deepEqual(h.restarts, [])
  assert.equal(h.module.inputRoutingGeneration.value, generation)
})

test('首选系统默认且默认身份变化时即使已在 default 上也强制重绑', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = DEFAULT_DEVICE_ID
  room.active.audiooutput = DEFAULT_DEVICE_ID
  room.switchResult = () => false
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
    device('spk-1', '扬声器 1', 'audiooutput'),
  ]
  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  room.switchCalls = []
  h.restarts.length = 0
  h.sinks.length = 0
  h.calls.length = 0
  const inputGen = h.module.inputRoutingGeneration.value
  const outputGen = h.module.outputRoutingGeneration.value

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-b'),
    device('spk-1', '扬声器 1', 'audiooutput'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.deepEqual(room.switchCalls, [
    { kind: 'audioinput', id: DEFAULT_DEVICE_ID },
    { kind: 'audiooutput', id: DEFAULT_DEVICE_ID },
  ])
  assert.deepEqual(h.restarts, [{ room, deviceId: DEFAULT_DEVICE_ID }])
  assert.ok(h.sinks.includes(DEFAULT_DEVICE_ID))
  assert.equal(h.module.preferredInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.preferredOutputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.activeOutputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.deviceChangeError.value, '')
  assert.equal(h.module.inputRoutingGeneration.value, inputGen + 1)
  assert.equal(h.module.outputRoutingGeneration.value, outputGen + 1)
})

test('applyPreferredDevicesToRoom applies while the connection is not yet ready', async () => {
  const h = makeHarness({
    status: 'connecting',
    preseeInput: { deviceId: 'mic-1', label: '麦克风 1' },
    preseeOutput: { deviceId: 'spk-1', label: '扬声器 1' },
  })
  const room = makeRoom()
  h.roomRef.value = room
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput')]
  await h.module.refreshDevices(false)

  await h.module.applyPreferredDevicesToRoom(room as never, h.voiceSessionRef.value)
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.equal(h.module.activeOutputId.value, 'spk-1')
  assert.deepEqual(room.switchCalls, [
    { kind: 'audioinput', id: 'mic-1' },
    { kind: 'audiooutput', id: 'spk-1' },
  ])
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
  room.switchCalls = []
  h.sinks.length = 0

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
  await h.module.refreshDevices(false)
  h.sinks.length = 0
  h.calls.length = 0

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

function extraConnection(room: FakeRoom, session: number): VoiceLiveConnection {
  return { room: room as unknown as VoiceLiveConnection['room'], session, ready: true }
}

test('switch applies the device to every ready live connection', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const channel = makeRoom()
  const call = makeRoom()
  channel.active.audioinput = 'mic-1'
  call.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = channel
  h.extraConnections.value = [extraConnection(call, 7)]
  await h.module.refreshDevices(false)
  channel.switchCalls = []
  call.switchCalls = []

  const result = await h.module.switchInput('mic-2')
  assert.equal(result, true)
  assert.deepEqual(channel.switchCalls, [{ kind: 'audioinput', id: 'mic-2' }])
  assert.deepEqual(call.switchCalls, [{ kind: 'audioinput', id: 'mic-2' }])
  assert.equal(h.module.activeInputId.value, 'mic-2')
  assert.equal(storedPreference(PREFERRED_INPUT_DEVICE_KEY)?.deviceId, 'mic-2')
})

test('switch rolls back every still-live connection when one ready room fails', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const channel = makeRoom()
  const call = makeRoom()
  channel.active.audioinput = 'mic-1'
  call.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = channel
  h.extraConnections.value = [extraConnection(call, 7)]
  await h.module.refreshDevices(false)
  channel.switchCalls = []
  call.switchCalls = []
  call.switchResult = (_kind, id) => {
    if (id === 'mic-2') throw new Error('通话切换失败')
    return true
  }

  const result = await h.module.switchInput('mic-2')
  assert.equal(result, false)
  assert.equal(h.module.activeInputId.value, 'mic-1')
  assert.equal(h.module.deviceChangeError.value, '通话切换失败')
  assert.equal(storedPreference(PREFERRED_INPUT_DEVICE_KEY)?.deviceId, 'mic-1')
  assert.deepEqual(channel.switchCalls, [
    { kind: 'audioinput', id: 'mic-2' },
    { kind: 'audioinput', id: 'mic-1' },
  ])
  assert.deepEqual(call.switchCalls, [
    { kind: 'audioinput', id: 'mic-2' },
    { kind: 'audioinput', id: 'mic-1' },
  ])
})

test('switch keeps the other room when one connection leaves mid-switch', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const channel = makeRoom()
  const call = makeRoom()
  channel.active.audioinput = 'mic-1'
  call.active.audioinput = 'mic-1'
  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput'), device('mic-2', '麦克风 2', 'audioinput')]
  h.roomRef.value = channel
  h.extraConnections.value = [extraConnection(call, 7)]
  await h.module.refreshDevices(false)
  channel.switchCalls = []
  call.switchCalls = []

  const pendingSwitch = h.module.switchInput('mic-2')
  h.extraConnections.value = []
  await pendingSwitch
  assert.equal(h.module.activeInputId.value, 'mic-2')
  assert.equal(h.module.deviceChangeError.value, '')
  assert.equal(storedPreference(PREFERRED_INPUT_DEVICE_KEY)?.deviceId, 'mic-2')
  assert.deepEqual(channel.switchCalls, [{ kind: 'audioinput', id: 'mic-2' }])
})

test('refresh falls back missing devices on every ready connection', async () => {
  const h = makeHarness({
    preseeInput: { deviceId: 'gone-mic', label: '已拔出的麦克风' },
    preseeOutput: { deviceId: 'spk-1', label: '扬声器 1' },
  })
  const channel = makeRoom()
  const call = makeRoom()
  channel.active.audioinput = 'gone-mic'
  call.active.audioinput = 'gone-mic'
  channel.active.audiooutput = 'spk-1'
  call.active.audiooutput = 'spk-1'
  h.roomRef.value = channel
  h.extraConnections.value = [extraConnection(call, 7)]
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
    device('spk-1', '扬声器 1', 'audiooutput'),
  ]

  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.deepEqual(channel.switchCalls.filter((call) => call.kind === 'audioinput'), [
    { kind: 'audioinput', id: DEFAULT_DEVICE_ID },
  ])
  assert.deepEqual(call.switchCalls.filter((call) => call.kind === 'audioinput'), [
    { kind: 'audioinput', id: DEFAULT_DEVICE_ID },
  ])
  assert.equal(h.module.activeOutputId.value, 'spk-1')
  assert.equal(h.module.preferredInputId.value, 'gone-mic')
  assert.equal(h.module.deviceChangeError.value, '')
})

test('output switch applies sink once while switching every ready connection', async () => {
  const h = makeHarness({ preseeOutput: { deviceId: 'spk-1', label: '扬声器 1' } })
  const channel = makeRoom()
  const call = makeRoom()
  h.outputDevicesRef.value = [device('spk-1', '扬声器 1', 'audiooutput'), device('spk-2', '扬声器 2', 'audiooutput')]
  h.roomRef.value = channel
  h.extraConnections.value = [extraConnection(call, 7)]
  await h.module.refreshDevices(false)
  channel.switchCalls = []
  call.switchCalls = []
  h.sinks.length = 0

  const result = await h.module.switchOutput('spk-2')
  assert.equal(result, true)
  assert.deepEqual(channel.switchCalls, [{ kind: 'audiooutput', id: 'spk-2' }])
  assert.deepEqual(call.switchCalls, [{ kind: 'audiooutput', id: 'spk-2' }])
  assert.deepEqual(h.sinks, ['spk-2'])
})

test('首选系统默认时只新增多余非默认设备不切流', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = DEFAULT_DEVICE_ID
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  room.switchCalls = []
  h.restarts.length = 0
  const generation = h.module.inputRoutingGeneration.value

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
    device('mic-usb', 'USB 声卡', 'audioinput'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.deepEqual(room.switchCalls, [])
  assert.deepEqual(h.restarts, [])
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.inputRoutingGeneration.value, generation)
  assert.equal(h.module.inputDevices.value.length, 3)
})

test('首选系统默认且默认身份比不出时偏切流', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = DEFAULT_DEVICE_ID
  room.switchResult = () => false
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  room.switchCalls = []
  h.restarts.length = 0

  h.inputDevicesRef.value = [device('mic-1', '麦克风 1', 'audioinput')]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.deepEqual(room.switchCalls, [{ kind: 'audioinput', id: DEFAULT_DEVICE_ID }])
  assert.deepEqual(h.restarts, [{ room, deviceId: DEFAULT_DEVICE_ID }])
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
})

test('有活动连接时消失的首选再出现不自动切回', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-preferred', label: '首选麦' } })
  const room = makeRoom()
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.preferredInputId.value, 'mic-preferred')
  room.switchCalls = []
  h.restarts.length = 0
  const generation = h.module.inputRoutingGeneration.value

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
    device('mic-preferred', '首选麦', 'audioinput'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.followInputDeviceId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.preferredInputId.value, 'mic-preferred')
  assert.deepEqual(room.switchCalls, [])
  assert.deepEqual(h.restarts, [])
  assert.equal(h.module.inputRoutingGeneration.value, generation)
})

test('无活动连接时首选重新出现则跟随输入回到首选', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-preferred', label: '首选麦' } })
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  await h.module.refreshDevices(false)
  assert.equal(h.module.followInputDeviceId.value, DEFAULT_DEVICE_ID)

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-preferred', '首选麦', 'audioinput'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')
  assert.equal(h.module.followInputDeviceId.value, 'mic-preferred')
  assert.equal(h.module.preferredInputId.value, 'mic-preferred')
})

test('会话已回退到系统默认后默认身份再变仍跟随新默认', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-preferred', label: '首选麦' } })
  const room = makeRoom()
  room.active.audioinput = DEFAULT_DEVICE_ID
  room.switchResult = () => false
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  room.switchCalls = []
  h.restarts.length = 0
  const generation = h.module.inputRoutingGeneration.value

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.deepEqual(room.switchCalls, [{ kind: 'audioinput', id: DEFAULT_DEVICE_ID }])
  assert.deepEqual(h.restarts, [{ room, deviceId: DEFAULT_DEVICE_ID }])
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.preferredInputId.value, 'mic-preferred')
  assert.equal(h.module.inputRoutingGeneration.value, generation + 1)
  assert.equal(h.module.deviceChangeError.value, '')
})

test('自动路径一边失败不回滚另一边且不写点选错误', async () => {
  const h = makeHarness()
  const channel = makeRoom()
  const call = makeRoom()
  channel.active.audioinput = DEFAULT_DEVICE_ID
  call.active.audioinput = DEFAULT_DEVICE_ID
  channel.switchResult = () => false
  call.switchResult = () => {
    throw new Error('通话重绑失败')
  }
  h.roomRef.value = channel
  h.extraConnections.value = [extraConnection(call, 7)]
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  channel.switchCalls = []
  call.switchCalls = []
  h.restarts.length = 0

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.deepEqual(channel.switchCalls, [{ kind: 'audioinput', id: DEFAULT_DEVICE_ID }])
  assert.deepEqual(h.restarts, [{ room: channel, deviceId: DEFAULT_DEVICE_ID }])
  assert.deepEqual(call.switchCalls, [{ kind: 'audioinput', id: DEFAULT_DEVICE_ID }])
  assert.equal(h.module.deviceChangeError.value, '')
  assert.equal(h.module.preferredInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.activeInputId.value, DEFAULT_DEVICE_ID)
})

test('自动重绑不改写已保存的首选', async () => {
  const h = makeHarness({
    preseeInput: { deviceId: 'mic-preferred', label: '首选麦' },
    preseeOutput: { deviceId: 'spk-preferred', label: '首选扬声器' },
  })
  const room = makeRoom()
  room.switchResult = () => false
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-b'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.equal(h.module.preferredInputId.value, 'mic-preferred')
  assert.equal(h.module.preferredOutputId.value, 'spk-preferred')
  assert.equal(storedPreference(PREFERRED_INPUT_DEVICE_KEY)?.deviceId, 'mic-preferred')
  assert.equal(storedPreference(PREFERRED_OUTPUT_DEVICE_KEY)?.deviceId, 'spk-preferred')
})

test('无房间时默认身份变化仍同步提示音并递增输入世代', async () => {
  const h = makeHarness()
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  h.calls.length = 0
  const inputGen = h.module.inputRoutingGeneration.value

  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-b'),
  ]
  await h.module.notifyDeviceWorldMayHaveChanged('devicechange')

  assert.equal(h.module.inputRoutingGeneration.value, inputGen + 1)
  assert.ok(h.calls.includes('syncSoundPlayback'))
  assert.equal(h.module.activeInputId.value, '')
})

test('点选进行中到来的自动信号等点选结束后再解析', async () => {
  const h = makeHarness({ preseeInput: { deviceId: 'mic-1', label: '麦克风 1' } })
  const room = makeRoom()
  room.active.audioinput = 'mic-1'
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
    device('mic-2', '麦克风 2', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  room.switchCalls = []
  h.restarts.length = 0

  room.pending.push({
    resolve: (resolve) => {
      h.inputDevicesRef.value = [
        device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-b'),
        device('mic-1', '麦克风 1', 'audioinput'),
        device('mic-2', '麦克风 2', 'audioinput'),
      ]
      void h.module.notifyDeviceWorldMayHaveChanged('devicechange')
      assert.deepEqual(room.switchCalls, [{ kind: 'audioinput', id: 'mic-2' }])
      assert.deepEqual(h.restarts, [])
      resolve(true)
    },
  })

  const switched = await h.module.switchInput('mic-2')
  assert.equal(switched, true)
  assert.equal(h.module.preferredInputId.value, 'mic-2')
  // 点选结束后才处理排队的默认身份变化；占用已是具体设备，不因默认改指切走
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(h.module.activeInputId.value, 'mic-2')
  assert.ok(!room.switchCalls.some((call) => call.id === DEFAULT_DEVICE_ID))
})

test('ended 即使身份未变也全局重绑', async () => {
  const h = makeHarness()
  const room = makeRoom()
  room.active.audioinput = DEFAULT_DEVICE_ID
  room.switchResult = () => false
  h.roomRef.value = room
  h.inputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Mic', 'audioinput', 'group-a'),
    device('mic-1', '麦克风 1', 'audioinput'),
  ]
  h.outputDevicesRef.value = [
    device(DEFAULT_DEVICE_ID, 'Default Spk', 'audiooutput', 'group-a'),
  ]
  await h.module.refreshDevices(false)
  room.switchCalls = []
  h.restarts.length = 0
  const generation = h.module.inputRoutingGeneration.value

  await h.module.notifyDeviceWorldMayHaveChanged('ended')

  assert.ok(room.switchCalls.some((call) => call.kind === 'audioinput' && call.id === DEFAULT_DEVICE_ID))
  assert.deepEqual(h.restarts, [{ room, deviceId: DEFAULT_DEVICE_ID }])
  assert.equal(h.module.inputRoutingGeneration.value, generation + 1)
  assert.equal(h.module.preferredInputId.value, DEFAULT_DEVICE_ID)
  assert.equal(h.module.deviceChangeError.value, '')
})
