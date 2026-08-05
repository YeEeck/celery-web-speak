<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LogOut, Mic, MicOff, Music2, VolumeX } from '@lucide/vue'
import { useVoiceStore, type VoiceParticipant } from '../stores/voice'
import type { User } from '../types'
import { rangeProgressStyle } from '../utils/range'
import UserAvatar from './UserAvatar.vue'

const props = defineProps<{
  participant: VoiceParticipant
  member: User | null
  canManage: boolean
  managementPending: boolean
  x: number
  y: number
  trigger: HTMLElement | null
}>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  serverMute: [participant: VoiceParticipant, muted: boolean]
  disconnect: [participant: VoiceParticipant]
}>()

const voice = useVoiceStore()
const panel = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const positioned = ref(false)

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close', true)
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (panel.value?.contains(target) || props.trigger?.contains(target)) return
  emit('close', false)
}

function closeOnViewportChange(event: Event) {
  if (event.type === 'scroll' && event.target instanceof Node && panel.value?.contains(event.target)) return
  emit('close', false)
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('resize', closeOnViewportChange)
  window.addEventListener('scroll', closeOnViewportChange, true)
  await nextTick()
  const bounds = panel.value?.getBoundingClientRect()
  if (!bounds) return
  const margin = 8
  const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin)
  const maxTop = Math.max(margin, window.innerHeight - bounds.height - margin)
  left.value = Math.min(Math.max(margin, props.x), maxLeft)
  top.value = Math.min(Math.max(margin, props.y), maxTop)
  positioned.value = true
  await nextTick()
  panel.value?.querySelector<HTMLElement>('button, input')?.focus()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('resize', closeOnViewportChange)
  window.removeEventListener('scroll', closeOnViewportChange, true)
})
</script>

<template>
  <Teleport to="body">
    <section
      ref="panel"
      class="voice-participant-action-menu motion-popover-static"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="dialog"
      :aria-label="`${participant.name}的语音参与者操作`"
      @keydown="handleKeyDown"
    >
      <header class="voice-participant-action-header">
        <UserAvatar :name="participant.name" :size="34" :user="member ?? undefined" />
        <span><strong>{{ participant.name }}</strong><small>语音参与者</small></span>
      </header>

      <div class="voice-participant-audio-controls">
        <p v-if="voice.autoVoiceBalance" class="voice-participant-balance-hint">自动音量平衡已开启，音量滑杆作为相对偏置</p>
        <div class="voice-participant-audio-row">
          <button
            type="button"
            class="voice-participant-audio-toggle"
            :class="{ muted: participant.microphoneMuted }"
            :title="participant.microphoneMuted ? '恢复麦克风声音' : '关闭麦克风声音'"
            :aria-label="participant.microphoneMuted ? '恢复麦克风声音' : '关闭麦克风声音'"
            @click="voice.toggleParticipantMicrophoneMute(participant.userId)"
          ><component :is="participant.microphoneMuted ? MicOff : Mic" :size="17" /></button>
          <input
            type="range"
            min="0"
            max="3"
            step="0.05"
            :value="participant.microphoneVolume"
            :style="rangeProgressStyle(participant.microphoneVolume, 0, 3)"
            aria-label="麦克风音量"
            @input="voice.setParticipantMicrophoneVolume(participant.userId, Number(($event.target as HTMLInputElement).value))"
          />
          <button
            type="button"
            class="voice-participant-volume-value"
            :class="{ muted: participant.microphoneMuted }"
            title="恢复默认音量"
            @click="voice.resetParticipantMicrophoneVolume(participant.userId)"
          >{{ Math.round(participant.microphoneVolume * 100) }}%</button>
        </div>

        <div v-if="participant.backgroundAudioAvailable" class="voice-participant-audio-row">
          <button
            type="button"
            class="voice-participant-audio-toggle"
            :class="{ muted: participant.backgroundAudioMuted }"
            :title="participant.backgroundAudioMuted ? '恢复背景音' : '关闭背景音'"
            :aria-label="participant.backgroundAudioMuted ? '恢复背景音' : '关闭背景音'"
            @click="voice.toggleParticipantBackgroundAudioMute(participant.userId)"
          ><component :is="participant.backgroundAudioMuted ? VolumeX : Music2" :size="17" /></button>
          <input
            type="range"
            min="0"
            max="3"
            step="0.05"
            :value="participant.backgroundAudioVolume"
            :style="rangeProgressStyle(participant.backgroundAudioVolume, 0, 3)"
            aria-label="背景音音量"
            @input="voice.setParticipantBackgroundAudioVolume(participant.userId, Number(($event.target as HTMLInputElement).value))"
          />
          <button
            type="button"
            class="voice-participant-volume-value"
            :class="{ muted: participant.backgroundAudioMuted }"
            title="恢复默认音量"
            @click="voice.resetParticipantBackgroundAudioVolume(participant.userId)"
          >{{ Math.round(participant.backgroundAudioVolume * 100) }}%</button>
        </div>
      </div>

      <template v-if="canManage && member">
        <span class="voice-participant-action-divider" />
        <div class="voice-participant-management">
          <button
            type="button"
            :disabled="managementPending"
            @click="emit('serverMute', participant, !member.voiceMuted)"
          ><component :is="member.voiceMuted ? Mic : MicOff" :size="17" />{{ member.voiceMuted ? '解除服务器语音禁言' : '服务器语音禁言' }}</button>
          <button
            type="button"
            class="danger"
            :disabled="managementPending"
            @click="emit('disconnect', participant)"
          ><LogOut :size="17" />断开语音</button>
        </div>
      </template>
    </section>
  </Teleport>
</template>
