import assert from 'node:assert/strict'
import test from 'node:test'
import { SpeechDetectionLifecycle } from '../src/audio/SpeechDetectionLifecycle.ts'

class FakeEngine {
  startCalls: Array<string | undefined> = []
  restartCalls: Array<string | undefined> = []
  stopCalls = 0
  resetFailureCalls = 0
  failed = false
  failureListeners = new Set<() => void>()

  onFailure(listener: () => void) {
    this.failureListeners.add(listener)
    return () => {
      this.failureListeners.delete(listener)
    }
  }

  async start(deviceId?: string) {
    if (this.failed) return false
    this.startCalls.push(deviceId)
    return true
  }

  async restart(deviceId?: string) {
    if (this.failed) return false
    this.restartCalls.push(deviceId)
    return true
  }

  stop() {
    this.stopCalls += 1
  }

  resetFailure() {
    this.resetFailureCalls += 1
    this.failed = false
  }

  fail() {
    this.failed = true
    for (const listener of this.failureListeners) listener()
  }
}

interface Harness {
  engine: FakeEngine
  active: boolean
  deviceId: string
  routingGeneration: number
  retryListeners: Array<() => void>
  lifecycle: SpeechDetectionLifecycle
  emitRetryEvent(): void
}

function makeHarness() {
  const engine = new FakeEngine()
  const harness: Harness = {
    engine,
    active: false,
    deviceId: '',
    routingGeneration: 0,
    retryListeners: [],
    lifecycle: null as unknown as SpeechDetectionLifecycle,
    emitRetryEvent() {
      for (const listener of harness.retryListeners) listener()
    },
  }
  harness.lifecycle = new SpeechDetectionLifecycle({
    engine,
    isActive: () => harness.active,
    inputDeviceId: () => harness.deviceId,
    inputRoutingGeneration: () => harness.routingGeneration,
    subscribeRetryEvents: (listener) => {
      harness.retryListeners.push(listener)
      return () => {
        harness.retryListeners = harness.retryListeners.filter((item) => item !== listener)
      }
    },
  })
  return harness
}

test('active sync starts the engine with the preferred device', () => {
  const h = makeHarness()
  h.active = true
  h.deviceId = 'mic-1'
  h.lifecycle.sync()
  assert.deepEqual(h.engine.startCalls, ['mic-1'])
  assert.equal(h.engine.stopCalls, 0)
})

test('inactive sync stops the engine', () => {
  const h = makeHarness()
  h.active = true
  h.lifecycle.sync()
  h.active = false
  h.lifecycle.sync()
  assert.deepEqual(h.engine.startCalls, [''])
  assert.equal(h.engine.stopCalls, 1)
})

test('device change restarts capture with the new device', () => {
  const h = makeHarness()
  h.active = true
  h.deviceId = 'mic-1'
  h.lifecycle.sync()
  h.deviceId = 'mic-2'
  h.lifecycle.sync()
  assert.deepEqual(h.engine.startCalls, ['mic-1', 'mic-2'])
  assert.deepEqual(h.engine.restartCalls, [])
  assert.equal(h.engine.stopCalls, 0)
})

test('routing generation change force-restarts capture on the same device', () => {
  const h = makeHarness()
  h.active = true
  h.deviceId = 'default'
  h.routingGeneration = 1
  h.lifecycle.sync()
  assert.deepEqual(h.engine.startCalls, ['default'])
  assert.deepEqual(h.engine.restartCalls, [])

  h.routingGeneration = 2
  h.lifecycle.sync()
  assert.deepEqual(h.engine.startCalls, ['default'])
  assert.deepEqual(h.engine.restartCalls, ['default'])
})

test('a failed engine is revived by a retry event', () => {
  const h = makeHarness()
  h.active = true
  h.lifecycle.sync()
  const startsAfterFirstSync = h.engine.startCalls.length
  h.engine.fail()

  h.emitRetryEvent()
  assert.equal(h.engine.resetFailureCalls, 1)
  assert.equal(h.engine.startCalls.length, startsAfterFirstSync + 1)
})

test('retry event is ignored while inactive or while not failed', () => {
  const h = makeHarness()
  h.active = true
  h.lifecycle.sync()
  const startsAfterFirstSync = h.engine.startCalls.length

  h.emitRetryEvent()
  assert.equal(h.engine.startCalls.length, startsAfterFirstSync)

  h.engine.fail()
  h.active = false
  h.emitRetryEvent()
  assert.equal(h.engine.resetFailureCalls, 0)
  assert.equal(h.engine.startCalls.length, startsAfterFirstSync)
})

test('sync after permission re-grant retries a failed engine', () => {
  const h = makeHarness()
  h.active = true
  h.lifecycle.sync()
  const startsAfterFirstSync = h.engine.startCalls.length
  h.engine.fail()

  h.active = false
  h.lifecycle.sync()
  h.active = true
  h.lifecycle.sync()
  assert.equal(h.engine.resetFailureCalls, 1)
  assert.equal(h.engine.startCalls.length, startsAfterFirstSync + 1)
})
