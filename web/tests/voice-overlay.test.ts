import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import {
  DEFAULT_VOICE_OVERLAY_CONFIG,
  VOICE_OVERLAY_CONFIG_KEY,
  VOICE_OVERLAY_ENABLED_KEY,
  useVoiceOverlay,
} from '../src/stores/voice-overlay.ts'
import type { DesktopVoiceOverlayBridge, VoiceOverlayConfig, VoiceOverlayState } from '../src/audio/voiceOverlayBridge.ts'
import type { VoiceParticipant } from '../src/stores/voice-utils.ts'
import type { User } from '../src/types.ts'

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

type BridgeCall =
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'setConfig'; config: unknown }
  | { type: 'push'; state: unknown }

interface FakeBridge {
  helloCalls: number
  calls: BridgeCall[]
  protocol: number
  capabilities: string[]
  hasSetConfig: boolean
}

function fakeBridge(): FakeBridge {
  return {
    helloCalls: 0,
    calls: [],
    protocol: 3,
    capabilities: ['voice_overlay'],
    hasSetConfig: false,
  }
}

function installBridge(bridge: FakeBridge): void {
  const desktopVoiceOverlay: DesktopVoiceOverlayBridge = {
    hello: async () => {
      bridge.helloCalls += 1
      return { protocol: bridge.protocol, capabilities: bridge.capabilities }
    },
    setEnabled: async (enabled) => {
      bridge.calls.push({ type: 'setEnabled', enabled })
    },
    pushState: (state) => {
      bridge.calls.push({ type: 'push', state })
    },
    ...(bridge.hasSetConfig ? {
      setConfig: (config) => {
        bridge.calls.push({ type: 'setConfig', config })
      },
    } : {}),
  }
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { origin: 'https://voice.example.com' },
      desktopVoiceOverlay,
    },
    configurable: true,
    writable: true,
  })
}

function user(id: number, hasAvatar = false): User {
  return {
    id,
    username: `user-${id}`,
    displayName: `用户${id}`,
    role: 'member',
    voiceMuted: false,
    textMuted: false,
    permanentlyBanned: false,
    createdAt: '2026-01-01T00:00:00Z',
    avatarVersion: hasAvatar ? 3 : 0,
    hasAvatar,
  }
}

function participant(identity: string, name: string, overrides: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    identity,
    userId: Number(identity.replace(/\D/g, '')) || 1,
    name,
    isLocal: false,
    isSpeaking: false,
    microphoneEnabled: true,
    backgroundAudioAvailable: false,
    backgroundAudioPlaying: false,
    deafened: false,
    quality: 3,
    microphoneVolume: 1,
    backgroundAudioVolume: 1,
    microphoneMuted: false,
    backgroundAudioMuted: false,
    role: 'member',
    joinedAt: Date.now(),
    ...overrides,
  }
}

function createFixture(prefEnabled = false, protocol = 3, preseedConfig?: VoiceOverlayConfig) {
  memoryStore.clear()
  if (prefEnabled) memoryStore.set(VOICE_OVERLAY_ENABLED_KEY, 'true')
  if (preseedConfig) memoryStore.set(VOICE_OVERLAY_CONFIG_KEY, JSON.stringify(preseedConfig))
  const bridge = fakeBridge()
  bridge.protocol = protocol
  bridge.hasSetConfig = protocol >= 3
  installBridge(bridge)
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const channelName = ref('')
  const participants = ref<VoiceParticipant[]>([])
  const users = ref<User[]>([])
  const overlay = useVoiceOverlay({
    status: () => status.value,
    connectedChannelName: () => channelName.value,
    participants: () => participants.value,
    connectedUsers: () => users.value,
  })
  return { bridge, status, channelName, participants, users, overlay }
}

