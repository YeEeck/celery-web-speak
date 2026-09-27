import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_SAMPLE_RATE,
  captureAudioContextOptions,
  createCaptureAudioContext,
  createPlaybackAudioContext,
  createVoiceAudioContextPair,
  isCaptureContextRnnoiseReady,
  playbackAudioContextOptions,
} from '../src/audio/voiceAudioContexts.ts'

test('playback requests 48 kHz interactive so mix matches the media clock', () => {
  assert.deepEqual(playbackAudioContextOptions(), {
    latencyHint: 'interactive',
    sampleRate: CAPTURE_SAMPLE_RATE,
  })
})

test('capture-only graph requests 48 kHz balanced for RNNoise', () => {
  assert.deepEqual(captureAudioContextOptions(), {
    sampleRate: CAPTURE_SAMPLE_RATE,
    latencyHint: 'balanced',
  })
})

test('createPlaybackAudioContext requests 48 kHz interactive', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(constructed[0].sampleRate, CAPTURE_SAMPLE_RATE)
  assert.equal(constructed[0].latencyHint, 'interactive')
})

test('createCaptureAudioContext requests 48 kHz balanced', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createCaptureAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(constructed[0].sampleRate, CAPTURE_SAMPLE_RATE)
  assert.equal(constructed[0].latencyHint, 'balanced')
})

test('voice pair reuses playback when the browser actually gives 48 kHz', () => {
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

test('voice pair splits capture when playback cannot lock 48 kHz', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    sampleRate = 44_100
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  const pair = createVoiceAudioContextPair(FakeAudioContext as unknown as typeof AudioContext)
  assert.notEqual(pair.playback, pair.capture)
  assert.equal(constructed[0].latencyHint, 'interactive')
  assert.equal(constructed[1].sampleRate, CAPTURE_SAMPLE_RATE)
  assert.equal(constructed[1].latencyHint, 'balanced')
})

test('RNNoise readiness requires a live 48 kHz capture context', () => {
  assert.equal(isCaptureContextRnnoiseReady(null), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 48_000 } as AudioContext), true)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'closed', sampleRate: 48_000 } as AudioContext), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 44_100 } as AudioContext), false)
})
