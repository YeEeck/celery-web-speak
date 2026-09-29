import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisAudioContextFallbackOptions,
  analysisAudioContextOptions,
  applyNoneSink,
  createAnalysisAudioContext,
  noneSinkApplied,
} from '../src/audio/analysisAudioContext.ts'

test('analysis context requests a none sink so it does not open speakers', () => {
  assert.deepEqual(analysisAudioContextOptions(), { sinkId: { type: 'none' } })
  assert.deepEqual(analysisAudioContextOptions(16_000), {
    sampleRate: 16_000,
    sinkId: { type: 'none' },
  })
  assert.deepEqual(analysisAudioContextFallbackOptions(), {})
  assert.deepEqual(analysisAudioContextFallbackOptions(16_000), { sampleRate: 16_000 })
})

test('createAnalysisAudioContext passes none sink to the constructor', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  const context = createAnalysisAudioContext(16_000, FakeAudioContext as unknown as typeof AudioContext)
  assert.ok(context)
  assert.equal(constructed.length, 1)
  assert.deepEqual(constructed[0], analysisAudioContextOptions(16_000))
})

test('constructor falls back to sampleRate only when none sink is rejected', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
      if (options?.sinkId !== undefined) throw new Error('sinkId rejected')
    }
  }
  const context = createAnalysisAudioContext(16_000, FakeAudioContext as unknown as typeof AudioContext)
  assert.ok(context)
  assert.equal(constructed.length, 2)
  assert.deepEqual(constructed[0], analysisAudioContextOptions(16_000))
  assert.deepEqual(constructed[1], analysisAudioContextFallbackOptions(16_000))
})

test('constructor returns null when both none-sink and fallback are rejected', () => {
  class FakeAudioContext {
    constructor(_options?: AudioContextOptions) {
      throw new Error('rejected')
    }
  }
  assert.equal(createAnalysisAudioContext(16_000, FakeAudioContext as unknown as typeof AudioContext), null)
})

test('noneSinkApplied is true only for { type: none }', () => {
  assert.equal(noneSinkApplied({ sinkId: { type: 'none' } } as AudioContext), true)
  assert.equal(noneSinkApplied({ sinkId: '' } as AudioContext), false)
  assert.equal(noneSinkApplied({ sinkId: 'default' } as AudioContext), false)
  assert.equal(noneSinkApplied({} as AudioContext), false)
})

test('applyNoneSink is a no-op when none sink is already applied', async () => {
  const setSinkIdCalls: unknown[] = []
  const context = {
    sinkId: { type: 'none' },
    async setSinkId(id: unknown) {
      setSinkIdCalls.push(id)
    },
  }
  assert.equal(await applyNoneSink(context as unknown as AudioContext), true)
  assert.deepEqual(setSinkIdCalls, [])
})

test('applyNoneSink uses setSinkId when constructor left the default output', async () => {
  const context = {
    sinkId: '' as string | { type: string },
    async setSinkId(id: string | { type: string }) {
      this.sinkId = id
    },
  }
  assert.equal(await applyNoneSink(context as unknown as AudioContext), true)
  assert.deepEqual(context.sinkId, { type: 'none' })
})

test('applyNoneSink returns false when setSinkId is missing or rejected', async () => {
  assert.equal(await applyNoneSink({ sinkId: '' } as AudioContext), false)
  const context = {
    sinkId: '',
    async setSinkId() {
      throw new Error('rejected')
    },
  }
  assert.equal(await applyNoneSink(context as unknown as AudioContext), false)
})