async function joinFixture() {
  const fixture = createFixture(true)
  await fixture.overlay.initializeVoiceOverlay()
  fixture.users.value = [user(1, true), user(2)]
  fixture.participants.value = [
    participant('1', '张三', { isLocal: true, isSpeaking: true }),
    participant('2', '李四', { microphoneEnabled: false }),
    participant('3', '王五', { deafened: true }),
  ]
  fixture.channelName.value = '大厅'
  fixture.status.value = 'connected'
  await nextTick()
  return fixture
}

test('voice overlay: 偏好默认关闭并持久化开关', async () => {
  const { overlay } = createFixture()
  assert.equal(overlay.enabled.value, false)
  overlay.setOverlayEnabled(true)
  assert.equal(overlay.enabled.value, true)
  assert.equal(memoryStore.get(VOICE_OVERLAY_ENABLED_KEY), 'true')
  overlay.setOverlayEnabled(false)
  assert.equal(memoryStore.get(VOICE_OVERLAY_ENABLED_KEY), 'false')
})

test('voice overlay: 无桥环境不暴露能力且不推送', async () => {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true })
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('connected')
  const channelName = ref('大厅')
  const participants = ref<VoiceParticipant[]>([participant('1', '张三')])
  const overlay = useVoiceOverlay({
    status: () => status.value,
    connectedChannelName: () => channelName.value,
    participants: () => participants.value,
    connectedUsers: () => [],
  })
  await overlay.initializeVoiceOverlay()
  assert.equal(overlay.supported.value, false)
})

test('voice overlay: 初始化握手并重发偏好与当前状态', async () => {
  const { bridge, overlay } = createFixture()
  await overlay.initializeVoiceOverlay()
  assert.equal(overlay.supported.value, true)
  assert.equal(bridge.helloCalls, 1)
  assert.deepEqual(bridge.calls, [
    { type: 'setEnabled', enabled: false },
    { type: 'setConfig', config: DEFAULT_VOICE_OVERLAY_CONFIG },
  ])
  await overlay.initializeVoiceOverlay()
  assert.equal(bridge.helloCalls, 1)
})

test('voice overlay: 开启偏好时初始化即启用浮层', async () => {
  const { bridge, overlay } = createFixture(true)
  await overlay.initializeVoiceOverlay()
  assert.deepEqual(bridge.calls, [
    { type: 'setEnabled', enabled: true },
    { type: 'setConfig', config: DEFAULT_VOICE_OVERLAY_CONFIG },
    { type: 'push', state: { channel: null, participants: [] } },
  ])
})

test('voice overlay: 加入语音即时推送频道与参与者映射', async () => {
  const { bridge } = await joinFixture()
  const push = bridge.calls.findLast((call) => call.type === 'push') as { state: VoiceOverlayState }
  assert.deepEqual(push.state, {
    channel: { name: '大厅' },
    participants: [
      { identity: '1', name: '张三', avatarUrl: 'https://voice.example.com/api/users/1/avatar?v=3', isLocal: true, speaking: true, microphoneMuted: false, deafened: false },
      { identity: '2', name: '李四', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: true, deafened: false },
      { identity: '3', name: '王五', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: false, deafened: true },
    ],
  })
})

test('voice overlay: 说话切换在 100ms 窗口内合并推送', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, participants } = await joinFixture()
  const before = bridge.calls.filter((call) => call.type === 'push').length

  participants.value[0]!.isSpeaking = false
  await nextTick()
  assert.equal(bridge.calls.filter((call) => call.type === 'push').length, before)

  participants.value[1]!.isSpeaking = true
  await nextTick()
  t.mock.timers.tick(100)
  assert.equal(bridge.calls.filter((call) => call.type === 'push').length, before + 1)
  const push = bridge.calls.findLast((call) => call.type === 'push') as { state: VoiceOverlayState }
  assert.equal(push.state.participants[0]!.speaking, false)
  assert.equal(push.state.participants[1]!.speaking, true)
  t.mock.timers.reset()
})

