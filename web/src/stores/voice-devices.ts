import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Room } from 'livekit-client'
import type { VoiceStatus } from './voice-mute-deafen.ts'
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

export interface VoiceDevicesContext {
  // Race-guard getters（race idiom 在 module 内部消费）
  room: () => Room | null
  voiceSession: () => number
  status: () => VoiceStatus
  joined: () => boolean

  // 浏览器 seam（ADR 0010/0011 模式：生产接浏览器 adapter，测试用假实现）
  requestMicPermission: () => Promise<boolean>
  getLocalDevices: (kind: MediaDeviceKind) => Promise<MediaDeviceInfo[]>
  listenDeviceChange: (callback: () => void) => void
  supportsOutputSelection: () => boolean
  applyOutputSink: (deviceId: string) => void

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

  // 领域入口
  switchInput: (deviceId: string) => Promise<boolean>
  switchOutput: (deviceId: string) => Promise<boolean>
  refreshDevices: (requestPermissions?: boolean) => Promise<void>
  initializeDevices: () => Promise<boolean>
  requestMicrophonePermission: () => Promise<boolean>
  resolvedPreferredDeviceId: (kind: DeviceKind) => string
  applyPreferredDevicesToRoom: (target: Room, session: number) => Promise<void>
  devicePreference: (kind: DeviceKind) => VoiceDevicePreference
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

  let deviceListenersInstalled = false
  let deviceInitializationPromise: Promise<boolean> | null = null
  let permissionRequestPromise: Promise<boolean> | null = null
  let deviceRefreshPromise: Promise<void> | null = null

