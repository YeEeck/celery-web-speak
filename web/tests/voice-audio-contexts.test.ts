import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_SAMPLE_RATE,
  createCaptureAudioContext,
  createPlaybackAudioContext,
  createVoiceAudioContextPair,
  isAndroidVoiceClient,
  isCaptureContextRnnoiseReady,
  voiceAudioContextFallbackOptions,
  voiceAudioContextOptions,
} from '../src/audio/voiceAudioContexts.ts'

test('desktop mix requests 48 kHz interactive', () => {
  assert.deepEqual(voiceAudioContextOptions(false), {
    latencyHint: 'interactive',
    sampleRate: CAPTURE_SAMPLE_RATE,
  })
  assert.deepEqual(voiceAudioContextFallbackOptions(false), {
    latencyHint: 'interactive',
  })
})

test('android mix keeps 48 kHz but uses balanced latency', () => {
  assert.deepEqual(voiceAudioContextOptions(true), {
    latencyHint: 'balanced',
    sampleRate: CAPTURE_SAMPLE_RATE,
  })
  assert.deepEqual(voiceAudioContextFallbackOptions(true), {
    latencyHint: 'balanced',
  })
})

test('android voice client is the shell or an Android UA, not desktop Electron', () => {
  assert.equal(isAndroidVoiceClient({ celeryShell: { platform: () => 'android' } }), true)
  assert.equal(isAndroidVoiceClient({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/120.0.0.0' }), true)
  assert.equal(isAndroidVoiceClient({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Electron/28.0.0' }), false)
  assert.equal(isAndroidVoiceClient({ userAgent: '' }), false)
})

test('createPlaybackAudioContext requests 48 kHz interactive', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext, false)
  assert.equal(constructed.length, 1)
  assert.equal(constructed[0].sampleRate, CAPTURE_SAMPLE_RATE)
  assert.equal(constructed[0].latencyHint, 'interactive')
})

test('createPlaybackAudioContext requests 48 kHz balanced on Android', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext, true)
  assert.equal(constructed.length, 1)
  assert.deepEqual(constructed[0], voiceAudioContextOptions(true))
})

test('createCaptureAudioContext uses the same 48 kHz interactive mix options', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createCaptureAudioContext(FakeAudioContext as unknown as typeof AudioContext, false)
  assert.equal(constructed.length, 1)
  assert.deepEqual(constructed[0], voiceAudioContextOptions(false))
})

test('voice pair always reuses one context for playback and capture', () => {
  class FakeAudioContext {
    sampleRate: number
    constructor(options?: AudioContextOptions) {
      this.sampleRate = options?.sampleRate ?? 44_100
    }
  }
  const pair = createVoiceAudioContextPair(FakeAudioContext as unknown as typeof AudioContext, true)
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

test('constructor falls back to balanced without sampleRate when Android 48 kHz is rejected', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
      if (options?.sampleRate !== undefined) throw new Error('sampleRate rejected')
    }
  }
  const context = createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext, true)
  assert.ok(context)
  assert.equal(constructed.length, 2)
  assert.deepEqual(constructed[0], voiceAudioContextOptions(true))
  assert.deepEqual(constructed[1], voiceAudioContextFallbackOptions(true))
})

test('RNNoise readiness requires a live 48 kHz capture context', () => {
  assert.equal(isCaptureContextRnnoiseReady(null), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 48_000 } as AudioContext), true)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'closed', sampleRate: 48_000 } as AudioContext), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 44_100 } as AudioContext), false)
})