test('voice overlay: 说话切换窗口内再次变化只推最新一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, participants } = await joinFixture()
  const before = bridge.calls.filter((call) => call.type === 'push').length

  participants.value[0]!.isSpeaking = false
  await nextTick()
  t.mock.timers.tick(50)
  participants.value[0]!.isSpeaking = true
  await nextTick()
  t.mock.timers.tick(100)
  const after = bridge.calls.filter((call) => call.type === 'push').length
  assert.equal(after, before + 1)
  const push = bridge.calls.findLast((call) => call.type === 'push') as { state: VoiceOverlayState }
  assert.equal(push.state.participants[0]!.speaking, true)
  t.mock.timers.reset()
})

test('voice overlay: 成员进出即时推送', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, participants } = await joinFixture()
  const before = bridge.calls.filter((call) => call.type === 'push').length

  participants.value = [...participants.value, participant('4', '赵六')]
  await nextTick()
  assert.equal(bridge.calls.filter((call) => call.type === 'push').length, before + 1)
  t.mock.timers.reset()
})

test('voice overlay: 静音与聋变化即时推送', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, participants } = await joinFixture()
  const before = bridge.calls.filter((call) => call.type === 'push').length

  participants.value[1]!.microphoneEnabled = true
  await nextTick()
  assert.equal(bridge.calls.filter((call) => call.type === 'push').length, before + 1)

  participants.value[2]!.deafened = false
  await nextTick()
  assert.equal(bridge.calls.filter((call) => call.type === 'push').length, before + 2)
  t.mock.timers.reset()
})

test('voice overlay: 退出语音即时推送空态', async () => {
  const { bridge, status, channelName, participants } = await joinFixture()
  status.value = 'idle'
  channelName.value = ''
  participants.value = []
  await nextTick()
  const push = bridge.calls.findLast((call) => call.type === 'push') as { state: VoiceOverlayState }
  assert.deepEqual(push.state, { channel: null, participants: [] })
})

test('voice overlay: 关闭开关停止推送，重新开启恢复', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, overlay, participants } = await joinFixture()
  overlay.setOverlayEnabled(false)
  assert.deepEqual(bridge.calls.at(-1), { type: 'setEnabled', enabled: false })

  participants.value[0]!.isSpeaking = false
  await nextTick()
  t.mock.timers.tick(200)
  const pushesAfterDisable = bridge.calls.filter((call) => call.type === 'push').length

  overlay.setOverlayEnabled(true)
  assert.ok(bridge.calls.some((call) => call.type === 'setEnabled' && call.enabled === true))
  const last = bridge.calls.findLast((call) => call.type === 'push') as { state: VoiceOverlayState }
  assert.equal(last.state.participants[0]!.speaking, false)
  assert.ok(bridge.calls.filter((call) => call.type === 'push').length >= pushesAfterDisable + 1)
  t.mock.timers.reset()
})

test('voice overlay config: 协议 2 初始化即推送持久化配置', async () => {
  const fixture = createFixture(false, 3, { ...DEFAULT_VOICE_OVERLAY_CONFIG, scalePercent: 130 })
  await fixture.overlay.initializeVoiceOverlay()
  assert.equal(fixture.overlay.configSupported.value, true)
  const configCall = fixture.bridge.calls.find((call) => call.type === 'setConfig') as { config: VoiceOverlayConfig }
  assert.equal(configCall.config.scalePercent, 130)
})

test('voice overlay config: 默认值符合契约', async () => {
  assert.deepEqual(DEFAULT_VOICE_OVERLAY_CONFIG, {
    scalePercent: 100,
    positionXPercent: 9,
    positionYPercent: 50,
    speakingOpacityPercent: 80,
    silentOpacityPercent: 40,
  })
})