  if (!outputDeviceSelectionSupported && savedOutputDevice.deviceId !== DEFAULT_DEVICE_ID) {
    saveDevicePreference(PREFERRED_OUTPUT_DEVICE_KEY, { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' })
  }

  const inputDeviceOptions = computed(() => buildVoiceDeviceOptions(
    inputDevices.value,
    'input',
    { deviceId: preferredInputId.value, label: preferredInputLabel.value },
    activeInputId.value,
    ctx.joined(),
  ))
  const outputDeviceOptions = computed(() => buildVoiceDeviceOptions(
    outputDeviceSelectionSupported ? outputDevices.value : [],
    'output',
    outputDeviceSelectionSupported
      ? { deviceId: preferredOutputId.value, label: preferredOutputLabel.value }
      : { deviceId: DEFAULT_DEVICE_ID, label: '系统默认' },
    activeOutputId.value,
    ctx.joined(),
  ))

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
    void refreshDevices(false)
  }

  async function initializeDevices() {
    if (!deviceListenersInstalled) {
      deviceListenersInstalled = true
      ctx.listenDeviceChange(handleDeviceChange)
    }
    if (!deviceInitializationPromise) deviceInitializationPromise = requestMicrophonePermission()
    return deviceInitializationPromise
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
    const target = ctx.room()
    if (!target || ctx.status() === 'connecting') {
      setPreferredDevice(kind, option)
      return true
    }
    const session = ctx.voiceSession()
    const mediaDeviceKind = kind === 'input' ? 'audioinput' : 'audiooutput'
    const previousDeviceId = kind === 'input'
      ? activeInputId.value || target.getActiveDevice(mediaDeviceKind) || DEFAULT_DEVICE_ID
      : activeOutputId.value || target.getActiveDevice(mediaDeviceKind) || DEFAULT_DEVICE_ID
    deviceChangingKind.value = kind
    deviceChangingId.value = deviceId
    try {
      const changed = await target.switchActiveDevice(mediaDeviceKind, deviceId, true)
      if (!changed) throw new Error('设备切换未生效')
      if (session !== ctx.voiceSession() || ctx.room() !== target) return false
      if (kind === 'input') activeInputId.value = deviceId
      else applyOutputDeviceSelection(deviceId)
      setPreferredDevice(kind, option)
      return true
    } catch (error) {
      if (session === ctx.voiceSession() && ctx.room() === target) {
        if (previousDeviceId !== deviceId) {
          await target.switchActiveDevice(mediaDeviceKind, previousDeviceId, true).catch(() => false)
        }
        if (session !== ctx.voiceSession() || ctx.room() !== target) return false
        if (kind === 'input') activeInputId.value = previousDeviceId
        else applyOutputDeviceSelection(previousDeviceId)
        deviceChangeError.value = error instanceof Error ? error.message : '设备切换失败'
        deviceChangeErrorKind.value = kind
      }
      return false
    } finally {
      if (deviceChangingKind.value === kind && deviceChangingId.value === deviceId) {
        deviceChangingKind.value = null
        deviceChangingId.value = ''
      }
    }
  }

  async function refreshDevices(requestPermissions = false) {
    if (requestPermissions) {
      await requestMicrophonePermission()
      return
    }
    if (deviceRefreshPromise) return deviceRefreshPromise
    deviceRefreshPromise = (async () => {
      const [inputResult, outputResult] = await Promise.allSettled([
        ctx.getLocalDevices('audioinput'),
        ctx.getLocalDevices('audiooutput'),
      ])
      inputDevices.value = inputResult.status === 'fulfilled' ? inputResult.value : []
      outputDevices.value = outputResult.status === 'fulfilled' ? outputResult.value : []
      const target = ctx.room()
      if (!target) {
        ctx.syncSoundPlayback()
        return
      }
      const nextInput = target.getActiveDevice('audioinput') ?? activeInputId.value
      const nextOutput = target.getActiveDevice('audiooutput') ?? activeOutputId.value
      activeInputId.value = nextInput || DEFAULT_DEVICE_ID
      activeOutputId.value = nextOutput || DEFAULT_DEVICE_ID
      await fallbackMissingActiveDevice(target, 'input')
      await fallbackMissingActiveDevice(target, 'output')
    })().finally(() => {
      deviceRefreshPromise = null
    })
    return deviceRefreshPromise
  }

  async function fallbackMissingActiveDevice(target: Room, kind: DeviceKind) {
    if (ctx.room() !== target) return
    if (kind === 'output' && !outputDeviceSelectionSupported) {
      activeOutputId.value = DEFAULT_DEVICE_ID
      return
    }
    const activeId = kind === 'input' ? activeInputId.value : activeOutputId.value
    if (!activeId || activeId === DEFAULT_DEVICE_ID) return
    const available = (kind === 'input' ? inputDevices.value : outputDevices.value).some((device) => device.deviceId === activeId)
    if (available) return
    try {
      await target.switchActiveDevice(kind === 'input' ? 'audioinput' : 'audiooutput', DEFAULT_DEVICE_ID, true)
      if (ctx.room() !== target) return
      if (kind === 'input') activeInputId.value = DEFAULT_DEVICE_ID
      else applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
    } catch {
      // The browser or LiveKit keeps its own fallback when an explicit switch is unavailable.
    }
  }

  async function applyPreferredDevicesToRoom(target: Room, session: number) {
    const inputId = resolvedPreferredDeviceId('input')
    try {
      const changed = await target.switchActiveDevice('audioinput', inputId, true)
      if (session === ctx.voiceSession() && ctx.room() === target && changed) activeInputId.value = inputId
    } catch {
      if (inputId !== DEFAULT_DEVICE_ID) {
        await target.switchActiveDevice('audioinput', DEFAULT_DEVICE_ID, true).catch(() => false)
      }
      if (session === ctx.voiceSession() && ctx.room() === target) activeInputId.value = DEFAULT_DEVICE_ID
    }
    if (session !== ctx.voiceSession() || ctx.room() !== target) return
    if (!outputDeviceSelectionSupported) {
      applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
      return
    }
    const outputId = resolvedPreferredDeviceId('output')
    try {
      const changed = await target.switchActiveDevice('audiooutput', outputId, true)
      if (session === ctx.voiceSession() && ctx.room() === target && changed) applyOutputDeviceSelection(outputId)
    } catch {
      if (outputId !== DEFAULT_DEVICE_ID) {
        await target.switchActiveDevice('audiooutput', DEFAULT_DEVICE_ID, true).catch(() => false)
      }
      if (session === ctx.voiceSession() && ctx.room() === target) applyOutputDeviceSelection(DEFAULT_DEVICE_ID)
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
    switchInput: (deviceId) => switchDevice('input', deviceId),
    switchOutput: (deviceId) => switchDevice('output', deviceId),
    refreshDevices,
    initializeDevices,
    requestMicrophonePermission,
    resolvedPreferredDeviceId,
    applyPreferredDevicesToRoom,
    devicePreference,
  }
}
