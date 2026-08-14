import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, type Ref } from 'vue'
import { RoomEvent } from 'livekit-client'
import { useVoiceCall, type VoiceCallContext } from '../src/stores/voice-call.ts'
import type { VoiceCredentials } from '../src/types.ts'

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

interface CallPeer {
  userId: number
  username: string
  displayName: string
}

class FakeParticipant {
  identity = 'me'
  name = '本地用户'
  isMicrophoneEnabled = false
  setMicrophoneCalls: boolean[] = []
  captureOptions: unknown = undefined
  publishOptions: unknown = undefined

  async setMicrophoneEnabled(enabled: boolean, captureOptions?: unknown, publishOptions?: unknown) {
    this.setMicrophoneCalls.push(enabled)
    this.isMicrophoneEnabled = enabled
    this.captureOptions = captureOptions
    this.publishOptions = publishOptions
    return { audioTrack: null, options: publishOptions }
  }
}

class FakeRemoteParticipant {
  identity: string
  name: string
  constructor(identity: string, name: string) {
    this.identity = identity
    this.name = name
  }
}

class FakeRoom {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  connectCalls = 0
  connectUrl = ''
  connectToken = ''
  disconnectCalls = 0
  connectError: Error | null = null
  localParticipant = new FakeParticipant()
  remoteParticipants = new Map<string, FakeRemoteParticipant>()

  on(event: string, callback: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(callback)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    for (const callback of this.listeners.get(event) ?? []) callback(...args)
  }

  async connect(url: string, token: string) {
    this.connectCalls += 1
    this.connectUrl = url
    this.connectToken = token
    if (this.connectError) throw this.connectError
    return this
  }

  disconnect() {
    this.disconnectCalls += 1
  }
}

interface Harness {
  state: {
    user: { id: number } | null
    microphoneEnabledPreference: Ref<boolean>
    inputDeviceId: string
    outputDeviceId: string
    echoCancellation: boolean
    noiseSuppression: boolean
  }
  ctx: VoiceCallContext
  call: ReturnType<typeof useVoiceCall>
  room: FakeRoom
  startRequests: Array<{ calleeUserId: number }>
  startResult: { callId: number; state: string; reason?: string }
  acceptCalls: number
  rejectCalls: number
  cancelCalls: number
  hangupCalls: number
  tokenCalls: number
  appendedElements: number
  removeAllCalls: number
  audioSinks: string[]
  pendingToken: { resolve: (value: VoiceCredentials) => void } | null
}

function makeHarness(): Harness {
  memoryStore.clear()
  const state: Harness['state'] = {
    user: { id: 1 },
    microphoneEnabledPreference: ref(true),
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    echoCancellation: true,
    noiseSuppression: true,
  }
  const room = new FakeRoom()
  const harness: Harness = {
    state,
    room,
    startRequests: [],
    startResult: { callId: 100, state: 'ringing' },
    acceptCalls: 0,
    rejectCalls: 0,
    cancelCalls: 0,
    hangupCalls: 0,
    tokenCalls: 0,
    appendedElements: 0,
    removeAllCalls: 0,
    audioSinks: [],
    pendingToken: null,
    ctx: {} as VoiceCallContext,
    call: null as unknown as ReturnType<typeof useVoiceCall>,
  }
  harness.ctx = {
    currentUser: () => state.user,
    createRoom: () => room as never,
    fetchCallToken: async () => {
      harness.tokenCalls += 1
      if (harness.pendingToken) {
        const pending = harness.pendingToken
        harness.pendingToken = null
        return new Promise((resolve) => pending.resolve(resolve))
      }
      return { url: 'ws://fake', token: 'call-token', roomName: 'call-100', channelId: 0 }
    },
    startCallRequest: async (calleeUserId) => {
      harness.startRequests.push({ calleeUserId })
      return harness.startResult
    },
    acceptRequest: async () => { harness.acceptCalls += 1 },
    rejectRequest: async () => { harness.rejectCalls += 1 },
    cancelRequest: async () => { harness.cancelCalls += 1 },
    hangupRequest: async () => { harness.hangupCalls += 1 },
    resolvedPreferredInputDeviceId: () => state.inputDeviceId,
    resolvedPreferredOutputDeviceId: () => state.outputDeviceId,
    echoCancellation: () => state.echoCancellation,
    noiseSuppression: () => state.noiseSuppression,
    microphoneEnabledPreference: () => state.microphoneEnabledPreference.value,
    appendAudioElement: () => { harness.appendedElements += 1 },
    removeAudioElements: () => { harness.removeAllCalls += 1 },
    applyAudioSink: (_element, deviceId) => { harness.audioSinks.push(deviceId) },
  }
  harness.call = useVoiceCall(harness.ctx)
  return harness
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const PEER: CallPeer = { userId: 2, username: 'alice', displayName: '爱丽丝' }

test('startCall sets outgoing state and records the call id', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  assert.equal(h.call.status.value, 'outgoing')
  assert.equal(h.call.callId.value, 100)
  assert.deepEqual(h.call.peer.value, PEER)
  assert.deepEqual(h.startRequests, [{ calleeUserId: 2 }])
  assert.equal(h.room.connectCalls, 0, '呼出中尚未加入房间')
})

