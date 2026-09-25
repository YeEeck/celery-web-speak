import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_SAMPLE_RATE,
  captureAudioContextOptions,
  createCaptureAudioContext,
  createPlaybackAudioContext,
  isAndroidVoiceClient,
  isCaptureContextRnnoiseReady,
  playbackAudioContextOptions,
} from '../src/audio/voiceAudioContexts.ts'

test('Android clients include the shell marker or an Android UA', () => {
  assert.equal(isAndroidVoiceClient({ userAgent: 'Mozilla/5.0' }), false)
  assert.equal(isAndroidVoiceClient({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), true)
  assert.equal(isAndroidVoiceClient({ celeryShell: {}, userAgent: 'Mozilla/5.0' }), true)
})

test('playback context uses balanced latency on Android and interactive elsewhere', () => {
  assert.deepEqual(playbackAudioContextOptions(true), { latencyHint: 'balanced' })
  assert.deepEqual(playbackAudioContextOptions(false), { latencyHint: 'interactive' })
})

test('capture context requests 48 kHz and does not set a playback latency hint', () => {
  assert.deepEqual(captureAudioContextOptions(), { sampleRate: CAPTURE_SAMPLE_RATE })
})

test('createPlaybackAudioContext does not force 48 kHz', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(FakeAudioContext as unknown as typeof AudioContext, { userAgent: 'Mozilla/5.0' })
  assert.equal('sampleRate' in constructed[0], false)
  assert.equal(constructed[0].latencyHint, 'interactive')
})

test('createCaptureAudioContext requests 48 kHz', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createCaptureAudioContext(FakeAudioContext as unknown as typeof AudioContext)
  assert.equal(constructed[0].sampleRate, CAPTURE_SAMPLE_RATE)
})

test('RNNoise readiness requires a live 48 kHz capture context', () => {
  assert.equal(isCaptureContextRnnoiseReady(null), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 48_000 } as AudioContext), true)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'closed', sampleRate: 48_000 } as AudioContext), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 44_100 } as AudioContext), false)
})
