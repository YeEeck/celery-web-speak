import assert from 'node:assert/strict'
import test from 'node:test'
import { TrackActivityMonitor } from '../src/audio/TrackActivityMonitor.ts'

Object.defineProperty(globalThis, 'MediaStream', {
  value: class MediaStream {
    tracks: MediaStreamTrack[]
    constructor(tracks: MediaStreamTrack[]) {
      this.tracks = tracks
    }
  },
  configurable: true,
})

class FakeNode {
  connectCalls: unknown[] = []
  fftSize = 256
  smoothingTimeConstant = 0

  connect(target: unknown) {
    this.connectCalls.push(target)
    return target
  }

  disconnect() {}

  getFloatTimeDomainData(buffer: Float32Array) {
    buffer.fill(0)
  }
}

class FakeAudioContext {
  destination = { kind: 'speakers' }
  source = new FakeNode()
  analyser = new FakeNode()
  tap = {
    disconnectCalls: 0,
    stream: { getTracks: () => [{ stop() {} }] },
    disconnect() {
      this.disconnectCalls += 1
    },
  }
  state: AudioContextState = 'running'
  closeCalls = 0

  createMediaStreamSource() {
    return this.source
  }

  createAnalyser() {
    return this.analyser
  }

  createMediaStreamDestination() {
    return this.tap
  }

  async resume() {}

  async close() {
    this.closeCalls += 1
    this.state = 'closed'
  }
}

test('activity monitor routes analysers to a silent tap, not speakers', () => {
  const context = new FakeAudioContext()
  const monitor = new TrackActivityMonitor(
    () => undefined,
    250,
    () => context as unknown as AudioContext,
  )
  monitor.sync([{ identity: 'user-1', mediaTrack: { readyState: 'live' } as MediaStreamTrack, muted: false }])
  assert.deepEqual(context.source.connectCalls, [context.analyser])
  assert.deepEqual(context.analyser.connectCalls, [context.tap])
  assert.equal(context.analyser.connectCalls.includes(context.destination), false)
  monitor.destroy()
  assert.equal(context.tap.disconnectCalls, 1)
  assert.equal(context.closeCalls, 1)
})
