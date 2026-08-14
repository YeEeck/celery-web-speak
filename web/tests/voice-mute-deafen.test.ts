import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, type Ref } from 'vue'
import { useVoiceMuteDeafenModule, type MuteDeafenContext, type VoiceStatus } from '../src/stores/voice-mute-deafen.ts'

interface Harness {
  ctx: MuteDeafenContext
  calls: string[]
  syncs: Array<{ guildId: number, channelId: number, deafened: boolean }>
  // controllable reactive sources
  roomRef: Ref<{ kind: 'room' } | null>
  voiceSessionRef: Ref<number>
  statusRef: Ref<VoiceStatus>
  connectedChannelIdRef: Ref<number | null>
  connectedGuildIdRef: Ref<number | null>
  guildMuteValueRef: Ref<boolean | undefined>
  socketStatusRef: Ref<string>
  transmissionModeRef: Ref<'voice-activity' | 'continuous'>
  microphoneCurrentlyEnabledRef: Ref<boolean>
  applicationAudioPlayingRef: Ref<boolean>
  applicationAudioAutoPausedRef: Ref<boolean>
  // throw switches
  syncDeafenedErrorRef: Ref<Error | null>
  applyMicrophoneStateErrorRef: Ref<Error | null>
  startAudioErrorRef: Ref<Error | null>
  // hooks
  onApplyMicrophoneStateHook: { current: (() => void) | null }
}

const MICROPHONE_ENABLED_KEY = 'cws.microphoneEnabled'
const DEAFENED_PREFERENCE_KEY = 'cws.deafened'

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

