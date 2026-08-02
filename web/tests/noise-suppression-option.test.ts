import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNoiseSuppressionOption, resolveNoiseSuppression } from '../src/stores/voice-utils.ts'

test('parseNoiseSuppressionOption migrates legacy boolean values', () => {
  assert.equal(parseNoiseSuppressionOption('true'), 'rnnoise')
  assert.equal(parseNoiseSuppressionOption('false'), 'off')
})

test('parseNoiseSuppressionOption defaults to enhanced noise suppression', () => {
  assert.equal(parseNoiseSuppressionOption(null), 'rnnoise')
  assert.equal(parseNoiseSuppressionOption('unexpected'), 'rnnoise')
})

test('parseNoiseSuppressionOption passes through valid option values', () => {
  assert.equal(parseNoiseSuppressionOption('off'), 'off')
  assert.equal(parseNoiseSuppressionOption('webrtc'), 'webrtc')
  assert.equal(parseNoiseSuppressionOption('rnnoise'), 'rnnoise')
})

test('resolveNoiseSuppression maps option and capability to the WebRTC constraint', () => {
  assert.equal(resolveNoiseSuppression('off', false), false)
  assert.equal(resolveNoiseSuppression('off', true), false)
  assert.equal(resolveNoiseSuppression('webrtc', false), true)
  assert.equal(resolveNoiseSuppression('webrtc', true), true)
  assert.equal(resolveNoiseSuppression('rnnoise', false), true)
  assert.equal(resolveNoiseSuppression('rnnoise', true), false)
})
