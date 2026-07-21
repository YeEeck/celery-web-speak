<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Headphones, LoaderCircle, LogOut, Mic, MicOff, Music2, Pause, Play, RefreshCw, Settings, Square, Volume2, VolumeX } from '@lucide/vue'
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
const applicationAudioPanelOpen = ref(false)
const applicationAudioTrigger = ref<HTMLButtonElement | null>(null)
const applicationAudioPanel = ref<HTMLElement | null>(null)

const showApplicationAudio = computed(() => voice.applicationAudioSupported && voice.joined && !app.user?.voiceMuted)

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

async function toggleApplicationAudioPanel() {
  if (voice.applicationAudioActive) {
    applicationAudioPanelOpen.value = !applicationAudioPanelOpen.value
    return
  }
  const started = await voice.startApplicationAudio()
  applicationAudioPanelOpen.value = started || Boolean(voice.applicationAudioError)
}

async function toggleApplicationAudioPlayback() {
  if (voice.applicationAudioPlaying) await voice.pauseApplicationAudio()
  else await voice.resumeApplicationAudio()
}

async function stopApplicationAudio() {
  await voice.stopApplicationAudio()
  applicationAudioPanelOpen.value = false
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
  const target = event.target as Node
  if (confirmLogout.value && !loggingOut.value && !logoutDialog.value?.contains(target) && !logoutTrigger.value?.contains(target)) {
    closeLogoutConfirm(false)
  }
  if (applicationAudioPanelOpen.value && !applicationAudioPanel.value?.contains(target) && !applicationAudioTrigger.value?.contains(target)) {
    applicationAudioPanelOpen.value = false
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && confirmLogout.value) {
    event.preventDefault()
    closeLogoutConfirm()
  } else if (event.key === 'Escape' && applicationAudioPanelOpen.value) {
    event.preventDefault()
    applicationAudioPanelOpen.value = false
  }
}

onMounted(() => {
  void voice.initializeApplicationAudio()
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
        :disabled="!voice.joined || app.user!.voiceMuted || voice.deafened || voice.deafenChanging"
        :title="voice.deafenChanging ? '耳机状态切换中' : voice.deafened ? '耳机静音中' : voice.muted ? '取消静音' : '麦克风静音'"
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
      <button
        v-if="showApplicationAudio"
        ref="applicationAudioTrigger"
        class="icon-button"
        :class="{ active: voice.applicationAudioPlaying, danger: voice.applicationAudioError }"
        :disabled="voice.applicationAudioChanging || (!voice.applicationAudioActive && (voice.status !== 'connected' || voice.deafened))"
        :title="voice.applicationAudioChanging ? '背景音处理中' : voice.applicationAudioActive ? '背景音控制' : '共享应用背景音'"
        :aria-expanded="applicationAudioPanelOpen"
        aria-controls="application-audio-panel"
        @click="toggleApplicationAudioPanel"
      >
        <LoaderCircle v-if="voice.applicationAudioChanging" :size="18" class="spin" />
        <Music2 v-else :size="18" />
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
    <section
      v-if="showApplicationAudio && applicationAudioPanelOpen"
      id="application-audio-panel"
      ref="applicationAudioPanel"
      class="application-audio-popover"
      aria-label="背景音控制"
    >
      <header><Music2 :size="16" /><strong>应用背景音</strong></header>
      <p v-if="voice.applicationAudioError" class="application-audio-error">{{ voice.applicationAudioError }}</p>
      <button
        v-if="voice.applicationAudioError && !voice.applicationAudioActive"
        class="icon-button application-audio-retry"
        title="重新选择应用背景音"
        :disabled="voice.applicationAudioChanging"
        @click="toggleApplicationAudioPanel"
      >
        <RefreshCw :size="17" />
      </button>
      <div v-if="voice.applicationAudioActive" class="application-audio-actions">
        <button
          class="icon-button"
          :title="voice.applicationAudioPlaying ? '暂停背景音' : '播放背景音'"
          :disabled="voice.applicationAudioChanging"
          @click="toggleApplicationAudioPlayback"
        >
          <Pause v-if="voice.applicationAudioPlaying" :size="17" /><Play v-else :size="17" />
        </button>
        <button class="icon-button danger" title="停止共享背景音" :disabled="voice.applicationAudioChanging" @click="stopApplicationAudio">
          <Square :size="16" />
        </button>
      </div>
      <label v-if="voice.applicationAudioActive" class="application-audio-volume">
        <span><Volume2 :size="14" />发送音量</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="voice.applicationAudioVolume"
          @input="voice.setApplicationAudioVolume(Number(($event.target as HTMLInputElement).value))"
        />
        <output>{{ Math.round(voice.applicationAudioVolume * 100) }}%</output>
      </label>
    </section>
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
