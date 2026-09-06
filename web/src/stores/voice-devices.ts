import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Room } from 'livekit-client'
import {
  DEFAULT_DEVICE_ID,
  PREFERRED_INPUT_DEVICE_KEY,
  PREFERRED_OUTPUT_DEVICE_KEY,
  buildVoiceDeviceOptions,
  getSavedDevicePreference,
  saveDevicePreference,
  type VoiceDeviceOption,
  type VoiceDevicePreference,
} from './voice-utils.ts'

export type DevicePermissionState = 'idle' | 'requesting' | 'granted' | 'denied'
export type DeviceKind = 'input' | 'output'
export type DeviceWorldChangeReason = 'devicechange' | 'ended' | 'freeze'

export interface VoiceLiveConnection {
  room: Room
  session: number
  ready: boolean
}

export interface VoiceDevicesContext {
  liveConnections: () => VoiceLiveConnection[]

  // 浏览器 seam（ADR 0010/0011 模式：生产接浏览器 adapter，测试用假实现）
  requestMicPermission: () => Promise<boolean>
  getLocalDevices: (kind: MediaDeviceKind) => Promise<MediaDeviceInfo[]>
  listenDeviceChange: (callback: () => void) => void
  supportsOutputSelection: () => boolean
  applyOutputSink: (deviceId: string) => void
  restartRoomInput: (room: Room, deviceId: string) => Promise<void>

  // 跨模块回调
  syncSoundPlayback: () => void
  notifyPreferenceChange: () => void
}

export interface VoiceDevicesModule {
  // reactive state — forwarded 到 voice store
  readonly inputDevices: Ref<MediaDeviceInfo[]>
  readonly outputDevices: Ref<MediaDeviceInfo[]>
  readonly activeInputId: Ref<string>
  readonly activeOutputId: Ref<string>
  readonly preferredInputId: Ref<string>
  readonly preferredInputLabel: Ref<string>
  readonly preferredOutputId: Ref<string>
  readonly preferredOutputLabel: Ref<string>
  readonly devicePermissionState: Ref<DevicePermissionState>
  readonly devicePermissionError: Ref<string>
  readonly deviceChangeError: Ref<string>
  readonly deviceChangeErrorKind: Ref<DeviceKind | null>
  readonly deviceChangingKind: Ref<DeviceKind | null>
  readonly deviceChangingId: Ref<string>
  readonly inputDeviceOptions: ComputedRef<VoiceDeviceOption[]>
  readonly outputDeviceOptions: ComputedRef<VoiceDeviceOption[]>
  readonly supportsOutputSelection: boolean
  readonly followInputDeviceId: ComputedRef<string>
  readonly followOutputDeviceId: ComputedRef<string>
  readonly inputRoutingGeneration: Ref<number>
  readonly outputRoutingGeneration: Ref<number>

  // 领域入口
  switchInput: (deviceId: string) => Promise<boolean>
  switchOutput: (deviceId: string) => Promise<boolean>
  refreshDevices: (requestPermissions?: boolean) => Promise<void>
  notifyDeviceWorldMayHaveChanged: (reason: DeviceWorldChangeReason) => Promise<void>
  initializeDevices: () => Promise<boolean>
  requestMicrophonePermission: () => Promise<boolean>
  resolvedPreferredDeviceId: (kind: DeviceKind) => string
  applyPreferredDevicesToRoom: (target: Room, session: number) => Promise<void>
  devicePreference: (kind: DeviceKind) => VoiceDevicePreference
}

type DefaultIdentitySnapshot = string | null

function readDefaultIdentity(devices: MediaDeviceInfo[]): DefaultIdentitySnapshot {
  const entry = devices.find((device) => device.deviceId === DEFAULT_DEVICE_ID)
  if (!entry) return null
  if (entry.groupId) return `g:${entry.groupId}`
  if (entry.label) return `l:${entry.label}`
  return null
}

function mergeQueuedReason(
  current: DeviceWorldChangeReason | null,
  next: DeviceWorldChangeReason,
): DeviceWorldChangeReason {
  if (current === 'ended' || next === 'ended') return 'ended'
  return next
}

