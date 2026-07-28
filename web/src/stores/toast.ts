import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ToastType = 'success' | 'error' | 'warning'

export interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 2_000,
  warning: 4_000,
  error: 6_000,
}

const MAX_VISIBLE = 3

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastItem[]>([])
  let seq = 0
  const timers = new Map<number, number>()
  const dueAt = new Map<number, number>()
  const remaining = new Map<number, number>()
  const paused = new Set<number>()

  function clearTimer(id: number) {
    const handle = timers.get(id)
    if (handle !== undefined) {
      window.clearTimeout(handle)
      timers.delete(id)
    }
  }

  function dismiss(id: number) {
    clearTimer(id)
    dueAt.delete(id)
    remaining.delete(id)
    paused.delete(id)
    const index = toasts.value.findIndex((item) => item.id === id)
    if (index !== -1) toasts.value.splice(index, 1)
  }

  function schedule(id: number, ms: number) {
    clearTimer(id)
    dueAt.set(id, Date.now() + ms)
    remaining.set(id, ms)
    const handle = window.setTimeout(() => dismiss(id), ms)
    timers.set(id, handle)
  }

  function show(message: string, type: ToastType = 'success', duration?: number): number {
    const id = ++seq
    while (toasts.value.length >= MAX_VISIBLE) {
      const oldest = toasts.value[0]
      if (oldest) dismiss(oldest.id)
      else break
    }
    toasts.value.push({ id, message, type })
    schedule(id, duration ?? DEFAULT_DURATION[type])
    return id
  }

  function showSuccess(message: string, duration?: number) {
    return show(message, 'success', duration)
  }

  function showWarning(message: string, duration?: number) {
    return show(message, 'warning', duration)
  }

  function showError(message: string, duration?: number) {
    return show(message, 'error', duration)
  }

  function pause(id: number) {
    if (paused.has(id)) return
    const handle = timers.get(id)
    if (handle === undefined) return
    paused.add(id)
    window.clearTimeout(handle)
    timers.delete(id)
    const left = (dueAt.get(id) ?? 0) - Date.now()
    remaining.set(id, Math.max(left, 0))
  }

  function resume(id: number) {
    if (!paused.has(id)) return
    paused.delete(id)
    const left = remaining.get(id) ?? 0
    if (left <= 0) {
      dismiss(id)
      return
    }
    dueAt.set(id, Date.now() + left)
    const handle = window.setTimeout(() => dismiss(id), left)
    timers.set(id, handle)
  }

  async function runAction(action: () => Promise<void>, successMessage?: string): Promise<void> {
    try {
      await action()
      if (successMessage) show(successMessage, 'success')
    } catch (error) {
      showError(error instanceof Error ? error.message : '操作失败')
    }
  }

  return { toasts, show, showSuccess, showWarning, showError, dismiss, pause, resume, runAction }
})