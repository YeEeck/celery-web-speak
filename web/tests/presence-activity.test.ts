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
  const tracker = new PresenceActivityTracker({
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
  tracker.start()
  return tracker
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

  tracker.start()
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')
})

test('stopped tracker holds connection-alive semantics and ignores frames', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')

  tracker.stop()
  assert.equal(tracker.value, 'online')

  confirmSpeech(tracker, 100)
  advance(clock, PRESENCE_AWAY_AFTER_MS * 2)
  assert.equal(tracker.value, 'online')

  tracker.start()
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

test('ignored speech neither returns from away nor resets the away timer', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')

  tracker.setSpeechIgnored(true)
  confirmSpeech(tracker, 100)
  assert.equal(tracker.value, 'away')

  advance(clock, PRESENCE_AWAY_AFTER_MS * 2)
  assert.equal(tracker.value, 'away')
})

test('ignored speech does not reset the away timer while online', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  advance(clock, PRESENCE_AWAY_AFTER_MS - 5_000)
  tracker.setSpeechIgnored(true)
  confirmSpeech(tracker, 100)

  advance(clock, 5_000)
  assert.equal(tracker.value, 'away')
})

test('mute boundary clears partial utterance: pre-mute and post-unmute speech never merge', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  confirmSpeech(tracker, 25) // 静音前 500ms，未构成确认
  advance(clock, 60_000)
  tracker.setSpeechIgnored(true)
  advance(clock, 60_000)
  tracker.setSpeechIgnored(false)
  confirmSpeech(tracker, 5) // 解除静音后 100ms

  // 若静音前后拼接成 600ms，解除静音后即确认并重新武装计时；边界清空后
  // 无确认，原计时（静音前武装）走到整点仍进入离开。
  advance(clock, PRESENCE_AWAY_AFTER_MS - 60_000)
  assert.equal(tracker.value, 'away')
})

test('setSpeechIgnored is idempotent and unmute resumes speech confirmation', () => {
  const clock = makeClock()
  const tracker = makeTracker(clock)

  tracker.setSpeechIgnored(true)
  tracker.setSpeechIgnored(true)
  confirmSpeech(tracker, 100)
  advance(clock, PRESENCE_AWAY_AFTER_MS)
  assert.equal(tracker.value, 'away')

  tracker.setSpeechIgnored(false)
  confirmSpeech(tracker, Math.ceil(PRESENCE_SPEECH_CONFIRM_MS / 20))
  assert.equal(tracker.value, 'online')

  advance(clock, PRESENCE_AWAY_AFTER_MS - 1)
  assert.equal(tracker.value, 'online')
  advance(clock, 1)
  assert.equal(tracker.value, 'away')
})
