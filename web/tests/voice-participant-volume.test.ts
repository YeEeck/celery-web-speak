import assert from 'node:assert/strict'
import test from 'node:test'
import { composeMicrophoneGain } from '../src/stores/voice-participant-volume.ts'
import { setParticipantTrackVolume, toggleParticipantTrackMuted, type ParticipantAudioState } from '../src/stores/voice-participant-volume-state.ts'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

function participant(): ParticipantAudioState {
  return {
    microphoneVolume: 1,
    backgroundAudioVolume: 1,
    microphoneMuted: false,
    backgroundAudioMuted: false,
  }
}

test('changing or resetting volume keeps microphone sound disabled until explicitly restored', () => {
  const storage = new MemoryStorage()
  const target = participant()

  toggleParticipantTrackMuted(storage, 12, target, 'microphone')
  setParticipantTrackVolume(storage, 12, target, 'microphone', 2.4)
  assert.equal(target.microphoneMuted, true)
  assert.equal(target.microphoneVolume, 2.4)
  assert.equal(storage.getItem('cws.muted.12'), 'true')
  assert.equal(storage.getItem('cws.volume.12'), '2.4')

  setParticipantTrackVolume(storage, 12, target, 'microphone', 1)
  assert.equal(target.microphoneMuted, true)
  assert.equal(target.microphoneVolume, 1)
  assert.equal(storage.getItem('cws.muted.12'), 'true')

  toggleParticipantTrackMuted(storage, 12, target, 'microphone')
  assert.equal(target.microphoneMuted, false)
  assert.equal(target.microphoneVolume, 1)
})

test('changing or resetting volume keeps background audio disabled until explicitly restored', () => {
  const storage = new MemoryStorage()
  const target = participant()

  toggleParticipantTrackMuted(storage, 12, target, 'backgroundAudio')
  setParticipantTrackVolume(storage, 12, target, 'backgroundAudio', 1.75)
  assert.equal(target.backgroundAudioMuted, true)
  assert.equal(target.backgroundAudioVolume, 1.75)
  assert.equal(storage.getItem('cws.backgroundAudioMuted.12'), 'true')
  assert.equal(storage.getItem('cws.backgroundAudioVolume.12'), '1.75')

  setParticipantTrackVolume(storage, 12, target, 'backgroundAudio', 1)
  assert.equal(target.backgroundAudioMuted, true)
  assert.equal(target.backgroundAudioVolume, 1)
  assert.equal(storage.getItem('cws.backgroundAudioMuted.12'), 'true')

  toggleParticipantTrackMuted(storage, 12, target, 'backgroundAudio')
  assert.equal(target.backgroundAudioMuted, false)
  assert.equal(target.backgroundAudioVolume, 1)
})

test('composeMicrophoneGain：静音/聋直接归零', () => {
  assert.equal(composeMicrophoneGain({ manualVolume: 1, outputVolume: 1, balanceGain: 2, muted: true, deafened: false }), 0)
  assert.equal(composeMicrophoneGain({ manualVolume: 1, outputVolume: 1, balanceGain: 2, muted: false, deafened: true }), 0)
})

test('composeMicrophoneGain：平衡系数乘入，关闭时（1）行为不变', () => {
  assert.equal(composeMicrophoneGain({ manualVolume: 1, outputVolume: 1, balanceGain: 2, muted: false, deafened: false }), 2)
  assert.equal(composeMicrophoneGain({ manualVolume: 1, outputVolume: 1, balanceGain: 1, muted: false, deafened: false }), 1)
})

test('composeMicrophoneGain：手动偏置与全局音量保留', () => {
  assert.equal(composeMicrophoneGain({ manualVolume: 0.3, outputVolume: 1, balanceGain: 1, muted: false, deafened: false }), 0.3)
  assert.equal(composeMicrophoneGain({ manualVolume: 1, outputVolume: 0.5, balanceGain: 1, muted: false, deafened: false }), 0.5)
  assert.ok(Math.abs(composeMicrophoneGain({ manualVolume: 0.3, outputVolume: 0.5, balanceGain: 2, muted: false, deafened: false }) - 0.3) < 1e-9)
})

test('composeMicrophoneGain：合成结果按最大音量钳制', () => {
  assert.equal(composeMicrophoneGain({ manualVolume: 3, outputVolume: 1, balanceGain: 2, muted: false, deafened: false }), 3)
})
