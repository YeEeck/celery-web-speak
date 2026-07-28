<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, MicOff, Music2, Signal, Volume2, VolumeX } from '@lucide/vue'
import { ConnectionQuality } from 'livekit-client'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore, type VoiceParticipant } from '../stores/voice'
import type { Channel } from '../types'

const props = defineProps<{ channel: Channel; actionMenuUserId?: number | null }>()
const emit = defineEmits<{
  channelMenu: [channel: Channel, trigger: HTMLElement, x: number, y: number]
  participantMenu: [channel: Channel, participant: VoiceParticipant, trigger: HTMLElement, x: number, y: number]
}>()
const app = useAppStore()
const voice = useVoiceStore()

const connected = computed(() => voice.joined && voice.connectedChannelId === props.channel.id)
const roomState = computed(() => app.voiceRooms.find((room) => room.channelId === props.channel.id))
const previewParticipants = computed(() => roomState.value?.participants ?? [])
const statusLabel = computed(() => {
  if (voice.connectedChannelId === props.channel.id && voice.status === 'connecting') return '正在连接'
  if (voice.connectedChannelId === props.channel.id && voice.status === 'reconnecting') return '正在重连'
  const count = connected.value ? voice.participants.length : previewParticipants.value.length
  if (count > 0) return `${count} 人已连接`
  if (voice.connectedChannelId === props.channel.id && voice.status === 'error') return '连接失败'
  return '点击加入'
})

function qualityBars(quality: ConnectionQuality) {
  if (quality === ConnectionQuality.Excellent) return 3
  if (quality === ConnectionQuality.Good) return 2
  if (quality === ConnectionQuality.Poor) return 1
  return 0
}

function userFor(participant: VoiceParticipant | { userId: number }) {
  return app.users.find((user) => user.id === participant.userId)
}

function openContextMenu(event: MouseEvent) {
  emit('channelMenu', props.channel, event.currentTarget as HTMLElement, event.clientX, event.clientY)
}

function openKeyboardMenu(event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  emit('channelMenu', props.channel, trigger, bounds.right + 4, bounds.top)
}

function openParticipantMenu(participant: VoiceParticipant, event: MouseEvent) {
  if (participant.isLocal) return
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  emit('participantMenu', props.channel, participant, trigger, event.clientX || bounds.right + 4, event.clientY || bounds.top)
}

function openParticipantKeyboardMenu(participant: VoiceParticipant, event: KeyboardEvent) {
  if (participant.isLocal || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  emit('participantMenu', props.channel, participant, trigger, bounds.right + 4, bounds.top)
}
</script>

<template>
  <section class="voice-channel-block">
    <button
      :class="['channel-row', { active: connected }]"
      :disabled="voice.status === 'connecting'"
      @click="voice.join(channel.id)"
      @contextmenu.prevent="openContextMenu"
      @keydown="openKeyboardMenu"
    >
      <Volume2 :size="18" />
      <span class="channel-label">
        <strong>{{ channel.name }}</strong>
        <small>{{ statusLabel }}</small>
      </span>
      <ChevronRight v-if="!connected" :size="16" />
    </button>

    <div v-if="connected" class="voice-members">
      <div v-for="participant in voice.participants" :key="participant.identity" class="voice-member">
        <button
          class="voice-member-main"
          :class="{ 'local-participant': participant.isLocal }"
          :title="participant.isLocal ? undefined : '打开参与者操作'"
          :aria-label="participant.isLocal ? `${participant.name}（你）` : `${participant.name}的语音参与者操作`"
          :aria-haspopup="participant.isLocal ? undefined : 'dialog'"
          :aria-expanded="participant.isLocal ? undefined : actionMenuUserId === participant.userId"
          @click="openParticipantMenu(participant, $event)"
          @contextmenu.prevent="openParticipantMenu(participant, $event)"
          @keydown="openParticipantKeyboardMenu(participant, $event)"
        >
          <UserAvatar :name="participant.name" :size="30" :user="userFor(participant)" />
          <span class="voice-member-name" :class="{ speaking: participant.isSpeaking }">
            {{ participant.name }}<small v-if="participant.isLocal">你</small>
          </span>
          <span v-if="!participant.microphoneEnabled || participant.deafened || participant.backgroundAudioPlaying" class="voice-status-icons">
            <span v-if="!participant.microphoneEnabled" class="voice-status-icon" role="img" aria-label="麦克风已静音" title="麦克风已静音">
              <MicOff :size="15" class="muted-icon" />
            </span>
            <span v-if="participant.deafened" class="voice-status-icon" role="img" aria-label="耳机已静音" title="耳机已静音">
              <VolumeX :size="15" class="muted-icon" />
            </span>
            <span v-if="participant.backgroundAudioPlaying" class="voice-status-icon background-audio-status" role="img" aria-label="正在共享背景音" title="正在共享背景音">
              <Music2 :size="15" />
            </span>
          </span>
          <span class="quality-bars" :title="`网络质量：${participant.quality}`">
            <i v-for="bar in 3" :key="bar" :class="{ lit: bar <= qualityBars(participant.quality) }" />
          </span>
        </button>
        <span v-if="userFor(participant)?.voiceMuted" class="guild-muted">已禁言</span>
      </div>
      <p v-if="voice.status === 'reconnecting'" class="voice-notice"><Signal :size="14" /> 正在恢复语音连接</p>
    </div>
    <div v-else-if="previewParticipants.length" class="voice-members voice-members-preview">
      <div v-for="participant in previewParticipants" :key="participant.identity" class="voice-member">
        <div class="voice-member-main">
          <UserAvatar :name="userFor(participant)?.displayName ?? participant.name" :size="30" :user="userFor(participant)" />
          <span class="voice-member-name">{{ userFor(participant)?.displayName ?? participant.name }}</span>
        </div>
      </div>
    </div>
    <p v-if="connected && voice.deafenedSyncError" class="voice-error">{{ voice.deafenedSyncError }}</p>
    <p v-if="voice.connectedChannelId === channel.id && voice.errorMessage" class="voice-error">{{ voice.errorMessage }}</p>
  </section>
</template>