export function useVoiceDevices(ctx: VoiceDevicesContext): VoiceDevicesModule {
  const outputDeviceSelectionSupported = ctx.supportsOutputSelection()
  const savedInputDevice = getSavedDevicePreference(PREFERRED_INPUT_DEVICE_KEY)
  const savedOutputDevice = getSavedDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY)
  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const activeInputId = ref('')
  const activeOutputId = ref('')
  const preferredInputId = ref(savedInputDevice.deviceId)
  const preferredInputLabel = ref(savedInputDevice.label)
  const preferredOutputId = ref(outputDeviceSelectionSupported ? savedOutputDevice.deviceId : DEFAULT_DEVICE_ID)
  const preferredOutputLabel = ref(outputDeviceSelectionSupported ? savedOutputDevice.label : '系统默认')
  const devicePermissionState = ref<DevicePermissionState>('idle')
  const devicePermissionError = ref('')
  const deviceChangeError = ref('')
  const deviceChangeErrorKind = ref<DeviceKind | null>(null)
  const deviceChangingKind = ref<DeviceKind | null>(null)
  const deviceChangingId = ref('')
  const inputRoutingGeneration = ref(0)
  const outputRoutingGeneration = ref(0)

  let deviceListenersInstalled = false
  let deviceInitializationPromise: Promise<boolean> | null = null
  let permissionRequestPromise: Promise<boolean> | null = null
  let deviceRefreshPromise: Promise<void> | null = null
  let queuedWorldChange: DeviceWorldChangeReason | null = null
  let inputDefaultIdentity: DefaultIdentitySnapshot | undefined
  let outputDefaultIdentity: DefaultIdentitySnapshot | undefined

  if (!outputDeviceSelectionSupported && savedOutputDevice.deviceId !== DEFAULT_DEVICE_ID) {
    saveDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY, { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' })
  }

  const inputDeviceOptions = computed(() => buildVoiceDeviceOptions(
    inputDevices.value,
    'input',
    { deviceId: preferredInputId.value, label: preferredInputLabel.value },
    activeInputId.value,
    ctx.liveConnections().length > 0,
  ))
  const outputDeviceOptions = computed(() => buildVoiceDeviceOptions(
    outputDeviceSelectionSupported ? outputDevices.value : [],
    'output',
    outputDeviceSelectionSupported
      ? { deviceId: preferredOutputId.value, label: preferredOutputLabel.value }
      : { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' },
    activeOutputId.value,
    ctx.liveConnections().length > 0,
  ))

  function isCurrent(target: Room, session: number) {
    return ctx.liveConnections().some((connection) => connection.room === target && connection.session === session)
  }

  function switchableConnections() {
    return ctx.liveConnections().filter((connection) => connection.ready)
  }

  function mediaKind(kind: DeviceKind): 'audioinput' | 'audiooutput' {
    return kind === 'input' ? 'audioinput' : 'audiooutput'
  }

  function devicePreference(kind: DeviceKind): VoiceDevicePreference {
    return kind === 'input'
      ? { deviceId: preferredInputId.value, label: preferredInputLabel.value }
      : { deviceId: preferredOutputId.value, label: preferredOutputLabel.value }
  }

  function deviceOptions(kind: DeviceKind) {
    return kind === 'input' ? inputDeviceOptions.value : outputDeviceOptions.value
  }

  function resolvedPreferredDeviceId(kind: DeviceKind) {
    const preference = devicePreference(kind)
    const available = deviceOptions(kind).some((option) => option.deviceId === preference.deviceId && !option.unavailable)
    return available ? preference.deviceId : DEFAULT_DEVICE_ID
  }

  const followInputDeviceId = computed(() => {
    if (ctx.liveConnections().length > 0) {
      return activeInputId.value || resolvedPreferredDeviceId('input')
    }
    return resolvedPreferredDeviceId('input')
  })

  const followOutputDeviceId = computed(() => {
    if (ctx.liveConnections().length > 0) {
      return activeOutputId.value || resolvedPreferredDeviceId('output')
    }
    return resolvedPreferredDeviceId('output')
  })

  function setPreferredDevice(kind: DeviceKind, preference: VoiceDevicePreference) {
    if (kind === 'input') {
      preferredInputId.value = preference.deviceId
      preferredInputLabel.value = preference.label
      saveDevicePreference(PREFERRED_INPUT_DEVICE_KEY, preference)
    } else {
      preferredOutputId.value = preference.deviceId
      preferredOutputLabel.value = preference.label
      saveDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY, preference)
      ctx.syncSoundPlayback()
    }
    ctx.notifyPreferenceChange()
  }

  function applyOutputDeviceSelection(deviceId: string) {
    activeOutputId.value = deviceId
    ctx.syncSoundPlayback()
    ctx.applyOutputSink(deviceId)
  }

  function requestMicrophonePermission() {
    if (permissionRequestPromise) return permissionRequestPromise
    permissionRequestPromise = performMicrophonePermissionRequest().finally(() => {
      permissionRequestPromise = null
    })
    return permissionRequestPromise
  }

  async function performMicrophonePermissionRequest() {
    devicePermissionState.value = 'requesting'
    devicePermissionError.value = ''
    try {
      const granted = await ctx.requestMicPermission()
      devicePermissionState.value = granted ? 'granted' : 'denied'
    } catch (error) {
      devicePermissionState.value = 'denied'
      devicePermissionError.value = error instanceof Error ? error.message : '麦克风权限请求失败'
    }
    await refreshDevices(false)
    return devicePermissionState.value === 'granted'
  }

  function handleDeviceChange() {
    void notifyDeviceWorldMayHaveChanged('devicechange')
  }

  async function initializeDevices() {
    if (!deviceListenersInstalled) {
      deviceListenersInstalled = true
      ctx.listenDeviceChange(handleDeviceChange)
    }
    if (!deviceInitializationPromise) deviceInitializationPromise = requestMicrophonePermission()
    return deviceInitializationPromise
  }

  function flushQueuedWorldChange() {
    if (queuedWorldChange === null || deviceChangingKind.value !== null) return
    const reason = queuedWorldChange
    queuedWorldChange = null
    void notifyDeviceWorldMayHaveChanged(reason)
  }

  async function switchDevice(kind: DeviceKind, deviceId: string) {
    if (deviceChangingKind.value !== null) return false
    const option = deviceOptions(kind).find((item) => item.deviceId === deviceId)
    if (!option || option.unavailable) return false
    if (kind === 'output' && !outputDeviceSelectionSupported) {
      setPreferredDevice('output', { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' })
      return true
    }
    deviceChangeError.value = ''
    deviceChangeErrorKind.value = null
    const switchable = switchableConnections()
    if (switchable.length === 0) {
      setPreferredDevice(kind, option)
      return true
    }
    const kindId = mediaKind(kind)
    const previousDeviceId = kind === 'input'
      ? activeInputId.value || switchable[0]!.room.getActiveDevice(kindId) || DEFAULT_DEVICE_ID
      : activeOutputId.value || switchable[0]!.room.getActiveDevice(kindId) || DEFAULT_DEVICE_ID
    deviceChangingKind.value = kind
    deviceChangingId.value = deviceId
    const applied: VoiceLiveConnection[] = []
    try {
      for (const connection of switchable) {
        if (!isCurrent(connection.room, connection.session)) continue
        try {
          const changed = await connection.room.switchActiveDevice(kindId, deviceId, true)
          if (!changed) throw new Error('设备切换未生效')
          if (isCurrent(connection.room, connection.session)) applied.push(connection)
        } catch (error) {
          if (!isCurrent(connection.room, connection.session)) continue
          if (previousDeviceId !== deviceId) {
            for (const target of [...applied, connection]) {
              if (!isCurrent(target.room, target.session)) continue
              await target.room.switchActiveDevice(kindId, previousDeviceId, true).catch(() => false)
            }
          }
          if (kind === 'input') activeInputId.value = previousDeviceId
          else applyOutputDeviceSelection(previousDeviceId)
          deviceChangeError.value = error instanceof Error ? error.message : '设备切换失败'
          deviceChangeErrorKind.value = kind
          return false
        }
      }
      if (!applied.some((connection) => isCurrent(connection.room, connection.session))) return false
      if (kind === 'input') activeInputId.value = deviceId
      else applyOutputDeviceSelection(deviceId)
      setPreferredDevice(kind, option)
      return true
    } finally {
      if (deviceChangingKind.value === kind && deviceChangingId.value === deviceId) {
        deviceChangingKind.value = null
        deviceChangingId.value = ''
      }
      flushQueuedWorldChange()
    }
  }

  function occupancyFor(kind: DeviceKind) {
    return kind === 'input' ? activeInputId.value : activeOutputId.value
  }

  function targetFor(kind: DeviceKind) {
    const resolved = resolvedPreferredDeviceId(kind)
    const occupancy = occupancyFor(kind)
    const preference = devicePreference(kind)
    // 会话已回退到系统默认时，首选具体设备在本次连接内重新出现也不自动切回
    if (
      ctx.liveConnections().length > 0
      && occupancy === DEFAULT_DEVICE_ID
      && preference.deviceId !== DEFAULT_DEVICE_ID
      && resolved === preference.deviceId
    ) {
      return DEFAULT_DEVICE_ID
    }
    return resolved
  }

  function defaultIdentityRequiresRebind(
    target: string,
    identity: DefaultIdentitySnapshot,
    snapshot: DefaultIdentitySnapshot | undefined,
  ) {
    if (target !== DEFAULT_DEVICE_ID) return false
    if (identity === null) return true
    return snapshot !== undefined && snapshot !== identity
  }

  function shouldRebindKind(
    kind: DeviceKind,
    reason: DeviceWorldChangeReason,
    identity: DefaultIdentitySnapshot,
    snapshot: DefaultIdentitySnapshot | undefined,
  ) {
    const target = targetFor(kind)
    const occupancy = occupancyFor(kind)
    if (reason === 'ended') return true
    if (switchableConnections().length > 0 && occupancy !== target) return true
    return defaultIdentityRequiresRebind(target, identity, snapshot)
  }

  function storeIdentitySnapshot(kind: DeviceKind, identity: DefaultIdentitySnapshot) {
    if (identity === null) return
    if (kind === 'input') inputDefaultIdentity = identity
    else outputDefaultIdentity = identity
  }

  async function rebindKindOnConnections(kind: DeviceKind, targetId: string) {
    const kindId = mediaKind(kind)
    for (const connection of switchableConnections()) {
      if (!isCurrent(connection.room, connection.session)) continue
      try {
        const changed = await connection.room.switchActiveDevice(kindId, targetId, true)
        if (!changed) {
          if (kind === 'input') await ctx.restartRoomInput(connection.room, targetId)
          else ctx.applyOutputSink(targetId)
        } else if (kind === 'output') {
          ctx.applyOutputSink(targetId)
        }
      } catch {
        // 自动路径按房间尽力，失败吞掉
      }
    }
  }

  async function applyAutoRebind(kind: DeviceKind, targetId: string) {
    const ready = switchableConnections()
    await rebindKindOnConnections(kind, targetId)
    if (kind === 'input') {
      if (ready.length > 0) activeInputId.value = targetId
      inputRoutingGeneration.value += 1
    } else {
      if (ready.length > 0) activeOutputId.value = targetId
      outputRoutingGeneration.value += 1
      ctx.syncSoundPlayback()
      if (ready.length === 0) ctx.applyOutputSink(targetId)
    }
  }

  async function parseThenRebind(reason: DeviceWorldChangeReason) {
    const [inputResult, outputResult] = await Promise.allSettled([
      ctx.getLocalDevices('audioinput'),
      ctx.getLocalDevices('audiooutput'),
    ])
    inputDevices.value = inputResult.status === 'fulfilled' ? inputResult.value : []
    outputDevices.value = outputResult.status === 'fulfilled' ? outputResult.value : []

    const inputIdentity = readDefaultIdentity(inputDevices.value)
    const outputIdentity = readDefaultIdentity(outputDevices.value)
    let reboundOutput = false

    const rebindInput = shouldRebindKind('input', reason, inputIdentity, inputDefaultIdentity)
    if (rebindInput) {
      await applyAutoRebind('input', targetFor('input'))
      storeIdentitySnapshot('input', inputIdentity)
    } else {
      storeIdentitySnapshot('input', inputIdentity)
    }

    if (outputDeviceSelectionSupported) {
      const rebindOutput = shouldRebindKind('output', reason, outputIdentity, outputDefaultIdentity)
      if (rebindOutput) {
        await applyAutoRebind('output', targetFor('output'))
        storeIdentitySnapshot('output', outputIdentity)
        reboundOutput = true
      } else {
        storeIdentitySnapshot('output', outputIdentity)
      }
    } else if (ctx.liveConnections().length > 0) {
      activeOutputId.value = DEFAULT_DEVICE_ID
    }

    if (!reboundOutput) ctx.syncSoundPlayback()
  }

  async function notifyDeviceWorldMayHaveChanged(reason: DeviceWorldChangeReason) {
    if (deviceChangingKind.value !== null) {
      queuedWorldChange = mergeQueuedReason(queuedWorldChange, reason)
      return
    }
    if (deviceRefreshPromise) {
      queuedWorldChange = mergeQueuedReason(queuedWorldChange, reason)
      await deviceRefreshPromise
      return
    }
    deviceRefreshPromise = parseThenRebind(reason).finally(() => {
      deviceRefreshPromise = null
      if (queuedWorldChange !== null && deviceChangingKind.value === null) {
        const next = queuedWorldChange
        queuedWorldChange = null
        void notifyDeviceWorldMayHaveChanged(next)
      }
    })
    return deviceRefreshPromise
  }

  async function refreshDevices(requestPermissions = false) {
    if (requestPermissions) {
      await requestMicrophonePermission()
      return
    }
    return notifyDeviceWorldMayHaveChanged('devicechange')
  }

  async function applyPreferredDevicesToRoom(target: Room, session: number) {
    const inputId = resolvedPreferredDeviceId('input')
    try {
      const changed = await target.switchActiveDevice('audioinput', inputId, true)
      if (isCurrent(target, session) && changed) activeInputId.value = inputId
    } catch {
      if (inputId !== DEFAULT_DEVICE_ID) {
        await target.switchActiveDevice('audioinput', DEFAULT_DEVICE_ID, true).catch(() => false)
      }
      if (isCurrent(target, session)) activeInputId.value = DEFAULT_DEVICE_ID
    }
    if (!isCurrent(target, session)) return
    if (!outputDeviceSelectionSupported) {
      applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
      return
    }
    const outputId = resolvedPreferredDeviceId('output')
    try {
      const changed = await target.switchActiveDevice('audiooutput', outputId, true)
      if (isCurrent(target, session) && changed) applyOutputDeviceSelection(outputId)
    } catch {
      if (outputId !== DEFAULT_DEVICE_ID) {
        await target.switchActiveDevice('audiooutput', DEFAULT_DEVICE_ID, true).catch(() => false)
      }
      if (isCurrent(target, session)) applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
    }
  }

  return {
    inputDevices,
    outputDevices,
    activeInputId,
    activeOutputId,
    preferredInputId,
    preferredInputLabel,
    preferredOutputId,
    preferredOutputLabel,
    devicePermissionState,
    devicePermissionError,
    deviceChangeError,
    deviceChangeErrorKind,
    deviceChangingKind,
    deviceChangingId,
    inputDeviceOptions,
    outputDeviceOptions,
    supportsOutputSelection: outputDeviceSelectionSupported,
    followInputDeviceId,
    followOutputDeviceId,
    inputRoutingGeneration,
    outputRoutingGeneration,
    switchInput: (deviceId) => switchDevice('input', deviceId),
    switchOutput: (deviceId) => switchDevice('output', deviceId),
    refreshDevices,
    notifyDeviceWorldMayHaveChanged,
    initializeDevices,
    requestMicrophonePermission,
    resolvedPreferredDeviceId,
    applyPreferredDevicesToRoom,
    devicePreference,
  }
}
