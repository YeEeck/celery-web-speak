<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { AudioLines, Headphones, LoaderCircle, Mic, MicOff, Music2, Pause, Play, RadioTower, RefreshCw, Square, Volume2, VolumeX } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'
import VoiceDeviceMenu from './VoiceDeviceMenu.vue'

const emit = defineEmits<{
  settings: [kind: 'input' | 'output', trigger: HTMLButtonElement]
}>()

const app = useAppStore()
const voice = useVoiceStore()
const applicationAudioPanelOpen = ref(false)
const applicationAudioTrigger = ref<HTMLButtonElement | null>(null)
const applicationAudioPanel = ref<HTMLElement | null>(null)
const microphoneTrigger = ref<HTMLButtonElement | null>(null)
const outputTrigger = ref<HTMLButtonElement | null>(null)
const volumeOpen = ref<'input' | 'output' | null>(null)
const volumePopover = ref<HTMLElement | null>(null)
const suppressedVolumeHover = ref<'input' | 'output' | null>(null)
const deviceMenu = ref<{ kind: 'input' | 'output'; x: number; y: number; trigger: HTMLButtonElement } | null>(null)
let volumeCloseTimer: number | null = null

const showApplicationAudio = computed(() => voice.applicationAudioSupported && voice.joined && !app.user?.voiceMuted)
const transmissionModeLabel = computed(() => voice.dtxEnabled ? '语音感应' : '持续传输')
const transmissionModeTarget = computed(() => voice.dtxEnabled ? '持续传输' : '语音感应')
const transmissionModeTooltip = computed(() => voice.transmissionModeChanging ? '传输模式切换中' : `切换为${transmissionModeTarget.value}`)
const transmissionModeAriaLabel = computed(() => voice.transmissionModeChanging
  ? '传输模式切换中'
  : `当前模式：${transmissionModeLabel.value}；切换为${transmissionModeTarget.value}`)
const microphoneMuted = computed(() => voice.muted || voice.serverMuted)
const microphoneTitle = computed(() => {
  if (voice.muteChanging) return '麦克风状态切换中'
  if (voice.serverMuted) return voice.microphoneEnabledPreference ? '管理员禁言' : '取消静音'
  return voice.muted ? '取消静音' : '麦克风静音'
})

function finePointerAvailable() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function triggerFor(kind: 'input' | 'output') {
  return kind === 'input' ? microphoneTrigger.value : outputTrigger.value
}

function clearVolumeCloseTimer() {
  if (volumeCloseTimer === null) return
  window.clearTimeout(volumeCloseTimer)
  volumeCloseTimer = null
}

function openVolume(kind: 'input' | 'output') {
  if (deviceMenu.value || suppressedVolumeHover.value === kind) return
  clearVolumeCloseTimer()
  applicationAudioPanelOpen.value = false
  volumeOpen.value = kind
}

function handleVolumePointerEnter(kind: 'input' | 'output', event: PointerEvent) {
  if (event.pointerType === 'mouse') openVolume(kind)
}

function scheduleVolumeClose() {
  clearVolumeCloseTimer()
  volumeCloseTimer = window.setTimeout(() => {
    if (volumePopover.value?.contains(document.activeElement)) return
    volumeOpen.value = null
    volumeCloseTimer = null
  }, 180)
}

function handleControlPointerLeave(kind: 'input' | 'output') {
  if (suppressedVolumeHover.value === kind) suppressedVolumeHover.value = null
  scheduleVolumeClose()
}

function handleControlFocus(kind: 'input' | 'output') {
  if (finePointerAvailable()) openVolume(kind)
}

function closeVolume(restoreFocus = false) {
  const kind = volumeOpen.value
  clearVolumeCloseTimer()
  volumeOpen.value = null
  if (restoreFocus && kind) void nextTick(() => triggerFor(kind)?.focus())
}

function openDeviceMenu(kind: 'input' | 'output', event: MouseEvent) {
  if (!finePointerAvailable()) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLButtonElement
  closeVolume()
  applicationAudioPanelOpen.value = false
  suppressedVolumeHover.value = kind
  deviceMenu.value = { kind, x: event.clientX, y: event.clientY, trigger }
}

function handleControlKeyDown(kind: 'input' | 'output', event: KeyboardEvent) {
  if (event.key === 'Escape' && volumeOpen.value === kind) {
    event.preventDefault()
    closeVolume(true)
    return
  }
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLButtonElement
  const bounds = trigger.getBoundingClientRect()
  closeVolume()
  applicationAudioPanelOpen.value = false
  suppressedVolumeHover.value = kind
  deviceMenu.value = { kind, x: bounds.right + 4, y: bounds.top, trigger }
}

