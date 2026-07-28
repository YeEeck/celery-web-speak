<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LogOut, Settings } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'

const props = defineProps<{ trigger: HTMLElement | null }>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  settings: []
  logout: []
}>()

const app = useAppStore()
const menu = ref<HTMLElement | null>(null)
const left = ref(8)
const top = ref(8)
const positioned = ref(false)

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
  const menuBounds = menu.value?.getBoundingClientRect()
  const triggerBounds = props.trigger?.getBoundingClientRect()
  if (!menuBounds || !triggerBounds) return
  const margin = 8
  left.value = Math.min(Math.max(margin, triggerBounds.left + 8), window.innerWidth - menuBounds.width - margin)
  top.value = Math.max(margin, triggerBounds.top - menuBounds.height - 8)
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
      id="account-menu"
      ref="menu"
      class="account-menu"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      aria-label="用户账户操作"
      @keydown="handleKeyDown"
    >
      <header class="account-menu-summary">
        <UserAvatar :name="app.user!.displayName" :size="40" :online="true" :user="app.user ?? undefined" />
        <span><strong>{{ app.user!.displayName }}</strong><small>@{{ app.user!.username }} · 在线</small></span>
      </header>
      <span class="account-menu-divider" role="separator" />
      <button type="button" role="menuitem" @click="emit('settings')"><Settings :size="17" />用户设置</button>
      <span class="account-menu-divider" role="separator" />
      <button class="danger" type="button" role="menuitem" @click="emit('logout')"><LogOut :size="17" />退出登录</button>
    </nav>
  </Teleport>
</template>
