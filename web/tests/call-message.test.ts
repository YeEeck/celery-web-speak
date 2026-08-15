import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callTerminalMessage,
  callTerminalSide,
} from '../src/stores/call-message.ts'

// ticket 06: 终态 × 侧别 → 用户提示文案的纯函数映射。
// 语义来源：spec 04 转移表 / spec 08 三形态浮层 / CONTEXT.md 语音通话词条。

test('caller busy / unreachable / rejected / timeout 各有专属文案', () => {
  assert.deepEqual(callTerminalMessage('busy', 'caller'), { message: '对方正忙', type: 'warning' })
  assert.deepEqual(callTerminalMessage('unreachable', 'caller'), { message: '对方不在线', type: 'warning' })
  assert.deepEqual(callTerminalMessage('rejected', 'caller'), { message: '对方已拒绝', type: 'warning' })
  assert.deepEqual(callTerminalMessage('timeout', 'caller'), { message: '对方未接听', type: 'warning' })
})

test('unavailable 主叫统一看到「对方暂时无法接听」，被叫侧静默', () => {
  assert.deepEqual(callTerminalMessage('unavailable', 'caller'), { message: '对方暂时无法接听', type: 'warning' })
  assert.equal(callTerminalMessage('unavailable', 'callee'), null)
  assert.equal(callTerminalMessage('unavailable', null), null)
})

test('callee cancel / timeout 各有专属文案', () => {
  assert.deepEqual(callTerminalMessage('canceled', 'callee'), { message: '对方已取消', type: 'warning' })
  assert.deepEqual(callTerminalMessage('timeout', 'callee'), { message: '来电已超时', type: 'warning' })
})

test('disconnected 双方共用「通话已断开」且为 error，不区分侧别', () => {
  assert.deepEqual(callTerminalMessage('disconnected', 'caller'), { message: '通话已断开', type: 'error' })
  assert.deepEqual(callTerminalMessage('disconnected', 'callee'), { message: '通话已断开', type: 'error' })
})

test('自己主动取消/挂断不提示', () => {
  // 主叫自己取消（canceled）与主动挂断（ended）不提示——用户自知。
  assert.equal(callTerminalMessage('canceled', 'caller'), null)
  assert.equal(callTerminalMessage('ended', 'caller'), null)
  assert.equal(callTerminalMessage('ended', 'callee'), null)
})

test('不在对应侧状态机下的终态不产生提示（防御越界组合）', () => {
  // busy/rejected/unreachable 只会发向主叫；canceled 只会发向被叫。
  assert.equal(callTerminalMessage('busy', 'callee'), null)
  assert.equal(callTerminalMessage('rejected', 'callee'), null)
  assert.equal(callTerminalMessage('unreachable', 'callee'), null)
  assert.equal(callTerminalMessage('canceled', 'caller'), null)
})

test('侧别由终态前的状态判定：outgoing=主叫，ringing=被叫，active/idle=无别', () => {
  // 主叫路径 outgoing→idle（busy/rejected/timeout），被叫路径 ringing→idle（cancel/timeout）。
  assert.equal(callTerminalSide('outgoing'), 'caller')
  assert.equal(callTerminalSide('ringing'), 'callee')
  // 通话中（active）掉线在 reason=disconnected 时才提示，侧别无关；idle 无终态。
  assert.equal(callTerminalSide('active'), null)
  assert.equal(callTerminalSide('idle'), null)
})

test('null 侧别（active/idle）不产生侧别敏感提示', () => {
  // 侧别敏感原因在无侧别时静默跳过（防御 active 阶段收到 timeout/canceled 的竞态）。
  assert.equal(callTerminalMessage('busy', null), null)
  assert.equal(callTerminalMessage('timeout', null), null)
  assert.equal(callTerminalMessage('canceled', null), null)
  // disconnected 侧别无关，null 侧别下仍提示。
  assert.deepEqual(callTerminalMessage('disconnected', null), { message: '通话已断开', type: 'error' })
  assert.equal(callTerminalMessage('ended', null), null)
})
