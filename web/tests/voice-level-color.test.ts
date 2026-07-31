import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceLevelColorProgressPercent } from '../src/utils/voice-level.ts'

test('level color starts at the theme color and reaches red at level 100', () => {
  assert.equal(voiceLevelColorProgressPercent(0), 0)
  assert.equal(voiceLevelColorProgressPercent(50), 50)
  assert.equal(voiceLevelColorProgressPercent(100), 100)
})

test('level color progress clamps outside the supported range', () => {
  assert.equal(voiceLevelColorProgressPercent(-10), 0)
  assert.equal(voiceLevelColorProgressPercent(101), 100)
  assert.equal(voiceLevelColorProgressPercent(Number.POSITIVE_INFINITY), 100)
  assert.equal(voiceLevelColorProgressPercent(Number.NaN), 0)
})
