import type { CallEndReason, CallStatus } from './voice-call.ts'

// ticket 06：终态 × 侧别 → 用户提示（toast）的纯函数映射。
// 语义来源：spec 04 转移表（终态原因）+ spec 08 三形态浮层（终态即关闭，无终态
// 形态）+ CONTEXT.md「语音通话」词条。文案措辞避免「对方…」用于自己主动取消/
// 挂断，只出现在对方主导的终态上。

export type CallTerminalSide = 'caller' | 'callee'

export interface CallTerminalMessage {
  message: string
  type: 'warning' | 'error'
}

// 逐 (reason, side) 显式枚举，而非推导：终态语义是互相约束的——busy/rejected/
// unreachable 只发生主叫侧，canceled 只发生在被叫侧；unknown 组合不在此表即 null，
// 由调用方静默跳过（防御越界组合，避免误报）。
// 侧别由「终态前一刻的状态」判定：主叫经 outgoing→idle，被叫经 ringing→idle。
// active 与 idle 不携带侧别（传 null）：通话中掉线仅在 reason=disconnected 提示，
// 侧别无关；侧别敏感原因（busy/timeout/canceled 等）在 null 侧别下同样静默跳过。
export function callTerminalSide(previousStatus: CallStatus | null): CallTerminalSide | null {
  if (previousStatus === 'outgoing') return 'caller'
  if (previousStatus === 'ringing') return 'callee'
  return null
}

export function callTerminalMessage(reason: CallEndReason, side: CallTerminalSide | null): CallTerminalMessage | null {
  switch (reason) {
    case 'busy':
      return side === 'caller' ? { message: '对方正忙', type: 'warning' } : null
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
      // 本地终端掉线或对方掉线（后端 call_end reason=disconnected）同文案，不分侧别。
      return { message: '通话已断开', type: 'error' }
    case 'ended':
      // 自己主动挂断：用户自知，不提示。
      return null
    default:
      return null
  }
}
