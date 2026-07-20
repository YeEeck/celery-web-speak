<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, MicOff, Signal, Volume2, VolumeX } from '@lucide/vue'
import { ConnectionQuality } from 'livekit-client'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore, type VoiceParticipant } from '../stores/voice'

const app = useAppStore()
const voice = useVoiceStore()
const expandedVolume = ref<number | null>(null)

const statusLabel = computed(() => {
  if (voice.status === 'connecting') return '正在连接'
  if (voice.status === 'reconnecting') return '正在重连'
  if (voice.status === 'connected') return `${voice.participants.length} 人已连接`
  if (voice.status === 'error') return '连接失败'
  return '点击加入'
})

function qualityBars(quality: ConnectionQuality) {
  if (quality === ConnectionQuality.Excellent) return 3
  if (quality === ConnectionQuality.Good) return 2
  if (quality === ConnectionQuality.Poor) return 1
  return 0
}

function userFor(participant: VoiceParticipant) {
  return app.users.find((user) => user.id === participant.userId)
}
</script>

<template>
  <section class="voice-channel-block">
    <button class="channel-row active" :disabled="voice.status === 'connecting'" @click="voice.join()">
      <Volume2 :size="18" />
      <span class="channel-label">
        <strong>语音频道</strong>
        <small>{{ statusLabel }}</small>
      </span>
      <ChevronRight v-if="!voice.joined" :size="16" />
    </button>

    <div v-if="voice.joined" class="voice-members">
      <div v-for="participant in voice.participants" :key="participant.identity" class="voice-member">
        <button class="voice-member-main" @click="expandedVolume = expandedVolume === participant.userId ? null : participant.userId">
          <UserAvatar :name="participant.name" :size="30" />
          <span class="voice-member-name" :class="{ speaking: participant.isSpeaking }">
            {{ participant.name }}<small v-if="participant.isLocal">你</small>
          </span>
          <span v-if="!participant.microphoneEnabled || participant.deafened" class="voice-status-icons">
            <span v-if="!participant.microphoneEnabled" class="voice-status-icon" role="img" aria-label="麦克风已静音" title="麦克风已静音">
              <MicOff :size="15" class="muted-icon" />
            </span>
            <span v-if="participant.deafened" class="voice-status-icon" role="img" aria-label="耳机已静音" title="耳机已静音">
              <VolumeX :size="15" class="muted-icon" />
            </span>
          </span>
          <span class="quality-bars" :title="`网络质量：${participant.quality}`">
            <i v-for="bar in 3" :key="bar" :class="{ lit: bar <= qualityBars(participant.quality) }" />
          </span>
        </button>
        <div v-if="expandedVolume === participant.userId && !participant.isLocal" class="participant-volume">
          <Volume2 :size="14" />
          <input
            type="range"
            min="0"
            max="3"
            step="0.05"
            :value="participant.volume"
            aria-label="用户音量"
            @input="voice.setParticipantVolume(participant.userId, Number(($event.target as HTMLInputElement).value))"
          />
          <span>{{ Math.round(participant.volume * 100) }}%</span>
        </div>
        <span v-if="userFor(participant)?.voiceMuted" class="server-muted">已禁言</span>
      </div>
      <p v-if="voice.status === 'reconnecting'" class="voice-notice"><Signal :size="14" /> 正在恢复语音连接</p>
    </div>
    <p v-if="voice.deafenedSyncError" class="voice-error">{{ voice.deafenedSyncError }}</p>
    <p v-if="voice.errorMessage" class="voice-error">{{ voice.errorMessage }}</p>
  </section>
</template>
