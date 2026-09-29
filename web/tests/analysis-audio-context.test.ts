import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisAudioContextFallbackOptions,
  analysisAudioContextOptions,
  createAnalysisAudioContext,
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
