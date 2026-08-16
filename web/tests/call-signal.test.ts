import assert from 'node:assert/strict'
import test from 'node:test'
import { callTerminalMessage, callTerminalSide, normalizeCallEndReason, parseCallSignal } from '../src/stores/call-signal.ts'

test('callTerminalSide derives the side from the previous session status', () => {
  assert.equal(callTerminalSide('outgoing'), 'caller')
  assert.equal(callTerminalSide('ringing'), 'callee')
  assert.equal(callTerminalSide('active'), null)
  assert.equal(callTerminalSide('idle'), null)
  assert.equal(callTerminalSide(null), null)
})

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
  assert.equal(callTerminalMessage('canceled', 'caller'), null)
  assert.equal(callTerminalMessage('ended', 'caller'), null)
  assert.equal(callTerminalMessage('ended', 'callee'), null)
})

test('不在对应侧状态机下的终态不产生提示（防御越界组合）', () => {
  assert.equal(callTerminalMessage('busy', 'callee'), null)
  assert.equal(callTerminalMessage('rejected', 'callee'), null)
  assert.equal(callTerminalMessage('unreachable', 'callee'), null)
  assert.equal(callTerminalMessage('canceled', 'caller'), null)
})

test('null 侧别（active/idle）不产生侧别敏感提示', () => {
  assert.equal(callTerminalMessage('busy', null), null)
  assert.equal(callTerminalMessage('timeout', null), null)
  assert.equal(callTerminalMessage('canceled', null), null)
  assert.deepEqual(callTerminalMessage('disconnected', null), { message: '通话已断开', type: 'error' })
  assert.equal(callTerminalMessage('ended', null), null)
})

test('normalizeCallEndReason keeps whitelisted reasons and falls back to ended', () => {
  assert.equal(normalizeCallEndReason('busy'), 'busy')
  assert.equal(normalizeCallEndReason('unavailable'), 'unavailable')
  assert.equal(normalizeCallEndReason('unreachable'), 'unreachable')
  assert.equal(normalizeCallEndReason('rejected'), 'rejected')
  assert.equal(normalizeCallEndReason('canceled'), 'canceled')
  assert.equal(normalizeCallEndReason('timeout'), 'timeout')
  assert.equal(normalizeCallEndReason('ended'), 'ended')
  assert.equal(normalizeCallEndReason('disconnected'), 'disconnected')
  assert.equal(normalizeCallEndReason('unexpected'), 'ended')
  assert.equal(normalizeCallEndReason(undefined), 'ended')
})

test('parseCallSignal normalizes terminal reason from the event type when reason is missing or unknown', () => {
  const peer = { userId: 2, username: 'alice', displayName: '爱丽丝' }
  assert.deepEqual(
    parseCallSignal('call_busy', { callId: '100', peer, state: 'ended' }),
    { type: 'call_busy', callId: '100', peer, reason: 'busy' },
  )
  assert.deepEqual(
    parseCallSignal('call_reject', { callId: '100', peer, state: 'ended', reason: 'rejected' }),
    { type: 'call_reject', callId: '100', peer, reason: 'rejected' },
  )
  assert.deepEqual(
    parseCallSignal('call_end', { callId: '100', peer, state: 'ended', reason: 'unexpected' }),
    { type: 'call_end', callId: '100', peer, reason: 'ended' },
  )
})

test('parseCallSignal returns null for unknown types and missing callId, and falls back peer', () => {
  assert.equal(parseCallSignal('call_unknown', { callId: '100' }), null)
  assert.equal(parseCallSignal('call_invite', { callId: '' }), null)
  assert.equal(parseCallSignal('call_invite', { callId: undefined }), null)
  assert.equal(parseCallSignal('call_invite', null), null)
  assert.deepEqual(
    parseCallSignal('call_invite', { callId: '100' }),
    {
      type: 'call_invite',
      callId: '100',
      peer: { userId: 0, username: '', displayName: '' },
      reason: null,
    },
  )
})

test('parseCallSignal normalizes numeric and string callId and drops state', () => {
  assert.deepEqual(
    parseCallSignal('call_invite', {
      callId: 123,
      peer: { userId: 2, username: 'alice', displayName: '爱丽丝' },
      state: 'ringing',
    }),
    {
      type: 'call_invite',
      callId: '123',
      peer: { userId: 2, username: 'alice', displayName: '爱丽丝' },
      reason: null,
    },
  )
  assert.deepEqual(
    parseCallSignal('call_invite', {
      callId: '9007199254740993',
      peer: { userId: 2, username: 'alice', displayName: '爱丽丝' },
      state: 'ringing',
    }),
    {
      type: 'call_invite',
      callId: '9007199254740993',
      peer: { userId: 2, username: 'alice', displayName: '爱丽丝' },
      reason: null,
    },
  )
  assert.deepEqual(
    parseCallSignal('call_accept', {
      callId: '100',
      peer: { userId: 2, username: 'alice', displayName: '爱丽丝' },
      state: 'active',
    }),
    {
      type: 'call_accept',
      callId: '100',
      peer: { userId: 2, username: 'alice', displayName: '爱丽丝' },
      reason: null,
    },
  )
})
