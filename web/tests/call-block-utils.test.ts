import assert from 'node:assert/strict'
import test from 'node:test'
import { callBlockRemainingLabel } from '../src/utils/call-block.ts'

const base = new Date('2026-08-01T12:00:00Z').getTime()
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString()

test('剩余不足 1 小时按分钟展示', () => {
  assert.equal(callBlockRemainingLabel(at(30), base), '30 分钟后解除')
})

test('剩余不足 24 小时按小时向上取整展示', () => {
  assert.equal(callBlockRemainingLabel(at(90), base), '2 小时后解除')
  assert.equal(callBlockRemainingLabel(at(120), base), '2 小时后解除')
})

test('剩余超过 24 小时按天向上取整展示', () => {
  assert.equal(callBlockRemainingLabel(at(60 * 25), base), '2 天后解除')
})

test('空到期时间返回空串', () => {
  assert.equal(callBlockRemainingLabel(undefined, base), '')
})

test('已到期返回已到期', () => {
  assert.equal(callBlockRemainingLabel(at(-1), base), '已到期')
})
