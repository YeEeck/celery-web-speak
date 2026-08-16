// 语音通话 WS 信令与终态归类的单一 module（ADR-0033）。它拥有 call_* 事件
// 的 payload 形状、终态原因白名单、侧别判定与文案投影；不依赖 Vue / Pinia /
// LiveKit，无副作用。voice-call 只消费这里产出的 typed signal。
export type CallStatus = 'idle' | 'outgoing' | 'ringing' | 'active'
export type CallEndReason = 'busy' | 'unavailable' | 'unreachable' | 'rejected' | 'canceled' | 'timeout' | 'ended' | 'disconnected'
export type CallSignalType = 'call_invite' | 'call_accept' | 'call_busy' | 'call_unavailable' | 'call_unreachable' | 'call_reject' | 'call_cancel' | 'call_timeout' | 'call_end'
export type CallTerminalSide = 'caller' | 'callee'

// 通话对方的最小渲染字段，取自后端信令的 peer 或发起来源（个人信息卡片成员）。
export interface CallPeer {
  userId: number
  username: string
  displayName: string
}

// 后端 CallSignal 的 typed shape：type 为白名单字面量联合，reason 在解析时
// 已归一（非终态为 null），后端 state 字段不被前端消费、不进入 interface。
export interface CallSignal {
  type: CallSignalType
  callId: string
  peer: CallPeer
  reason: CallEndReason | null
}

export interface CallTerminalMessage {
  message: string
  type: 'warning' | 'error'
}

const emptyCallPeer: CallPeer = { userId: 0, username: '', displayName: '' }

const callSignalTypes = new Set<CallSignalType>([
  'call_invite',
  'call_accept',
  'call_busy',
  'call_unavailable',
  'call_unreachable',
  'call_reject',
  'call_cancel',
  'call_timeout',
  'call_end',
])

const callEndReasons = new Set<CallEndReason>([
  'busy',
  'unavailable',
  'unreachable',
  'rejected',
  'canceled',
  'timeout',
  'ended',
  'disconnected',
])

const terminalReasonByType: Record<TerminalSignalType, CallEndReason> = {
  call_busy: 'busy',
  call_unavailable: 'unavailable',
  call_unreachable: 'unreachable',
  call_reject: 'rejected',
  call_cancel: 'canceled',
  call_timeout: 'timeout',
  call_end: 'ended',
}

type TerminalSignalType = Exclude<CallSignalType, 'call_invite' | 'call_accept'>

function isCallSignalType(type: string): type is CallSignalType {
  return callSignalTypes.has(type as CallSignalType)
}

function isTerminalSignalType(type: CallSignalType): type is TerminalSignalType {
  return type !== 'call_invite' && type !== 'call_accept'
}

function isCallEndReason(reason: unknown): reason is CallEndReason {
  return typeof reason === 'string' && callEndReasons.has(reason as CallEndReason)
}

function normalizeCallId(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

// 已知终态事件缺失或未知 reason 时按 event type 回退（ADR-0033 决策 5）。
function normalizeSignalReason(type: CallSignalType, reason: unknown): CallEndReason | null {
  if (!isTerminalSignalType(type)) return null
  if (isCallEndReason(reason)) return reason
  return terminalReasonByType[type]
}

// HTTP 路径的终态 reason 归一（POST /api/calls 响应不走 WS）：未知值回退
// ended，与既有行为一致。
export function normalizeCallEndReason(reason: unknown): CallEndReason {
  return isCallEndReason(reason) ? reason : 'ended'
}

// 侧别由终态前一刻的状态判定：主叫经 outgoing→idle，被叫经 ringing→idle。
// active 与 idle 不携带侧别（ADR-0033）。
export function callTerminalSide(previousStatus: CallStatus | null): CallTerminalSide | null {
  if (previousStatus === 'outgoing') return 'caller'
  if (previousStatus === 'ringing') return 'callee'
  return null
}

// 终态 × 侧别 → 用户提示（toast）的纯函数映射。逐 (reason, side) 显式枚举：
// busy/rejected/unreachable 只发生主叫侧，canceled 只发生在被叫侧；未知组合
// 不在表中即 null，由调用方静默跳过。自己主动取消/挂断无提示。
export function callTerminalMessage(reason: CallEndReason, side: CallTerminalSide | null): CallTerminalMessage | null {
  switch (reason) {
    case 'busy':
      return side === 'caller' ? { message: '对方正忙', type: 'warning' } : null
    case 'unavailable':
      // 可被呼叫设置关闭或被呼叫屏蔽的统一隐式文案，不暴露具体原因。
      return side === 'caller' ? { message: '对方暂时无法接听', type: 'warning' } : null
    case 'unreachable':
      return side === 'caller' ? { message: '对方不在线', type: 'warning' } : null
    case 'rejected':
      return side === 'caller' ? { message: '对方已拒绝', type: 'warning' } : null
    case 'timeout':
      if (side === 'caller') return { message: '对方未接听', type: 'warning' }
      if (side === 'callee') return { message: '来电已超时', type: 'warning' }
      return null
    case 'canceled':
      return side === 'callee' ? { message: '对方已取消', type: 'warning' } : null
    case 'disconnected':
      // 本地终端掉线或对方掉线同文案，不分侧别。
      return { message: '通话已断开', type: 'error' }
    case 'ended':
      // 自己主动挂断：用户自知，不提示。
      return null
    default:
      return null
  }
}

// parseCallSignal 是 raw WS payload 与 typed signal 之间的 seam：未知 type、
// 缺失或空 callId 返回 null（忽略事件）；peer 缺失回退 emptyCallPeer。
export function parseCallSignal(type: string, data: unknown): CallSignal | null {
  if (!isCallSignalType(type)) return null
  const raw = (data ?? {}) as { callId?: unknown; peer?: CallPeer; reason?: unknown }
  const callId = normalizeCallId(raw.callId)
  if (callId === '') return null
  return {
    type,
    callId,
    peer: raw.peer ?? emptyCallPeer,
    reason: normalizeSignalReason(type, raw.reason),
  }
}
