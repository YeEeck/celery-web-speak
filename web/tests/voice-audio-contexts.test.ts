import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_SAMPLE_RATE,
  VOICE_MIX_LATENCY_HINT,
  createCaptureAudioContext,
  createPlaybackAudioContext,
  createVoiceAudioContextPair,
  isCaptureContextRnnoiseReady,
  voiceAudioContextFallbackOptions,
  voiceAudioContextOptions,
} from '../src/audio/voiceAudioContexts.ts'

test('voice mix requests 48 kHz balanced on every client', () => {
  assert.equal(VOICE_MIX_LATENCY_HINT, 'balanced')
  assert.deepEqual(voiceAudioContextOptions(), {
    latencyHint: 'balanced',
    sampleRate: CAPTURE_SAMPLE_RATE,
  })
  assert.deepEqual(voiceAudioContextFallbackOptions(), {
    latencyHint: 'balanced',
  })
})

test('createPlaybackAudioContext requests 48 kHz balanced', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(constructed.length, 1)
  assert.deepEqual(constructed[0], voiceAudioContextOptions())
})

test('createCaptureAudioContext uses the same 48 kHz balanced mix options', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createCaptureAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(constructed.length, 1)
  assert.deepEqual(constructed[0], voiceAudioContextOptions())
})

test('voice pair always reuses one context for playback and capture', () => {
  class FakeAudioContext {
    sampleRate: number
    constructor(options?: AudioContextOptions) {
      this.sampleRate = options?.sampleRate ?? 44_100
    }
  }
  const pair = createVoiceAudioContextPair(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(pair.playback, pair.capture)
  assert.equal(pair.playback?.sampleRate, CAPTURE_SAMPLE_RATE)
})

test('voice pair still shares when the constructor ignores sampleRate', () => {
  class FakeAudioContext {
    sampleRate = 44_100
    constructor(_options?: AudioContextOptions) {}
  }
  const pair = createVoiceAudioContextPair(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(pair.playback, pair.capture)
  assert.equal(pair.playback?.sampleRate, 44_100)
})

test('constructor falls back to balanced without sampleRate when 48 kHz is rejected', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
      if (options?.sampleRate !== undefined) throw new Error('sampleRate rejected')
    }
  }
  const context = createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.ok(context)
  assert.equal(constructed.length, 2)
  assert.deepEqual(constructed[0], voiceAudioContextOptions())
  assert.deepEqual(constructed[1], voiceAudioContextFallbackOptions())
})

test('RNNoise readiness requires a live 48 kHz capture context', () => {
  assert.equal(isCaptureContextRnnoiseReady(null), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 48_000 } as AudioContext), true)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'closed', sampleRate: 48_000 } as AudioContext), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 44_100 } as AudioContext), false)
})
