import assert from 'node:assert/strict'
import test from 'node:test'
import { connectWithoutPlayback, disconnectSilentTap } from '../src/audio/silentAudioGraph.ts'

class FakeNode {
  connectCalls: unknown[] = []
  disconnectCalls = 0

  connect(target: unknown) {
    this.connectCalls.push(target)
    return target
  }

  disconnect() {
    this.disconnectCalls += 1
  }
}

class FakeTap extends FakeNode {
  stream = {
    tracks: [{ stopCalls: 0, stop() { this.stopCalls += 1 } }],
    getTracks() {
      return this.tracks
    },
  }
}

class FakeAudioContext {
  destination = { kind: 'speakers' }
  taps: FakeTap[] = []

  createMediaStreamDestination() {
    const tap = new FakeTap()
    this.taps.push(tap)
    return tap
  }
}

test('connectWithoutPlayback taps MediaStreamDestination and never the speakers', () => {
  const context = new FakeAudioContext()
  const node = new FakeNode()
  const tap = connectWithoutPlayback(context as unknown as AudioContext, node as unknown as AudioNode)
  assert.equal(tap, context.taps[0])
  assert.deepEqual(node.connectCalls, [tap])
  assert.equal(node.connectCalls.includes(context.destination), false)
})

test('disconnectSilentTap stops dummy destination tracks', () => {
  const context = new FakeAudioContext()
  const node = new FakeNode()
  const tap = connectWithoutPlayback(context as unknown as AudioContext, node as unknown as AudioNode)
  disconnectSilentTap(node as unknown as AudioNode, tap)
  assert.equal(node.disconnectCalls, 1)
  assert.equal(tap.disconnectCalls, 1)
  assert.equal(tap.stream.tracks[0].stopCalls, 1)
})