function makeHarness(initial: {
  status?: VoiceStatus
  room?: { kind: 'room' } | null
  voiceSession?: number
  connectedChannelId?: number | null
  connectedGuildId?: number | null
  microphoneCurrentlyEnabled?: boolean
  applicationAudioPlaying?: boolean
  applicationAudioAutoPaused?: boolean
  transmissionMode?: 'voice-activity' | 'continuous'
  applyMicrophoneStateError?: Error | null
  preseeMicrophoneEnabled?: boolean
  preseeDeafened?: boolean
} = {}): Harness {
  memoryStore.clear()
  if (initial.preseeMicrophoneEnabled !== undefined) {
    memoryStore.set(MICROPHONE_ENABLED_KEY, String(initial.preseeMicrophoneEnabled))
  }
  if (initial.preseeDeafened !== undefined) {
    memoryStore.set(DEAFENED_PREFERENCE_KEY, String(initial.preseeDeafened))
  }

  const calls: string[] = []
  const syncs: Array<{ guildId: number, channelId: number, deafened: boolean }> = []
  const roomRef = ref<{ kind: 'room' } | null>(initial.room ?? null)
  const voiceSessionRef = ref(initial.voiceSession ?? 0)
  const statusRef = ref<VoiceStatus>(initial.status ?? 'idle')
  const connectedChannelIdRef = ref<number | null>(initial.connectedChannelId ?? null)
  const connectedGuildIdRef = ref<number | null>(initial.connectedGuildId ?? null)
  const guildMuteValueRef = ref<boolean | undefined>(undefined)
  const socketStatusRef = ref<string>('offline')
  const transmissionModeRef = ref<'voice-activity' | 'continuous'>(initial.transmissionMode ?? 'voice-activity')
  const microphoneCurrentlyEnabledRef = ref(initial.microphoneCurrentlyEnabled ?? false)
  const applicationAudioPlayingRef = ref(initial.applicationAudioPlaying ?? false)
  const applicationAudioAutoPausedRef = ref(initial.applicationAudioAutoPaused ?? false)
  const syncDeafenedErrorRef = ref<Error | null>(null)
  const applyMicrophoneStateErrorRef = ref<Error | null>(initial.applyMicrophoneStateError ?? null)
  const startAudioErrorRef = ref<Error | null>(null)

  const onApplyMicrophoneStateHook = { current: null as (() => void) | null }

  const ctx: MuteDeafenContext = {
    room: () => roomRef.value,
    voiceSession: () => voiceSessionRef.value,
    status: () => statusRef.value,
    connectedChannelId: () => connectedChannelIdRef.value,
    connectedGuildId: () => connectedGuildIdRef.value,
    guildMuteValue: () => guildMuteValueRef.value,
    socketStatus: () => socketStatusRef.value,
    transmissionMode: () => transmissionModeRef.value,
    saveMicrophonePreference: (enabled) => calls.push(`saveMicrophonePreference:${enabled}`),
    saveDeafenedPreference: (value) => calls.push(`saveDeafenedPreference:${value}`),
    syncApplicationSoundPlayback: () => calls.push('syncApplicationSoundPlayback'),
    pauseApplicationAudio: async (cancelResume?: boolean) => calls.push(`pauseApplicationAudio:${cancelResume ?? ''}`),
    resumeApplicationAudio: async (cancelResume?: boolean) => calls.push(`resumeApplicationAudio:${cancelResume ?? ''}`),
    stopApplicationAudio: async () => calls.push('stopApplicationAudio'),
    applicationAudioIsPlaying: () => applicationAudioPlayingRef.value,
    applicationAudioIsAutoPaused: () => applicationAudioAutoPausedRef.value,
    // 编排器桩：模拟「单入口 diff」的最小语义（enabled 变化生效、模式在启用时生效）。
    applyMicrophoneState: async (state) => {
      calls.push(`applyMicrophoneState:${JSON.stringify(state)}`)
      if (applyMicrophoneStateErrorRef.value) throw applyMicrophoneStateErrorRef.value
      if (state.enabled !== undefined) microphoneCurrentlyEnabledRef.value = state.enabled
      onApplyMicrophoneStateHook.current?.()
    },
    startAudio: async () => {
      calls.push('startAudio')
      if (startAudioErrorRef.value) throw startAudioErrorRef.value
    },
    resumeAudioContext: () => calls.push('resumeAudioContext'),
    syncParticipants: () => calls.push('syncParticipants'),
    applyAllVolumes: () => calls.push('applyAllVolumes'),
    applyPreferredDevices: async () => calls.push('applyPreferredDevices'),
    setErrorMessage: (msg) => calls.push(`setErrorMessage:${msg}`),
    syncDeafenedToBackend: async (guildId, channelId, value) => {
      calls.push(`syncDeafenedToBackend:${guildId},${channelId},${value}`)
      syncs.push({ guildId, channelId, deafened: value })
      if (syncDeafenedErrorRef.value) throw syncDeafenedErrorRef.value
    },
  }

  const h: Harness = {
    ctx, calls, syncs,
    roomRef, voiceSessionRef, statusRef, connectedChannelIdRef, connectedGuildIdRef,
    guildMuteValueRef, socketStatusRef, transmissionModeRef,
    microphoneCurrentlyEnabledRef, applicationAudioPlayingRef, applicationAudioAutoPausedRef,
    syncDeafenedErrorRef, applyMicrophoneStateErrorRef, startAudioErrorRef,
    onApplyMicrophoneStateHook,
  }
  return h
}

