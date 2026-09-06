import assert from 'node:assert/strict'
import test from 'node:test'
import { bindCaptureTrackEnded } from '../src/audio/SpeechDetectionEngine.ts'

class FakeTrack extends EventTarget {
  stopSelf = false

  stop() {
    this.stopSelf = true
    this.dispatchEvent(new Event('ended'))
  }

  endExternally() {
    this.dispatchEvent(new Event('ended'))
  }
}

test('unexpected capture track ended notifies', () => {
  const track = new FakeTrack()
  let notified = 0
  let selfStopping = false
  bindCaptureTrackEnded(track, {
    onEnded: () => {
      notified += 1
    },
    isSelfStop: () => selfStopping,
  })

  track.endExternally()
  assert.equal(notified, 1)
})

test('self-stop ended from stop/restart path does not notify', () => {
  const track = new FakeTrack()
  let notified = 0
  let selfStopping = false
  bindCaptureTrackEnded(track, {
    onEnded: () => {
      notified += 1
    },
    isSelfStop: () => selfStopping,
  })

  selfStopping = true
  track.stop()
  selfStopping = false
  assert.equal(notified, 0)

  track.endExternally()
  assert.equal(notified, 1)
})
