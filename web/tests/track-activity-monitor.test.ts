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
  gain = { value: 1 }

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
  silence = new FakeNode()
  state: AudioContextState = 'running'
  closeCalls = 0

  createMediaStreamSource() {
    return this.source
  }

  createAnalyser() {
    return this.analyser
  }

  createGain() {
    return this.silence
  }

  async resume() {}

  async close() {
    this.closeCalls += 1
    this.state = 'closed'
  }
}

test('activity monitor routes analysers through a muted gain to speakers', () => {
  const OriginalAudioContext = globalThis.AudioContext
  const context = new FakeAudioContext()
  globalThis.AudioContext = class {
    constructor() {
      return context
    }
  } as unknown as typeof AudioContext
  try {
    const monitor = new TrackActivityMonitor(() => undefined)
    monitor.sync([{ identity: 'user-1', mediaTrack: { readyState: 'live' } as MediaStreamTrack, muted: false }])
    assert.equal(context.silence.gain.value, 0)
    assert.deepEqual(context.silence.connectCalls, [context.destination])
    assert.deepEqual(context.source.connectCalls, [context.analyser])
    assert.deepEqual(context.analyser.connectCalls, [context.silence])
    monitor.destroy()
    assert.equal(context.closeCalls, 1)
  } finally {
    globalThis.AudioContext = OriginalAudioContext
  }
})