function tick() {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('未连接时 userToggledMute 只翻转麦克风偏好并投影到 muted，不触发任何 adapter', async () => {
  const h = makeHarness({ status: 'idle' })
  const m = useVoiceMuteDeafenModule(h.ctx)
  assert.equal(m.microphoneEnabledPreference.value, true)
  assert.equal(m.muted.value, false)
  await m.userToggledMute()
  assert.equal(m.microphoneEnabledPreference.value, false)
  assert.equal(m.muted.value, true)
  assert.deepEqual(h.calls, ['saveMicrophonePreference:false', 'syncApplicationSoundPlayback'])
})

test('未连接时 userToggledDeafen 切到耳机静音状态并保持 muted', async () => {
  const h = makeHarness({ status: 'idle' })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.userToggledDeafen()
  assert.equal(m.deafenedPreference.value, true)
  assert.equal(m.deafened.value, true)
  assert.equal(m.muted.value, true)
  assert.deepEqual(h.calls, ['saveDeafenedPreference:true', 'syncApplicationSoundPlayback'])
})

test('已连接时 userToggledDeafen off→on：关麦克风、暂停应用音频、同步播放、应用音量、同步后端', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    applicationAudioPlaying: true,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.userToggledDeafen()
  assert.equal(m.deafenedPreference.value, true)
  assert.equal(m.deafened.value, true)
  assert.equal(m.muted.value, true)
  assert.deepEqual(h.calls, [
    'saveDeafenedPreference:true',
    'setErrorMessage:',
    'applyMicrophoneState:{"enabled":false}',
    'pauseApplicationAudio:true',
    'syncApplicationSoundPlayback',
    'applyAllVolumes',
    'syncDeafenedToBackend:9,5,true',
    'syncParticipants',
  ])
})

test('已连接时 userToggledDeafen race 失败：在 applyMicrophoneState await 后 voiceSession 被 bump，reconcile 静默 return', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    applicationAudioPlaying: false,
  })
  h.onApplyMicrophoneStateHook.current = () => {
    h.voiceSessionRef.value += 1
  }
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.userToggledDeafen()
  // 偏好已写入（userToggledDeafen 一开始就 setDeafenedPreference(true)），
  // 但是 deafened.value 仍是 false（reconcile 在 race 检查处 return，未写 deafened=true）
  assert.equal(m.deafenedPreference.value, true)
  assert.equal(m.deafened.value, false)
  assert.equal(m.deafenChanging.value, false)
  // 关键：不再走到 pauseApplicationAudio、applyAllVolumes、syncDeafenedToBackend、syncParticipants
  assert.deepEqual(h.calls, [
    'saveDeafenedPreference:true',
    'setErrorMessage:',
    'applyMicrophoneState:{"enabled":false}',
  ])
})

test('已连接时 userToggledDeafen applyMicrophoneState 失败：catch 回滚偏好并重新 reconcile，最后写入 error', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    applicationAudioPlaying: false,
    applyMicrophoneStateError: new Error('applyMic failed'),
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.userToggledDeafen()
  // 偏好被回滚（previousDeafenedPreference=false）
  assert.equal(m.deafenedPreference.value, false)
  assert.equal(m.deafened.value, false)
  assert.equal(m.muted.value, false)
  assert.equal(m.deafenChanging.value, false)
  assert.ok(h.calls.includes('applyMicrophoneState:{"enabled":false}'))
  assert.ok(h.calls.some(c => c === 'setErrorMessage:applyMic failed'))
  // 成功路径里的 syncParticipants 不应该再次出现（catch 路径里外层 syncParticipants 不会调）
  assert.ok(!h.calls.includes('syncParticipants'))
})

test('已连接时 guildMuteChanged(true)：停应用音频 → 关麦克风 → 同步播放 → 应用音量 → 同步后端 → syncParticipants', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  assert.equal(m.guildMuted.value, false)
  await m.guildMuteChanged(true)
  assert.equal(m.guildMuted.value, true)
  assert.equal(m.deafened.value, false)
  assert.equal(m.muted.value, true)
  assert.deepEqual(h.calls, [
    'stopApplicationAudio',
    'startAudio',
    'resumeAudioContext',
    'applyMicrophoneState:{"enabled":false,"transmissionMode":"voice-activity"}',
    'syncApplicationSoundPlayback',
    'applyAllVolumes',
    'syncDeafenedToBackend:9,5,false',
    'syncParticipants',
  ])
})

test('transportRecovered 调 reconcile 流程，不调 syncParticipants（由调用方 .then 调用）', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: false,
    preseeMicrophoneEnabled: true,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.transportRecovered()
  assert.equal(m.deafened.value, false)
  assert.equal(m.muted.value, false)
  assert.ok(h.calls.includes('startAudio'))
  assert.ok(h.calls.includes('applyMicrophoneState:{"enabled":true,"transmissionMode":"voice-activity"}'))
  assert.ok(h.calls.includes('applyAllVolumes'))
  assert.ok(h.calls.includes('syncDeafenedToBackend:9,5,false'))
  assert.ok(!h.calls.includes('syncParticipants'))
})

