import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPTURE_SAMPLE_RATE,
  captureAudioContextOptions,
  createCaptureAudioContext,
  createPlaybackAudioContext,
  createVoiceAudioContextPair,
  isAndroidVoiceClient,
  isCaptureContextRnnoiseReady,
  playbackAudioContextOptions,
} from '../src/audio/voiceAudioContexts.ts'

test('Android clients include the shell marker or an Android UA', () => {
  assert.equal(isAndroidVoiceClient({ userAgent: 'Mozilla/5.0' }), false)
  assert.equal(isAndroidVoiceClient({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), true)
  assert.equal(isAndroidVoiceClient({ celeryShell: {}, userAgent: 'Mozilla/5.0' }), true)
})

test('playback context is native balanced on Android and 48 kHz interactive on desktop', () => {
  assert.deepEqual(playbackAudioContextOptions(true), { latencyHint: 'balanced' })
  assert.deepEqual(playbackAudioContextOptions(false), {
    latencyHint: 'interactive',
    sampleRate: CAPTURE_SAMPLE_RATE,
  })
})

test('capture context requests 48 kHz and matches platform latency policy', () => {
  assert.deepEqual(captureAudioContextOptions(true), {
    sampleRate: CAPTURE_SAMPLE_RATE,
    latencyHint: 'balanced',
  })
  assert.deepEqual(captureAudioContextOptions(false), {
    sampleRate: CAPTURE_SAMPLE_RATE,
    latencyHint: 'interactive',
  })
})

test('createPlaybackAudioContext does not force 48 kHz on Android', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(
    FakeAudioContext as unknown as typeof AudioContext,
    { celeryShell: {}, userAgent: 'Mozilla/5.0' },
  )
  assert.equal('sampleRate' in constructed[0], false)
  assert.equal(constructed[0].latencyHint, 'balanced')
})

test('createPlaybackAudioContext requests 48 kHz interactive on desktop', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createPlaybackAudioContext(
    FakeAudioContext as unknown as typeof AudioContext,
    { userAgent: 'Mozilla/5.0' },
  )
  assert.equal(constructed[0].sampleRate, CAPTURE_SAMPLE_RATE)
  assert.equal(constructed[0].latencyHint, 'interactive')
})

test('createCaptureAudioContext uses balanced latency on Android shell', () => {
  const constructed: AudioContextOptions[] = []
  class FakeAudioContext {
    constructor(options?: AudioContextOptions) {
      constructed.push(options ?? {})
    }
  }
  createCaptureAudioContext(
    FakeAudioContext as unknown as typeof AudioContext,
    { celeryShell: {}, userAgent: 'Mozilla/5.0' },
  )
  assert.equal(constructed[0].sampleRate, CAPTURE_SAMPLE_RATE)
  assert.equal(constructed[0].latencyHint, 'balanced')
})

test('desktop voice pair reuses the 48 kHz playback context for capture', () => {
  class FakeAudioContext {
    sampleRate: number
    constructor(options?: AudioContextOptions) {
      this.sampleRate = options?.sampleRate ?? 44_100
    }
  }
  const pair = createVoiceAudioContextPair(
    FakeAudioContext as unknown as typeof AudioContext,
    { userAgent: 'Mozilla/5.0' },
  )
  assert.equal(pair.playback, pair.capture)
  assert.equal(pair.playback?.sampleRate, CAPTURE_SAMPLE_RATE)
})

test('Android voice pair keeps playback and capture as separate contexts', () => {
  class FakeAudioContext {
    sampleRate: number
    constructor(options?: AudioContextOptions) {
      this.sampleRate = options?.sampleRate ?? 44_100
    }
  }
  const pair = createVoiceAudioContextPair(
    FakeAudioContext as unknown as typeof AudioContext,
    { celeryShell: {}, userAgent: 'Mozilla/5.0' },
  )
  assert.notEqual(pair.playback, pair.capture)
  assert.equal(pair.capture?.sampleRate, CAPTURE_SAMPLE_RATE)
})

test('desktop pair splits capture when playback cannot lock 48 kHz', () => {
  class FakeAudioContext {
    sampleRate = 44_100
  }
  const pair = createVoiceAudioContextPair(
    FakeAudioContext as unknown as typeof AudioContext,
    { userAgent: 'Mozilla/5.0' },
  )
  assert.notEqual(pair.playback, pair.capture)
})

test('RNNoise readiness requires a live 48 kHz capture context', () => {
  assert.equal(isCaptureContextRnnoiseReady(null), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 48_000 } as AudioContext), true)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'closed', sampleRate: 48_000 } as AudioContext), false)
  assert.equal(isCaptureContextRnnoiseReady({ state: 'running', sampleRate: 44_100 } as AudioContext), false)
})
