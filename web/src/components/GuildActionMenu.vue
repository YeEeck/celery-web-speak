<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Gauge, LogOut, ServerCog } from '@lucide/vue'
import type { GuildSummary } from '../types'

const props = defineProps<{
  guild: GuildSummary
  isPlatformAdmin: boolean
  x: number
  y: number
  align: 'start' | 'end'
  trigger: HTMLElement | null
}>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  manage: [guild: GuildSummary]
  platform: [guild: GuildSummary]
  leave: [guild: GuildSummary]
}>()

const menu = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const positioned = ref(false)
const canManage = computed(() => props.guild.joined && (props.guild.role === 'owner' || props.guild.role === 'admin'))
const canLeave = computed(() => props.guild.joined && props.guild.role !== 'owner')
const hasPrimaryAction = computed(() => canManage.value || props.isPlatformAdmin)

function items() {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
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
  const proposedLeft = props.align === 'end' ? props.x - bounds.width : props.x
  left.value = Math.min(Math.max(margin, proposedLeft), window.innerWidth - bounds.width - margin)
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
      class="server-action-menu"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      :aria-label="`${guild.name}的服务器操作`"
      @keydown="handleKeyDown"
    >
      <button v-if="canManage" type="button" role="menuitem" @click="emit('manage', guild)"><Gauge :size="17" />管理控制台</button>
      <button v-if="isPlatformAdmin" type="button" role="menuitem" @click="emit('platform', guild)"><ServerCog :size="17" />平台服务器管理</button>
      <span v-if="canLeave && hasPrimaryAction" class="server-action-divider" role="separator" />
      <button v-if="canLeave" class="danger" type="button" role="menuitem" @click="emit('leave', guild)"><LogOut :size="17" />离开服务器</button>
    </nav>
  </Teleport>
</template>
