import assert from 'node:assert/strict'
import test from 'node:test'
import { SpeechFrameIngest } from '../src/audio/speechFrameIngest.ts'

test('setSpeaking(true) emits immediately and repeats until silenced', () => {
  const frames: Array<{ speaking: boolean; ms: number }> = []
  const ingest = new SpeechFrameIngest((speaking, ms) => frames.push({ speaking, ms }), 20)
  ingest.setSpeaking(true)
  ingest.setSpeaking(true)
  ingest.setSpeaking(false)
  ingest.stop()
  assert.deepEqual(frames[0], { speaking: true, ms: 20 })
  assert.equal(frames.at(-1)?.speaking, false)
  assert.ok(frames.filter((frame) => frame.speaking).length >= 1)
})
