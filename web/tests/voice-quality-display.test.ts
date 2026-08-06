import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionQuality } from 'livekit-client'
import { voiceQualityDisplay } from '../src/stores/voice-utils.ts'

test('voiceQualityDisplay maps excellent to three lit bars', () => {
  assert.deepEqual(voiceQualityDisplay(ConnectionQuality.Excellent), { bars: 3, title: '连接质量：极佳', unknown: false })
})

test('voiceQualityDisplay maps good to two lit bars', () => {
  assert.deepEqual(voiceQualityDisplay(ConnectionQuality.Good), { bars: 2, title: '连接质量：良好', unknown: false })
})

test('voiceQualityDisplay maps poor to one lit bar', () => {
  assert.deepEqual(voiceQualityDisplay(ConnectionQuality.Poor), { bars: 1, title: '连接质量：较差', unknown: false })
})

test('voiceQualityDisplay maps lost to zero bars and stays a measured quality', () => {
  assert.deepEqual(voiceQualityDisplay(ConnectionQuality.Lost), { bars: 0, title: '连接质量：连接丢失', unknown: false })
})

test('voiceQualityDisplay maps unknown to a neutral placeholder, distinct from lost', () => {
  assert.deepEqual(voiceQualityDisplay(ConnectionQuality.Unknown), { bars: 0, title: '连接质量未知', unknown: true })
})
