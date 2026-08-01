<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LogOut, Settings } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { useVoiceStore } from '../stores/voice'

const props = defineProps<{ trigger: HTMLElement | null }>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  settings: []
  logout: []
}>()

const app = useAppStore()
const voice = useVoiceStore()
const toast = useToastStore()
const menu = ref<HTMLElement | null>(null)
const left = ref(8)
const top = ref(8)
const positioned = ref(false)

const statusLabel = () => (voice.ownPresenceStatus === 'online' ? '在线' : '离开')

function changeStatusSetting(mode: 'auto' | 'fixed_away') {
  void voice.setStatusSetting(mode).catch(() => {
    toast.showError('无法更新在线状态，请稍后重试')
  })
}

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
      class="account-menu motion-popover-static motion-origin-bottom"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      aria-label="用户账户操作"
      @keydown="handleKeyDown"
    >
      <header class="account-menu-summary">
        <UserAvatar :name="app.user!.displayName" :size="40" :status="voice.ownPresenceStatus" :user="app.user ?? undefined" />
        <span><strong>{{ app.user!.displayName }}</strong><small>@{{ app.user!.username }} · {{ statusLabel() }}</small></span>
      </header>
      <span class="account-menu-divider" role="separator" />
      <section class="account-menu-status" aria-label="在线状态">
        <h4>在线状态</h4>
        <button
          type="button"
          role="menuitem"
          :aria-checked="voice.statusSetting === 'auto'"
          :class="{ active: voice.statusSetting === 'auto' }"
          @click="changeStatusSetting('auto')"
        ><span class="status-option-dot online" aria-hidden="true" />自动模式</button>
        <button
          type="button"
          role="menuitem"
          :aria-checked="voice.statusSetting === 'fixed_away'"
          :class="{ active: voice.statusSetting === 'fixed_away' }"
          @click="changeStatusSetting('fixed_away')"
        ><span class="status-option-dot away" aria-hidden="true" />固定离开</button>
        <p class="account-menu-status-note">在线状态根据本机语音活动自动判断，仅用于状态显示</p>
      </section>
      <span class="account-menu-divider" role="separator" />
      <button type="button" role="menuitem" @click="emit('settings')"><Settings :size="17" />用户设置</button>
      <span class="account-menu-divider" role="separator" />
      <button class="danger" type="button" role="menuitem" @click="emit('logout')"><LogOut :size="17" />退出登录</button>
    </nav>
  </Teleport>
</template>
