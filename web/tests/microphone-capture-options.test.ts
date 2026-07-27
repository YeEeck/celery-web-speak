import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMicrophoneCaptureOptions } from '../src/audio/microphoneCaptureOptions.ts'

test('disables automatic gain while preserving other microphone preferences', () => {
  assert.deepEqual(buildMicrophoneCaptureOptions({
    deviceId: 'preferred-microphone',
    echoCancellation: true,
    noiseSuppression: false,
  }), {
    deviceId: 'preferred-microphone',
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  })
})
