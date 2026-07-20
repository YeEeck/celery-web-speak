<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Headphones, LoaderCircle, LogOut, Mic, MicOff, Settings, VolumeX } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'

defineEmits<{ settings: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const confirmLogout = ref(false)
const loggingOut = ref(false)
const logoutTrigger = ref<HTMLButtonElement | null>(null)
const logoutDialog = ref<HTMLElement | null>(null)
const cancelLogout = ref<HTMLButtonElement | null>(null)

const voiceStatus = computed(() => {
  if (!voice.joined) return '未连接语音'
  if (voice.status === 'reconnecting') return '语音重连中'
  if (voice.deafened) return '耳机已静音'
  return voice.muted ? '麦克风已静音' : '语音已连接'
})

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await voice.leave()
    await app.logout()
  } finally {
    loggingOut.value = false
  }
}

function toggleLogoutConfirm() {
  if (confirmLogout.value) {
    closeLogoutConfirm()
    return
  }
  confirmLogout.value = true
  nextTick(() => cancelLogout.value?.focus())
}

function closeLogoutConfirm(restoreFocus = true) {
  if (loggingOut.value) return
  confirmLogout.value = false
  if (restoreFocus) nextTick(() => logoutTrigger.value?.focus())
}

function handlePointerDown(event: PointerEvent) {
  if (!confirmLogout.value || loggingOut.value) return
  const target = event.target as Node
  if (logoutDialog.value?.contains(target) || logoutTrigger.value?.contains(target)) return
  closeLogoutConfirm(false)
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && confirmLogout.value) {
    event.preventDefault()
    closeLogoutConfirm()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown)
  document.addEventListener('keydown', handleKeyDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown)
  document.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <footer class="user-controls">
    <div class="current-user">
      <UserAvatar :name="app.user!.displayName" :size="34" :online="true" />
      <span><strong>{{ app.user!.displayName }}</strong><small>{{ voiceStatus }}</small></span>
    </div>
    <div class="control-buttons">
      <button
        class="icon-button"
        :class="{ danger: voice.muted || app.user!.voiceMuted }"
        :disabled="!voice.joined || app.user!.voiceMuted || voice.deafened"
        :title="voice.deafened ? '耳机静音中' : voice.muted ? '取消静音' : '麦克风静音'"
        @click="voice.toggleMute()"
      >
        <MicOff v-if="voice.muted || app.user!.voiceMuted" :size="18" /><Mic v-else :size="18" />
      </button>
      <button
        class="icon-button"
        :class="{ danger: voice.deafened }"
        :disabled="!voice.joined || voice.deafenChanging"
        :title="voice.deafened ? '取消耳机静音' : '耳机静音'"
        @click="voice.toggleDeafen()"
      >
        <VolumeX v-if="voice.deafened" :size="18" /><Headphones v-else :size="18" />
      </button>
      <button class="icon-button" title="用户设置" @click="$emit('settings')"><Settings :size="18" /></button>
      <button
        ref="logoutTrigger"
        class="icon-button"
        title="退出登录"
        :aria-expanded="confirmLogout"
        aria-controls="logout-confirm-dialog"
        @click="toggleLogoutConfirm"
      >
        <LogOut :size="18" />
      </button>
    </div>
    <div
      v-if="confirmLogout"
      id="logout-confirm-dialog"
      ref="logoutDialog"
      class="logout-confirm"
      role="alertdialog"
      aria-labelledby="logout-confirm-title"
    >
      <h3 id="logout-confirm-title">退出登录？</h3>
      <p v-if="voice.joined">退出后将断开当前语音连接。</p>
      <div class="logout-confirm-actions">
        <button ref="cancelLogout" class="secondary-button" :disabled="loggingOut" @click="closeLogoutConfirm()">取消</button>
        <button class="logout-confirm-danger" :disabled="loggingOut" @click="logout">
          <LoaderCircle v-if="loggingOut" :size="16" class="spin" />
          <LogOut v-else :size="16" />
          {{ loggingOut ? '正在退出' : '退出' }}
        </button>
      </div>
    </div>
  </footer>
</template>
