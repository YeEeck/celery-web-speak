import assert from 'node:assert/strict'
import test from 'node:test'
import { SpeechDetectionEngine } from '../src/audio/SpeechDetectionEngine.ts'

test('ingestFrame reaches subscribers when the engine is not capturing', () => {
  const engine = new SpeechDetectionEngine({ onError: () => undefined })
  const frames: Array<{ speaking: boolean; ms: number }> = []
  engine.subscribe((speaking, ms) => frames.push({ speaking, ms }))
  engine.ingestFrame(true, 100)
  engine.ingestFrame(false, 100)
  assert.deepEqual(frames, [
    { speaking: true, ms: 100 },
    { speaking: false, ms: 100 },
  ])
})

test('stop releases capture but still forwards ingested frames', () => {
  const engine = new SpeechDetectionEngine({ onError: () => undefined })
  const frames: boolean[] = []
  engine.subscribe((speaking) => frames.push(speaking))
  engine.stop()
  engine.ingestFrame(true, 100)
  assert.deepEqual(frames, [true])
})