test('startCall reaching a terminal state clears the session immediately', async () => {
  const h = makeHarness()
  h.startResult = { callId: 100, state: 'ended', reason: 'busy' }
  await h.call.startCall(PEER)
  assert.equal(h.call.status.value, 'idle')
  assert.equal(h.call.callId.value, null)
  assert.equal(h.call.endedReason.value, 'busy')
})

test('accept joins the call room and reaches active', async () => {
  const h = makeHarness()
  await h.call.handleSignal({ type: 'call_invite', callId: 100, peer: PEER, state: 'ringing' })
  assert.equal(h.call.status.value, 'ringing')
  await h.call.accept()
  assert.equal(h.acceptCalls, 1)
  assert.equal(h.call.status.value, 'active')
  assert.equal(h.tokenCalls, 1)
  assert.equal(h.room.connectCalls, 1)
  assert.equal(h.room.localParticipant.setMicrophoneCalls.includes(true), true)
})

test('caller receiving call_accept joins the room and reaches active', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  await h.call.handleSignal({ type: 'call_accept', callId: 100, peer: PEER, state: 'active' })
  assert.equal(h.call.status.value, 'active')
  assert.equal(h.tokenCalls, 1)
  assert.equal(h.room.connectCalls, 1)
})

test('reject clears the session and notifies the server', async () => {
  const h = makeHarness()
  await h.call.handleSignal({ type: 'call_invite', callId: 100, peer: PEER, state: 'ringing' })
  await h.call.reject()
  assert.equal(h.rejectCalls, 1)
  assert.equal(h.call.status.value, 'idle')
  assert.equal(h.call.endedReason.value, 'rejected')
})

test('cancel clears the outgoing session', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  await h.call.cancel()
  assert.equal(h.cancelCalls, 1)
  assert.equal(h.call.status.value, 'idle')
  assert.equal(h.call.endedReason.value, 'canceled')
})

test('hangup disconnects the room and clears the session', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  await h.call.handleSignal({ type: 'call_accept', callId: 100, peer: PEER, state: 'active' })
  await h.call.hangup()
  assert.equal(h.hangupCalls, 1)
  assert.equal(h.call.status.value, 'idle')
  assert.equal(h.room.disconnectCalls, 1)
  assert.equal(h.call.endedReason.value, 'ended')
})

test('terminal signals clear the session', async () => {
  for (const pair of [
    ['call_reject', 'rejected'],
    ['call_cancel', 'canceled'],
    ['call_timeout', 'timeout'],
    ['call_busy', 'busy'],
    ['call_unreachable', 'unreachable'],
    ['call_end', 'ended'],
  ] as const) {
    const [type, reason] = pair
    const h = makeHarness()
    await h.call.handleSignal({ type: 'call_invite', callId: 100, peer: PEER, state: 'ringing' })
    await h.call.handleSignal({ type, callId: 100, peer: PEER, state: 'ended', reason })
    assert.equal(h.call.status.value, 'idle', type + ' 应清理会话')
    assert.equal(h.call.endedReason.value, reason)
  }
})

test('call_timeout clears both the outgoing and ringing session', async () => {
  const outgoing = makeHarness()
  await outgoing.call.startCall(PEER)
  await outgoing.call.handleSignal({ type: 'call_timeout', callId: 100, peer: PEER, state: 'ended', reason: 'timeout' })
  assert.equal(outgoing.call.status.value, 'idle')
  assert.equal(outgoing.call.endedReason.value, 'timeout')
})

test('Reconnecting keeps the call active with a reconnecting flag', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  await h.call.handleSignal({ type: 'call_accept', callId: 100, peer: PEER, state: 'active' })
  h.room.emit(RoomEvent.Reconnecting)
  assert.equal(h.call.status.value, 'active')
  assert.equal(h.call.reconnecting.value, true)
  h.room.emit(RoomEvent.Reconnected)
  await flushPromises()
  assert.equal(h.call.reconnecting.value, false)
  assert.equal(h.call.status.value, 'active')
})

test('Disconnected ends the session and clears the overlay state', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  await h.call.handleSignal({ type: 'call_accept', callId: 100, peer: PEER, state: 'active' })
  h.room.emit(RoomEvent.Disconnected)
  await flushPromises()
  assert.equal(h.call.status.value, 'idle')
  assert.equal(h.call.callId.value, null)
  assert.equal(h.call.endedReason.value, 'disconnected')
  assert.equal(h.removeAllCalls, 1)
})

test('microphone publishing honors the global mute preference', async () => {
  const h = makeHarness()
  h.state.microphoneEnabledPreference.value = false
  await h.call.startCall(PEER)
  await h.call.handleSignal({ type: 'call_accept', callId: 100, peer: PEER, state: 'active' })
  assert.equal(h.room.localParticipant.setMicrophoneCalls.includes(true), false, '全局静音时不应开启麦克风')
})

test('toggleMicrophoneMute flips the local microphone without leaving the call', async () => {
  const h = makeHarness()
  await h.call.startCall(PEER)
  await h.call.handleSignal({ type: 'call_accept', callId: 100, peer: PEER, state: 'active' })
  await flushPromises()
  h.room.localParticipant.setMicrophoneCalls = []
  await h.call.toggleMicrophoneMute()
  assert.equal(h.room.localParticipant.setMicrophoneCalls.length, 1)
  assert.equal(h.room.localParticipant.setMicrophoneCalls[0], false)
  assert.equal(h.call.microphoneMuted.value, true)
  assert.equal(h.call.status.value, 'active')
})
