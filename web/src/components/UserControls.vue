<script setup lang="ts">
import { computed, ref } from 'vue'
import { Headphones, LogOut, Mic, MicOff, Settings, VolumeX } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'

defineEmits<{ settings: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const confirmLogout = ref(false)

const voiceStatus = computed(() => {
  if (!voice.joined) return '未连接语音'
  if (voice.status === 'reconnecting') return '语音重连中'
  return voice.muted ? '麦克风已静音' : '语音已连接'
})

async function logout() {
  await voice.leave()
  await app.logout()
}
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
        :disabled="!voice.joined || app.user!.voiceMuted"
        :title="voice.muted ? '取消静音' : '麦克风静音'"
        @click="voice.toggleMute()"
      >
        <MicOff v-if="voice.muted || app.user!.voiceMuted" :size="18" /><Mic v-else :size="18" />
      </button>
      <button
        class="icon-button"
        :class="{ danger: voice.deafened }"
        :disabled="!voice.joined"
        :title="voice.deafened ? '取消耳机静音' : '耳机静音'"
        @click="voice.toggleDeafen()"
      >
        <VolumeX v-if="voice.deafened" :size="18" /><Headphones v-else :size="18" />
      </button>
      <button class="icon-button" title="用户设置" @click="$emit('settings')"><Settings :size="18" /></button>
      <button v-if="confirmLogout" class="icon-button danger" title="确认退出" @click="logout"><LogOut :size="18" /></button>
      <button v-else class="icon-button" title="退出登录" @click="confirmLogout = true"><LogOut :size="18" /></button>
    </div>
  </footer>
</template>