test('transportRecovered 的 reconcile 异常被内部吞掉并写入 errorMessage', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: false,
    preseeMicrophoneEnabled: true,
  })
  h.startAudioErrorRef.value = new Error('startAudio boom')
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.transportRecovered()
  assert.ok(h.calls.some(c => c === 'setErrorMessage:startAudio boom'))
})

test('connectionReset 清掉 pending 队列与 deafenedSyncError、guildMuted，并按当前偏好投影 muted/deafened', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
  })
  h.syncDeafenedErrorRef.value = new Error('first sync fails')
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.userToggledDeafen()
  assert.equal(m.deafened.value, true)
  assert.equal(m.deafenedSyncError.value, '耳机静音状态同步失败，将在连接恢复后重试')
  // 模拟断开：room → null, voiceSession bumped
  h.voiceSessionRef.value += 1
  h.roomRef.value = null
  h.statusRef.value = 'idle'
  m.connectionReset()
  assert.equal(m.deafenedSyncError.value, '')
  assert.equal(m.guildMuted.value, false)
  // syncIdlePreferenceState 投影：deafened.value = deafenedPreference.value
  // 这里偏好仍是 true，所以 connectionReset 后 deafened=true
  assert.equal(m.deafened.value, m.deafenedPreference.value)
  assert.equal(m.muted.value, m.deafenedPreference.value || !m.microphoneEnabledPreference.value)
})

test('socketStatus 恢复 online 时 watch 触发 retryDeafenedSync，重试成功清掉 deafenedSyncError', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
  })
  h.syncDeafenedErrorRef.value = new Error('first sync fails')
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.userToggledDeafen()
  assert.equal(m.deafened.value, true)
  assert.equal(m.deafenedSyncError.value, '耳机静音状态同步失败，将在连接恢复后重试')
  // 第二次 sync 成功
  h.syncDeafenedErrorRef.value = null
  h.socketStatusRef.value = 'online'
  await tick()
  assert.equal(m.deafenedSyncError.value, '')
  assert.deepEqual(h.syncs.at(-1), { guildId: 9, channelId: 5, deafened: true })
})

test('notifyPreferenceChange 让 applyConnectionPreferences 循环看见偏好变化并继续迭代', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: false,
    preseeMicrophoneEnabled: true,
  })
  const orig = h.ctx.applyPreferredDevices
  let preferredCalls = 0
  let m = useVoiceMuteDeafenModule(h.ctx)
  h.ctx = {
    ...h.ctx,
    applyPreferredDevices: async () => {
      await orig()
      preferredCalls += 1
      if (preferredCalls === 1) m.notifyPreferenceChange()
    },
  }
  // 重建 module 以使用更新后的 ctx
  m = useVoiceMuteDeafenModule(h.ctx)
  await m.applyConnectionPreferences()
  assert.ok(preferredCalls >= 2, `applyPreferredDevices 应被多次调用，实际 ${preferredCalls}`)
  assert.equal(m.muted.value, false)
  assert.equal(m.deafened.value, false)
})

// ===== 频道作用域耳机静音（spec 07 / ADR-0032 / ticket 04）=====

test('setCallChannelDeafen(true) 已连接：停发频道麦克风、停播回放、后端 deafened=true，不写偏好', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    applicationAudioPlaying: true,
    preseeMicrophoneEnabled: true,
    preseeDeafened: false,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.setCallChannelDeafen(true)
  assert.equal(m.channelDeafened.value, true)
  // 频道作用域静音不碰全局耳机静音偏好
  assert.equal(m.deafenedPreference.value, false)
  // 停发频道麦克风 + 停播回放（deafened 投影为 true）
  assert.equal(m.deafened.value, true)
  assert.equal(m.muted.value, true)
  assert.ok(h.calls.includes('applyMicrophoneState:{"enabled":false}'))
  assert.ok(h.calls.includes('applyAllVolumes'))
  assert.ok(h.calls.includes('syncDeafenedToBackend:9,5,true'))
  // 不写偏好（saveDeafenedPreference 不被调用）
  assert.ok(!h.calls.includes('saveDeafenedPreference:true'))
  assert.ok(!h.calls.includes('saveDeafenedPreference:false'))
})