function closeDeviceMenu(restoreFocus = false) {
  const trigger = deviceMenu.value?.trigger
  deviceMenu.value = null
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

function openVoiceSettings(kind: 'input' | 'output', trigger: HTMLButtonElement) {
  deviceMenu.value = null
  emit('settings', kind, trigger)
}

async function toggleApplicationAudioPanel() {
  closeVolume()
  closeDeviceMenu()
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
  clearVolumeCloseTimer()
  document.removeEventListener('pointerdown', handlePointerDown)
  document.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <footer class="user-controls">
    <div class="transmission-mode-control">
      <button
        class="transmission-mode-button"
        type="button"
        :disabled="voice.transmissionModeChanging || voice.deafenChanging || voice.muteChanging"
        :aria-label="transmissionModeAriaLabel"
        @click="voice.toggleTransmissionMode()"
      >
        <LoaderCircle v-if="voice.transmissionModeChanging" :size="16" class="spin" />
        <AudioLines v-else-if="voice.dtxEnabled" :size="16" />
        <RadioTower v-else :size="16" />
        <span>{{ transmissionModeLabel }}</span>
      </button>
      <span class="transmission-mode-tooltip" aria-hidden="true">{{ transmissionModeTooltip }}</span>
    </div>
    <div class="control-buttons">
      <div
        class="voice-volume-control"
        @pointerenter="handleVolumePointerEnter('input', $event)"
        @pointerleave="handleControlPointerLeave('input')"
      >
        <button
          ref="microphoneTrigger"
          class="icon-button"
          :class="{ danger: microphoneMuted }"
          :disabled="voice.muteChanging || voice.deafenChanging"
          :title="microphoneTitle"
          :aria-expanded="volumeOpen === 'input'"
          aria-controls="microphone-volume-popover"
          @focus="handleControlFocus('input')"
          @click="voice.toggleMute()"
          @contextmenu="openDeviceMenu('input', $event)"
          @keydown="handleControlKeyDown('input', $event)"
        >
          <LoaderCircle v-if="voice.muteChanging" :size="18" class="spin" />
          <MicOff v-else-if="microphoneMuted" :size="18" /><Mic v-else :size="18" />
        </button>
        <section
          v-if="volumeOpen === 'input'"
          id="microphone-volume-popover"
          ref="volumePopover"
          class="voice-volume-popover"
          aria-label="麦克风增益"
          @pointerenter="clearVolumeCloseTimer"
          @pointerleave="scheduleVolumeClose"
        >
          <output>{{ Math.round(voice.microphoneGain * 100) }}%</output>
          <input type="range" min="0" max="3" step="0.05" :value="voice.microphoneGain" aria-label="麦克风增益" @input="voice.setMicrophoneGain(Number(($event.target as HTMLInputElement).value))" @keydown.esc.prevent="closeVolume(true)" />
          <Mic :size="14" aria-hidden="true" />
        </section>
      </div>
      <div
        class="voice-volume-control"
        @pointerenter="handleVolumePointerEnter('output', $event)"
        @pointerleave="handleControlPointerLeave('output')"
      >
        <button
          ref="outputTrigger"
          class="icon-button"
          :class="{ danger: voice.deafened }"
          :disabled="voice.deafenChanging || voice.muteChanging"
          :title="voice.deafenChanging ? '耳机状态切换中' : voice.deafened ? '取消耳机静音' : '耳机静音'"
          :aria-expanded="volumeOpen === 'output'"
          aria-controls="output-volume-popover"
          @focus="handleControlFocus('output')"
          @click="voice.toggleDeafen()"
          @contextmenu="openDeviceMenu('output', $event)"
          @keydown="handleControlKeyDown('output', $event)"
        >
          <LoaderCircle v-if="voice.deafenChanging" :size="18" class="spin" />
          <VolumeX v-else-if="voice.deafened" :size="18" /><Headphones v-else :size="18" />
        </button>
        <section
          v-if="volumeOpen === 'output'"
          id="output-volume-popover"
          ref="volumePopover"
          class="voice-volume-popover"
          aria-label="扬声器音量"
          @pointerenter="clearVolumeCloseTimer"
          @pointerleave="scheduleVolumeClose"
        >
          <output>{{ Math.round(voice.outputVolume * 100) }}%</output>
          <input type="range" min="0" max="3" step="0.05" :value="voice.outputVolume" aria-label="扬声器音量" @input="voice.setOutputVolume(Number(($event.target as HTMLInputElement).value))" @keydown.esc.prevent="closeVolume(true)" />
          <Volume2 :size="14" aria-hidden="true" />
        </section>
      </div>
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
    </div>
    <p v-if="voice.voicePreferenceFeedback" class="voice-preference-feedback" role="status">{{ voice.voicePreferenceFeedback }}</p>
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
        <button class="icon-button" :title="voice.applicationAudioPlaying ? '暂停背景音' : '播放背景音'" :disabled="voice.applicationAudioChanging" @click="toggleApplicationAudioPlayback">
          <Pause v-if="voice.applicationAudioPlaying" :size="17" /><Play v-else :size="17" />
        </button>
        <button class="icon-button danger" title="停止共享背景音" :disabled="voice.applicationAudioChanging" @click="stopApplicationAudio"><Square :size="16" /></button>
      </div>
      <label v-if="voice.applicationAudioActive" class="application-audio-volume">
        <span><Volume2 :size="14" />发送音量</span>
        <input type="range" min="0" max="1" step="0.01" :value="voice.applicationAudioVolume" @input="voice.setApplicationAudioVolume(Number(($event.target as HTMLInputElement).value))" />
        <output>{{ Math.round(voice.applicationAudioVolume * 100) }}%</output>
      </label>
    </section>
    <VoiceDeviceMenu
      v-if="deviceMenu"
      :kind="deviceMenu.kind"
      :x="deviceMenu.x"
      :y="deviceMenu.y"
      :trigger="deviceMenu.trigger"
      @close="closeDeviceMenu"
      @settings="openVoiceSettings"
    />
  </footer>
</template>
