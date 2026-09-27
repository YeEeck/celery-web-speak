import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_SAMPLE_RATE,
  VOICE_GRAPH_LATENCY,
  captureAudioContextOptions,
  createCaptureAudioContext,
  createPlaybackAudioContext,
  isCaptureContextRnnoiseReady,
  playbackAudioContextOptions,
} from '../src/audio/voiceAudioContexts.ts'

test('playback context uses balanced latency and does not lock sample rate', () => {
  assert.deepEqual(playbackAudioContextOptions(), { latencyHint: VOICE_GRAPH_LATENCY })
})

test('capture context requests 48 kHz with the same balanced latency', () => {
  assert.deepEqual(captureAudioContextOptions(), {
    sampleRate: CAPTURE_SAMPLE_RATE,
    latencyHint: VOICE_GRAPH_LATENCY,
  })
})

test('createPlaybackAudioContext does not force 48 kHz', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal('sampleRate' in constructed[0], false)
  assert.equal(constructed[0].latencyHint, 'balanced')
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

test('RNNoise readiness requires a live 48 kHz capture context', () => {
  assert.equal(isCaptureContextRnnoiseReady(null), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 48_000 } as AudioContext), true)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'closed', sampleRate: 48_000 } as AudioContext), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 44_100 } as AudioContext), false)
})
