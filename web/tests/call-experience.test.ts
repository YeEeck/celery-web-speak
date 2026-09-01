import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref, type Ref } from 'vue'
import { useCallExperience, type CallExperienceContext } from '../src/stores/call-experience.ts'
import type { CallEndReason, CallStatus } from '../src/stores/call-signal.ts'

interface Harness {
  status: Ref<CallStatus>
  endedReason: Ref<CallEndReason | null>
  deafen: boolean[]
  sounds: string[]
  toasts: Array<{ message: string, type: string }>
}

function makeHarness(): Harness {
  const status = ref<CallStatus>('idle')
  const endedReason = ref<CallEndReason | null>(null)
  const deafen: boolean[] = []
  const sounds: string[] = []
  const toasts: Array<{ message: string, type: string }> = []
  const ctx: CallExperienceContext = {
    status,
    endedReason,
    setCallChannelDeafen: async (active) => {
      deafen.push(active)
    },
    loop: (occurrence) => {
      sounds.push(`loop:${occurrence}`)
    },
    stopLoop: () => {
      sounds.push('stopLoop')
    },
    signal: (occurrence) => {
      sounds.push(`signal:${occurrence}`)
    },
    showToast: (message, type) => {
      toasts.push({ message, type })
    },
  }
  useCallExperience(ctx)
  return { status, endedReason, deafen, sounds, toasts }
}

function clear(h: Harness) {
  h.deafen.length = 0
  h.sounds.length = 0
  h.toasts.length = 0
}

async function apply(h: Harness, status: CallStatus, endedReason?: CallEndReason | null) {
  if (endedReason !== undefined) h.endedReason.value = endedReason
  h.status.value = status
  await nextTick()
}

test('构造时 status=idle 不施加任何阶段政策', async () => {
  const h = makeHarness()
  await nextTick()
  assert.deepEqual(h.deafen, [])
  assert.deepEqual(h.sounds, [])
  assert.deepEqual(h.toasts, [])
})

test('idle → outgoing：施加频道作用域耳机静音并循环回铃', async () => {
  const h = makeHarness()
  await apply(h, 'outgoing')
  assert.deepEqual(h.deafen, [true])
  assert.deepEqual(h.sounds, ['loop:call-outgoing'])
  assert.deepEqual(h.toasts, [])
})

test('outgoing → idle（busy）：解除频道聋、停循环、不播结束音、主叫 toast「对方正忙」', async () => {
  const h = makeHarness()
  await apply(h, 'outgoing')
  clear(h)
  await apply(h, 'idle', 'busy')
  assert.deepEqual(h.deafen, [false])
  assert.deepEqual(h.sounds, ['stopLoop'])
  assert.deepEqual(h.toasts, [{ message: '对方正忙', type: 'warning' }])
})

test('outgoing → idle（endedReason=null）：解除频道聋、停循环、无 toast', async () => {
  const h = makeHarness()
  await apply(h, 'outgoing')
  clear(h)
  await apply(h, 'idle', null)
  assert.deepEqual(h.deafen, [false])
  assert.deepEqual(h.sounds, ['stopLoop'])
  assert.deepEqual(h.toasts, [])
})

test('outgoing → active：保持频道聋、停循环并播接通音、无 toast', async () => {
  const h = makeHarness()
  await apply(h, 'outgoing')
  clear(h)
  await apply(h, 'active')
  assert.deepEqual(h.deafen, [true])
  assert.deepEqual(h.sounds, ['stopLoop', 'signal:call-connected'])
  assert.deepEqual(h.toasts, [])
})

test('idle → ringing：不施加频道聋、循环振铃', async () => {
  const h = makeHarness()
  await apply(h, 'ringing')
  assert.deepEqual(h.deafen, [false])
  assert.deepEqual(h.sounds, ['loop:call-incoming'])
  assert.deepEqual(h.toasts, [])
})

test('ringing → idle（canceled）：解除频道聋、停循环、被叫 toast「对方已取消」', async () => {
  const h = makeHarness()
  await apply(h, 'ringing')
  clear(h)
  await apply(h, 'idle', 'canceled')
  assert.deepEqual(h.deafen, [false])
  assert.deepEqual(h.sounds, ['stopLoop'])
  assert.deepEqual(h.toasts, [{ message: '对方已取消', type: 'warning' }])
})

test('ringing → active：施加频道聋、停循环并播接通音、无 toast', async () => {
  const h = makeHarness()
  await apply(h, 'ringing')
  clear(h)
  await apply(h, 'active')
  assert.deepEqual(h.deafen, [true])
  assert.deepEqual(h.sounds, ['stopLoop', 'signal:call-connected'])
  assert.deepEqual(h.toasts, [])
})

test('active → idle（ended）：解除频道聋、停循环并播结束音、主动挂断无 toast', async () => {
  const h = makeHarness()
  await apply(h, 'outgoing')
  await apply(h, 'active')
  clear(h)
  await apply(h, 'idle', 'ended')
  assert.deepEqual(h.deafen, [false])
  assert.deepEqual(h.sounds, ['stopLoop', 'signal:call-ended'])
  assert.deepEqual(h.toasts, [])
})

test('active → idle（disconnected）：解除频道聋、停循环并播结束音、toast「通话已断开」', async () => {
  const h = makeHarness()
  await apply(h, 'outgoing')
  await apply(h, 'active')
  clear(h)
  await apply(h, 'idle', 'disconnected')
  assert.deepEqual(h.deafen, [false])
  assert.deepEqual(h.sounds, ['stopLoop', 'signal:call-ended'])
  assert.deepEqual(h.toasts, [{ message: '通话已断开', type: 'error' }])
})