test('setCallChannelDeafen(false) 恢复通话前偏好：偏好本就未聋 → 解除 deafened', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    preseeMicrophoneEnabled: true,
    preseeDeafened: false,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.setCallChannelDeafen(true)
  assert.equal(m.deafened.value, true)
  await m.setCallChannelDeafen(false)
  assert.equal(m.channelDeafened.value, false)
  assert.equal(m.deafened.value, false)
  assert.equal(m.muted.value, false)
  assert.ok(h.calls.includes('applyMicrophoneState:{"enabled":true,"transmissionMode":"voice-activity"}'))
  assert.ok(h.calls.some(c => c === 'syncDeafenedToBackend:9,5,false'))
  assert.equal(m.deafenedPreference.value, false)
})

test('setCallChannelDeafen(false) 恢复回算：通话前本就全局聋 → 恢复后仍聋', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    preseeMicrophoneEnabled: true,
    preseeDeafened: true,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  assert.equal(m.deafened.value, true)
  await m.setCallChannelDeafen(true)
  assert.equal(m.deafened.value, true)
  await m.setCallChannelDeafen(false)
  // 恢复后按偏好回算：仍聋
  assert.equal(m.deafened.value, true)
  assert.equal(m.deafenedPreference.value, true)
})

test('通话中全局耳机静音偏好翻转不解除频道作用域耳机静音（两者独立）', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    preseeMicrophoneEnabled: true,
    preseeDeafened: false,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.setCallChannelDeafen(true)
  assert.equal(m.deafened.value, true)
  // 通话期间用户把全局耳机静音偏好关掉（它本就在 off，翻转 on 再 off 以覆盖）——
  // 直接走 userToggledDeafen 模拟：on（已是 channel 聋）→ off
  await m.userToggledDeafen()
  assert.equal(m.deafenedPreference.value, true)
  assert.equal(m.deafened.value, true)
  await m.userToggledDeafen()
  assert.equal(m.deafenedPreference.value, false)
  // 频道作用域静音仍在：偏好 off 但 channelDeafened 仍 true
  assert.equal(m.deafened.value, true)
  assert.equal(m.channelDeafened.value, true)
})

test('未连频道时 setCallChannelDeafen 只记录状态、无副作用；恢复也无副作用', async () => {
  const h = makeHarness({ status: 'idle' })
  const m = useVoiceMuteDeafenModule(h.ctx)
  const before = h.calls.length
  await m.setCallChannelDeafen(true)
  assert.equal(m.channelDeafened.value, true)
  assert.equal(h.calls.length, before)
  await m.setCallChannelDeafen(false)
  assert.equal(m.channelDeafened.value, false)
  assert.equal(m.deafenedPreference.value, false)
  assert.equal(h.calls.length, before)
})

test('setCallChannelDeafen 幂等：重复施加/解除不产生额外副作用', async () => {
  const h = makeHarness({
    status: 'connected',
    room: { kind: 'room' },
    voiceSession: 1,
    connectedChannelId: 5,
    connectedGuildId: 9,
    microphoneCurrentlyEnabled: true,
    preseeMicrophoneEnabled: true,
  })
  const m = useVoiceMuteDeafenModule(h.ctx)
  await m.setCallChannelDeafen(true)
  const syncCountTrue = h.calls.filter(c => c === 'syncDeafenedToBackend:9,5,true').length
  await m.setCallChannelDeafen(true)
  assert.equal(h.calls.filter(c => c === 'syncDeafenedToBackend:9,5,true').length, syncCountTrue)
})
