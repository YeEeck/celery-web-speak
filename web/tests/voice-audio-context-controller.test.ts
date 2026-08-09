import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceAudioContextController } from '../src/audio/VoiceAudioContextController.ts'

class FakeAudioContext extends EventTarget {
  state: AudioContextState = 'running'
  closeCalls = 0

  setState(state: AudioContextState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }

  async close() {
    this.closeCalls += 1
    this.setState('closed')
  }
}

function asAudioContext(context: FakeAudioContext) {
  return context as unknown as AudioContext
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

test('resumes a suspended active voice context once while recovery is pending', async () => {
  const context = new FakeAudioContext()
  let resumeCalls = 0
  let finishResume: (() => void) | null = null
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    shouldResume: () => true,
    startAudio: () => {
      resumeCalls += 1
      return new Promise<void>((resolve) => { finishResume = resolve })
    },
  })

  context.setState('suspended')
  context.setState('suspended')
  assert.equal(resumeCalls, 1)

  finishResume?.()
  await flushPromises()
  await controller.destroy()
})

test('does not resume until the suspended context belongs to an audible voice session', async () => {
  const context = new FakeAudioContext()
  let active = false
  let resumeCalls = 0
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    shouldResume: () => active,
    startAudio: async () => {
      resumeCalls += 1
      context.setState('running')
    },
  })

  context.setState('suspended')
  assert.equal(resumeCalls, 0)

  active = true
  controller.resumeIfNeeded()
  assert.equal(resumeCalls, 1)
  await controller.destroy()
})

test('retries from the next user interaction when automatic recovery stays suspended', async () => {
  const context = new FakeAudioContext()
  const interactions = new EventTarget()
  let resumeCalls = 0
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    interactionTarget: interactions,
    shouldResume: () => true,
    startAudio: async () => {
      resumeCalls += 1
      if (resumeCalls === 2) context.setState('running')
    },
  })

  context.setState('suspended')
  await flushPromises()
  assert.equal(resumeCalls, 1)

  interactions.dispatchEvent(new Event('pointerdown'))
  assert.equal(resumeCalls, 2)
  interactions.dispatchEvent(new Event('keydown'))
  assert.equal(resumeCalls, 2)
  await controller.destroy()
})

test('destroy removes recovery listeners and closes the owned context', async () => {
  const context = new FakeAudioContext()
  const interactions = new EventTarget()
  let resumeCalls = 0
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    interactionTarget: interactions,
    shouldResume: () => true,
    startAudio: async () => { resumeCalls += 1 },
  })

  context.setState('suspended')
  await flushPromises()
  await controller.destroy()
  assert.equal(context.closeCalls, 1)

  interactions.dispatchEvent(new Event('pointerdown'))
  context.setState('suspended')
  assert.equal(resumeCalls, 1)
})

test('ensureRunning skips startAudio while the context is running (ADR-0031)', async () => {
  const context = new FakeAudioContext()
  let resumeCalls = 0
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    shouldResume: () => true,
    startAudio: async () => { resumeCalls += 1 },
  })

  await controller.ensureRunning()
  assert.equal(resumeCalls, 0, 'running 时跳过 SDK startAudio（不重建远端路由）')
  await controller.ensureRunning()
  assert.equal(resumeCalls, 0)
  await controller.destroy()
})

test('ensureRunning calls startAudio while the context is suspended', async () => {
  const context = new FakeAudioContext()
  let resumeCalls = 0
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    shouldResume: () => true,
    startAudio: async () => {
      resumeCalls += 1
      context.setState('running')
    },
  })

  context.setState('suspended')
  await controller.ensureRunning()
  assert.equal(resumeCalls, 1, 'suspended 时恢复播放（重路由无感知）')
  await controller.ensureRunning()
  assert.equal(resumeCalls, 1, '恢复 running 后再次跳过')
  await controller.destroy()
})

test('ensureRunning stays inert after destroy', async () => {
  const context = new FakeAudioContext()
  let resumeCalls = 0
  const controller = new VoiceAudioContextController(asAudioContext(context), {
    shouldResume: () => true,
    startAudio: async () => { resumeCalls += 1 },
  })

  context.setState('suspended')
  await flushPromises()
  assert.equal(resumeCalls, 1, 'suspended 触发一次自动恢复尝试')
  await controller.destroy()
  await controller.ensureRunning()
  assert.equal(resumeCalls, 1, 'destroy 后 ensureRunning 惰性')
})
