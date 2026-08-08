import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionQuality } from 'livekit-client'
import {
  backgroundAudioStatusLabel,
  microphoneStatusLabel,
  type VoiceParticipant,
} from '../src/stores/voice-utils.ts'

function participant(overrides: Partial<VoiceParticipant>): VoiceParticipant {
  return {
    identity: 'user-1',
    userId: 1,
    name: '测试',
    isLocal: false,
    isSpeaking: false,
    microphoneEnabled: true,
    backgroundAudioAvailable: false,
    backgroundAudioActive: false,
    deafened: false,
    quality: ConnectionQuality.Unknown,
    microphoneVolume: 1,
    backgroundAudioVolume: 1,
    microphoneMuted: false,
    backgroundAudioMuted: false,
    role: 'member',
    joinedAt: 0,
    ...overrides,
  }
}

// ADR-0030：本地静音以黄色图标替代对方自身状态色，每轨道最多一个状态图标。
test('microphoneStatusLabel 本地静音返回黄色文案（你已关闭此人的麦克风声音）', () => {
  assert.equal(microphoneStatusLabel(participant({ microphoneMuted: true })), '你已关闭此人的麦克风声音')
})

test('microphoneStatusLabel 对方自静音返回灰色文案（麦克风已静音）', () => {
  assert.equal(microphoneStatusLabel(participant({ microphoneEnabled: false })), '麦克风已静音')
})

test('microphoneStatusLabel 本地静音与对方自静音并存时本地静音优先', () => {
  assert.equal(microphoneStatusLabel(participant({ microphoneEnabled: false, microphoneMuted: true })), '你已关闭此人的麦克风声音')
})

test('microphoneStatusLabel 两者皆非返回 null（不显示图标）', () => {
  assert.equal(microphoneStatusLabel(participant({})), null)
})

test('backgroundAudioStatusLabel 本地静音返回黄色文案（你已关闭此人的背景音），压过亮起态', () => {
  assert.equal(backgroundAudioStatusLabel(participant({ backgroundAudioMuted: true, backgroundAudioActive: true })), '你已关闭此人的背景音')
  assert.equal(backgroundAudioStatusLabel(participant({ backgroundAudioMuted: true, backgroundAudioActive: false })), '你已关闭此人的背景音')
})

test('backgroundAudioStatusLabel 未本地静音时按真实声音区分亮起/无声音', () => {
  assert.equal(backgroundAudioStatusLabel(participant({ backgroundAudioActive: true })), '正在共享背景音')
  assert.equal(backgroundAudioStatusLabel(participant({ backgroundAudioActive: false })), '共享背景音（当前无声音）')
})
