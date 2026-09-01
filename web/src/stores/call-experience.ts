import { watch, type Ref } from 'vue'
import {
  callTerminalMessage,
  callTerminalSide,
  type CallEndReason,
  type CallStatus,
} from './call-signal.ts'

// 语音通话阶段变化时的副作用主人（ADR-0037）：频道作用域耳机静音、
// 通话提示音、终态 toast。voice-call 仍对频道无感知；call-signal 仍是纯解析。
export interface CallExperienceContext {
  readonly status: Ref<CallStatus>
  readonly endedReason: Ref<CallEndReason | null>
  setCallChannelDeafen(active: boolean): Promise<void>
  loop(occurrence: 'call-outgoing' | 'call-incoming'): void
  stopLoop(): void
  signal(occurrence: 'call-connected' | 'call-ended'): void
  showToast(message: string, type: 'warning' | 'error'): void
}

export function useCallExperience(ctx: CallExperienceContext): void {
  watch(() => ctx.status.value, (status, previous) => {
    void ctx.setCallChannelDeafen(status === 'outgoing' || status === 'active')

    if (status === 'outgoing') {
      ctx.loop('call-outgoing')
    } else if (status === 'ringing') {
      ctx.loop('call-incoming')
    } else if (status === 'active') {
      ctx.stopLoop()
      ctx.signal('call-connected')
    } else {
      ctx.stopLoop()
      if (previous === 'active') ctx.signal('call-ended')
    }

    if (status !== 'idle') return
    const reason = ctx.endedReason.value
    if (!reason) return
    const terminal = callTerminalMessage(reason, callTerminalSide(previous ?? null))
    if (terminal) ctx.showToast(terminal.message, terminal.type)
  })
}
