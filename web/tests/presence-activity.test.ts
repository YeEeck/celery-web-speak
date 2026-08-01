import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PresenceActivityTracker,
  PRESENCE_AWAY_AFTER_MS,
  PRESENCE_SPEECH_CONFIRM_MS,
} from '../src/stores/presence-activity.ts'

interface FakeClock {
  now: number
  timers: Map<number, { at: number; callback: () => void }>
  nextHandle: number
}

function makeClock() {
  const clock: FakeClock = { now: 0, timers: new Map(), nextHandle: 1 }
  return clock
}

function makeTracker(clock: FakeClock) {
  return new PresenceActivityTracker({
    now: () => clock.now,
    schedule: (delayMs, callback) => {
      const handle = clock.nextHandle++
      clock.timers.set(handle, { at: clock.now + delayMs, callback })
      return handle
    },
    clear: (handle) => {
      clock.timers.delete(handle)
    },
  })
}

function advance(clock: FakeClock, ms: number) {
  clock.now += ms
  for (const [handle, timer] of [...clock.timers]) {
    if (timer.at <= clock.now) {
      clock.timers.delete(handle)
      timer.callback()
    }
  }
}

function confirmSpeech(tracker: PresenceActivityTracker, frames: number) {
  for (let i = 0; i < frames; i += 1) tracker.onSpeechFrame(true, 20)
}

test('starts online and enters away after 10 minutes without speech', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS - 1)
  assert.equal(tracker.value, 'online')

  advance(clock, 1)
  assert.equal(tracker.value, 'away')
})

test('single short noises never confirm presence and do not reset the timer', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  confirmSpeech(tracker, 10)
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')
})

test('confirmed speech resets the away timer', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  advance(clock, PRESENCE_AWAY_AFTER_MS - 5_000)
  confirmSpeech(tracker, Math.ceil(PRESENCE_SPEECH_CONFIRM_MS / 20))
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS - 1)
  assert.equal(tracker.value, 'online')
  advance(clock, 1)
  assert.equal(tracker.value, 'away')
})

test('interrupted speech does not confirm until the utterance is continuous', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  confirmSpeech(tracker, 20)
  tracker.onSpeechFrame(false, 20)
  confirmSpeech(tracker, 20)
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')
})

test('confirmed speech returns from away to online immediately', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')

  confirmSpeech(tracker, Math.ceil(PRESENCE_SPEECH_CONFIRM_MS / 20))
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS - 1)
  assert.equal(tracker.value, 'online')
  advance(clock, 1)
  assert.equal(tracker.value, 'away')
})

test('reset restarts evaluation from online', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')

  tracker.reset()
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')
})

test('non-finite frame durations are ignored', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  tracker.onSpeechFrame(true, Number.NaN)
  tracker.onSpeechFrame(true, 0)
  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')
})
