import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface PokePromptItem {
  id: number
  actorUserId: number
  displayName: string
}

const MAX_VISIBLE = 3
const DISMISS_MS = 4_000

export function upsertPokePrompt(
  current: readonly PokePromptItem[],
  incoming: { actorUserId: number; displayName: string },
  nextId: number,
): PokePromptItem[] {
  const next: PokePromptItem[] = [{ id: nextId, actorUserId: incoming.actorUserId, displayName: incoming.displayName }]
  for (const item of current) {
    if (item.actorUserId === incoming.actorUserId) continue
    next.push(item)
  }
  if (next.length > MAX_VISIBLE) next.length = MAX_VISIBLE
  return next
}

export const usePokePromptStore = defineStore('pokePrompt', () => {
  const prompts = ref<PokePromptItem[]>([])
  let seq = 0
  const timers = new Map<number, number>()

  function clearTimer(id: number) {
    const handle = timers.get(id)
    if (handle === undefined) return
    window.clearTimeout(handle)
    timers.delete(id)
  }

  function dismiss(id: number) {
    clearTimer(id)
    const index = prompts.value.findIndex((item) => item.id === id)
    if (index !== -1) prompts.value.splice(index, 1)
  }

  function push(actorUserId: number, displayName: string) {
    const existing = prompts.value.find((item) => item.actorUserId === actorUserId)
    if (existing) clearTimer(existing.id)
    const id = ++seq
    prompts.value = upsertPokePrompt(prompts.value, { actorUserId, displayName }, id)
    timers.set(id, window.setTimeout(() => dismiss(id), DISMISS_MS))
  }

  return { prompts, push, dismiss }
})
