import assert from 'node:assert/strict'
import test from 'node:test'
import { initialOf, rowOpacityPercent } from '../src/overlay/overlay-utils.ts'
import type { VoiceOverlayConfig } from '../src/audio/voiceOverlayBridge.ts'

const config: VoiceOverlayConfig = {
  scalePercent: 100,
  positionXPercent: 9,
  positionYPercent: 50,
  speakingOpacityPercent: 80,
  silentOpacityPercent: 40,
}

test('overlay utils: 头像首字母大写且与 Web UI 规则一致', () => {
  assert.equal(initialOf('alice'), 'A')
  assert.equal(initialOf('张三'), '张')
  assert.equal(initialOf('  bob  '), 'B')
  assert.equal(initialOf(''), '?')
  assert.equal(initialOf('😀x'), '😀')
})

test('overlay utils: 行不透明度按说话状态取对应档位', () => {
  assert.equal(rowOpacityPercent(config, true), 80)
  assert.equal(rowOpacityPercent(config, false), 40)
})
