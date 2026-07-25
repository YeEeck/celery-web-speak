<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AudioLines, Headphones, LoaderCircle, Mic, MicOff, Music2, Pause, PhoneOff, Play, RadioTower, RefreshCw, Square, Volume2, VolumeX } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'

const app = useAppStore()
const voice = useVoiceStore()
const applicationAudioPanelOpen = ref(false)
const applicationAudioTrigger = ref<HTMLButtonElement | null>(null)
const applicationAudioPanel = ref<HTMLElement | null>(null)

const showApplicationAudio = computed(() => voice.applicationAudioSupported && voice.joined && !app.user?.voiceMuted)

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

function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (applicationAudioPanelOpen.value && !applicationAudioPanel.value?.contains(target) && !applicationAudioTrigger.value?.contains(target)) {
    applicationAudioPanelOpen.value = false
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && applicationAudioPanelOpen.value) {
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
  <footer v-if="voice.joined" class="user-controls">
    <button
      class="transmission-mode-button"
      type="button"
      :disabled="voice.transmissionModeChanging || voice.deafenChanging || voice.status !== 'connected'"
      :title="voice.transmissionModeChanging ? '传输模式切换中' : voice.dtxEnabled ? '语音感应（DTX 已开启）' : '持续传输（DTX 已关闭）'"
      :aria-pressed="voice.dtxEnabled"
      @click="voice.toggleTransmissionMode()"
    >
      <LoaderCircle v-if="voice.transmissionModeChanging" :size="16" class="spin" />
      <AudioLines v-else-if="voice.dtxEnabled" :size="16" />
      <RadioTower v-else :size="16" />
      <span>{{ voice.dtxEnabled ? '语音感应' : '持续传输' }}</span>
    </button>
    <div class="control-buttons">
      <button
        class="icon-button"
        :class="{ danger: voice.muted || app.user!.voiceMuted }"
        :disabled="!voice.joined || app.user!.voiceMuted || voice.deafened || voice.deafenChanging || voice.transmissionModeChanging"
        :title="voice.deafenChanging ? '耳机状态切换中' : voice.deafened ? '耳机静音中' : voice.muted ? '取消静音' : '麦克风静音'"
        @click="voice.toggleMute()"
      >
        <MicOff v-if="voice.muted || app.user!.voiceMuted" :size="18" /><Mic v-else :size="18" />
      </button>
      <button
        class="icon-button"
        :class="{ danger: voice.deafened }"
        :disabled="!voice.joined || voice.deafenChanging || voice.transmissionModeChanging"
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
      <span class="voice-control-divider" aria-hidden="true" />
      <button class="icon-button danger" title="断开语音" aria-label="断开语音" @click="voice.leave()"><PhoneOff :size="18" /></button>
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
  </footer>
</template>
