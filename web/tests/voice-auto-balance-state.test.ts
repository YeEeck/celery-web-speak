// 自动音量平衡——开关状态测试（seam 3）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTO_VOICE_BALANCE_KEY, getSavedAutoVoiceBalance, saveAutoVoiceBalance } from '../src/stores/voice-auto-balance-state.ts'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

test('默认关闭：无值返回 false', () => {
  assert.equal(getSavedAutoVoiceBalance(new MemoryStorage()), false)
})

test('非布尔值视为关闭', () => {
  const storage = new MemoryStorage()
  storage.setItem(AUTO_VOICE_BALANCE_KEY, 'garbage')
  assert.equal(getSavedAutoVoiceBalance(storage), false)
})

test('开启持久化写入，关闭持久化删除', () => {
  const storage = new MemoryStorage()
  saveAutoVoiceBalance(storage, true)
  assert.equal(storage.getItem(AUTO_VOICE_BALANCE_KEY), 'true')
  assert.equal(getSavedAutoVoiceBalance(storage), true)
  saveAutoVoiceBalance(storage, false)
  assert.equal(storage.getItem(AUTO_VOICE_BALANCE_KEY), null)
  assert.equal(getSavedAutoVoiceBalance(storage), false)
})
