import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLastNoiseSuppressionOption, parseNoiseSuppressionOption, resolveNoiseSuppression, toggleNoiseSuppressionOption } from '../src/stores/voice-utils.ts'

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

test('toggleNoiseSuppressionOption switches any non-off option to off', () => {
  assert.equal(toggleNoiseSuppressionOption('webrtc', 'rnnoise'), 'off')
  assert.equal(toggleNoiseSuppressionOption('rnnoise', 'webrtc'), 'off')
})

test('toggleNoiseSuppressionOption restores the last enabled option from off', () => {
  assert.equal(toggleNoiseSuppressionOption('off', 'webrtc'), 'webrtc')
  assert.equal(toggleNoiseSuppressionOption('off', 'rnnoise'), 'rnnoise')
})

test('toggleNoiseSuppressionOption falls back to the default when no last option is recorded', () => {
  assert.equal(toggleNoiseSuppressionOption('off', null), 'rnnoise')
  assert.equal(toggleNoiseSuppressionOption('off', undefined), 'rnnoise')
})

test('toggleNoiseSuppressionOption ignores an off last option', () => {
  assert.equal(toggleNoiseSuppressionOption('off', 'off'), 'rnnoise')
})

test('parseLastNoiseSuppressionOption defaults when saved value is off, absent or invalid', () => {
  assert.equal(parseLastNoiseSuppressionOption(null), 'rnnoise')
  assert.equal(parseLastNoiseSuppressionOption('off'), 'rnnoise')
  assert.equal(parseLastNoiseSuppressionOption('unexpected'), 'rnnoise')
  assert.equal(parseLastNoiseSuppressionOption('webrtc'), 'webrtc')
  assert.equal(parseLastNoiseSuppressionOption('rnnoise'), 'rnnoise')
})
