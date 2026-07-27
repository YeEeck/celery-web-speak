import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MUTED_SPEAKING_ARM_DELAY_MS,
  MUTED_SPEAKING_COOLDOWN_MS,
  MUTED_SPEAKING_REARM_MS,
  MUTED_SPEAKING_TRIGGER_MS,
  MutedSpeakingReminderState,
} from '../src/audio/MutedSpeakingReminderState.ts'

const FRAME_MS = 20

function processFor(state: MutedSpeakingReminderState, speaking: boolean, durationMs: number) {
  let reminders = 0
  for (let elapsed = 0; elapsed < durationMs; elapsed += FRAME_MS) {
    if (state.process(speaking, FRAME_MS)) reminders += 1
  }
  return reminders
}

test('waits for the arm delay and continuous speech threshold', () => {
  const state = new MutedSpeakingReminderState()

  assert.equal(processFor(state, true, MUTED_SPEAKING_ARM_DELAY_MS), 0)
  assert.equal(processFor(state, true, MUTED_SPEAKING_TRIGGER_MS - FRAME_MS), 0)
  assert.equal(processFor(state, true, FRAME_MS), 1)
})

test('reminds only once during one continuous utterance', () => {
  const state = new MutedSpeakingReminderState()

  assert.equal(processFor(state, true, MUTED_SPEAKING_ARM_DELAY_MS + MUTED_SPEAKING_TRIGGER_MS), 1)
  assert.equal(processFor(state, true, MUTED_SPEAKING_COOLDOWN_MS * 2), 0)
})

test('requires the full silence interval before rearming', () => {
  const state = new MutedSpeakingReminderState()

  assert.equal(processFor(state, true, MUTED_SPEAKING_ARM_DELAY_MS + MUTED_SPEAKING_TRIGGER_MS), 1)
  assert.equal(processFor(state, false, MUTED_SPEAKING_REARM_MS - FRAME_MS), 0)
  assert.equal(processFor(state, true, MUTED_SPEAKING_COOLDOWN_MS), 0)
})

test('allows a rearmed utterance only after the cooldown', () => {
  const state = new MutedSpeakingReminderState()

  assert.equal(processFor(state, true, MUTED_SPEAKING_ARM_DELAY_MS + MUTED_SPEAKING_TRIGGER_MS), 1)
  assert.equal(processFor(state, false, MUTED_SPEAKING_REARM_MS), 0)
  assert.equal(processFor(state, true, MUTED_SPEAKING_TRIGGER_MS), 0)
  assert.equal(processFor(state, true, MUTED_SPEAKING_COOLDOWN_MS), 1)
})

test('a new state clears the previous session cooldown', () => {
  const first = new MutedSpeakingReminderState()
  assert.equal(processFor(first, true, MUTED_SPEAKING_ARM_DELAY_MS + MUTED_SPEAKING_TRIGGER_MS), 1)

  const next = new MutedSpeakingReminderState()
  assert.equal(processFor(next, true, MUTED_SPEAKING_ARM_DELAY_MS + MUTED_SPEAKING_TRIGGER_MS), 1)
})
