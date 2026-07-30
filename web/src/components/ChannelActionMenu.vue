<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { CheckCheck, Clipboard, Settings } from '@lucide/vue'
import type { Channel } from '../types'

const props = defineProps<{
  channel: Channel
  unreadCount: number
  canManage: boolean
  x: number
  y: number
  trigger: HTMLElement | null
}>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  copy: [channel: Channel]
  markRead: [channel: Channel]
  edit: [channel: Channel]
}>()

const menu = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const positioned = ref(false)
const canMarkRead = computed(() => props.channel.type === 'text' && props.unreadCount > 0)

function items() {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
}

function focusAt(index: number) {
  const available = items()
  if (!available.length) return
  available[(index + available.length) % available.length]?.focus()
}

function handleKeyDown(event: KeyboardEvent) {
  const available = items()
  const current = available.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusAt(current + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusAt(current - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusAt(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusAt(available.length - 1)
  } else if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    emit('close', true)
  }
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (menu.value?.contains(target) || props.trigger?.contains(target)) return
  emit('close', false)
}

function closeOnViewportChange() {
  emit('close', false)
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('resize', closeOnViewportChange)
  window.addEventListener('scroll', closeOnViewportChange, true)
  await nextTick()
  const bounds = menu.value?.getBoundingClientRect()
  if (!bounds) return
  const margin = 8
  left.value = Math.min(Math.max(margin, props.x), window.innerWidth - bounds.width - margin)
  top.value = Math.min(Math.max(margin, props.y), window.innerHeight - bounds.height - margin)
  positioned.value = true
  await nextTick()
  focusAt(0)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('resize', closeOnViewportChange)
  window.removeEventListener('scroll', closeOnViewportChange, true)
})
</script>

<template>
  <Teleport to="body">
    <nav
      ref="menu"
      class="channel-action-menu motion-popover-static"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      :aria-label="`${channel.name}的频道操作`"
      @keydown="handleKeyDown"
    >
      <button type="button" role="menuitem" @click="emit('copy', channel)"><Clipboard :size="17" />复制频道名称</button>
      <button v-if="channel.type === 'text'" type="button" role="menuitem" :disabled="!canMarkRead" @click="emit('markRead', channel)"><CheckCheck :size="17" />标记为已读</button>
      <span v-if="canManage" class="channel-action-divider" role="separator" />
      <button v-if="canManage" type="button" role="menuitem" @click="emit('edit', channel)"><Settings :size="17" />编辑频道</button>
    </nav>
  </Teleport>
</template>
