import assert from 'node:assert/strict'
import test from 'node:test'
import { callBlockRemainingLabel, formatCallBlockCountdown } from '../src/utils/call-block.ts'

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

test('倒计时满 24 小时显示 24:00:00', () => {
  assert.equal(formatCallBlockCountdown(24 * 3600 * 1000), '24:00:00')
})

test('倒计时小时不补零、分秒补零', () => {
  assert.equal(formatCallBlockCountdown(90 * 60 * 1000), '1:30:00')
  assert.equal(formatCallBlockCountdown(59 * 1000), '0:00:59')
})

test('倒计时按秒向上取整且不为负', () => {
  assert.equal(formatCallBlockCountdown(30_500), '0:00:31')
  assert.equal(formatCallBlockCountdown(0), '0:00:00')
  assert.equal(formatCallBlockCountdown(-5000), '0:00:00')
})