test('voice overlay config: 拖动变化在 50ms 窗口合并推送最后值', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, overlay } = createFixture(false, 3)
  await overlay.initializeVoiceOverlay()
  const before = bridge.calls.filter((call) => call.type === 'setConfig').length

  overlay.setOverlayConfig({ scalePercent: 110 })
  overlay.setOverlayConfig({ scalePercent: 120 })
  overlay.setOverlayConfig({ scalePercent: 130 })
  assert.equal(bridge.calls.filter((call) => call.type === 'setConfig').length, before)
  t.mock.timers.tick(50)
  assert.equal(bridge.calls.filter((call) => call.type === 'setConfig').length, before + 1)
  const last = bridge.calls.findLast((call) => call.type === 'setConfig') as { config: VoiceOverlayConfig }
  assert.equal(last.config.scalePercent, 130)
  t.mock.timers.reset()
})

test('voice overlay config: 推送的对象不是响应式代理（IPC 可结构化克隆）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, overlay } = createFixture(false, 3)
  await overlay.initializeVoiceOverlay()
  const configCall = bridge.calls.find((call) => call.type === 'setConfig') as { config: VoiceOverlayConfig }
  const plain = configCall.config as unknown as { __isVue?: boolean }
  assert.equal(plain.__isVue, undefined)
  assert.equal(Object.getPrototypeOf(configCall.config), Object.prototype)
  overlay.setOverlayConfig({ positionXPercent: 20 })
  t.mock.timers.tick(50)
  const pushed = bridge.calls.findLast((call) => call.type === 'setConfig') as { config: VoiceOverlayConfig }
  assert.equal(Object.getPrototypeOf(pushed.config), Object.prototype)
  t.mock.timers.reset()
})

test('voice overlay config: 设置持久化到 localStorage', async () => {
  const { overlay } = createFixture(false, 3)
  overlay.setOverlayConfig({ positionYPercent: 75, speakingOpacityPercent: 90 })
  const saved = JSON.parse(memoryStore.get(VOICE_OVERLAY_CONFIG_KEY) ?? '{}') as VoiceOverlayConfig
  assert.equal(saved.positionYPercent, 75)
  assert.equal(saved.speakingOpacityPercent, 90)
  assert.equal(saved.scalePercent, DEFAULT_VOICE_OVERLAY_CONFIG.scalePercent)
})

test('voice overlay config: 新会话恢复持久化配置', async () => {
  const first = createFixture(false, 3)
  first.overlay.setOverlayConfig({ scalePercent: 140 })
  const second = createFixture(false, 3, { ...DEFAULT_VOICE_OVERLAY_CONFIG, scalePercent: 140 })
  assert.equal(second.overlay.config.value.scalePercent, 140)
  await second.overlay.initializeVoiceOverlay()
  const configCall = second.bridge.calls.find((call) => call.type === 'setConfig') as { config: VoiceOverlayConfig }
  assert.equal(configCall.config.scalePercent, 140)
})

test('voice overlay config: 超出范围的值被收拢到边界', () => {
  const { overlay } = createFixture(false, 3)
  overlay.setOverlayConfig({
    scalePercent: 200,
    positionXPercent: -10,
    positionYPercent: 120,
    speakingOpacityPercent: 0,
    silentOpacityPercent: 200,
  })
  assert.deepEqual(overlay.config.value, {
    scalePercent: 150,
    positionXPercent: 0,
    positionYPercent: 100,
    speakingOpacityPercent: 10,
    silentOpacityPercent: 100,
  })
})

test('voice overlay config: 旧协议壳（<3）整体不可用，损坏存储用默认值且不推送配置', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  memoryStore.set(VOICE_OVERLAY_CONFIG_KEY, '{not json')
  const { bridge, overlay } = createFixture(false, 1)
  assert.deepEqual(overlay.config.value, DEFAULT_VOICE_OVERLAY_CONFIG)
  await overlay.initializeVoiceOverlay()
  assert.equal(overlay.supported.value, false)
  assert.equal(overlay.configSupported.value, false)
  overlay.setOverlayConfig({ scalePercent: 120 })
  t.mock.timers.tick(100)
  assert.equal(bridge.calls.some((call) => call.type === 'setConfig'), false)
  t.mock.timers.reset()
})
