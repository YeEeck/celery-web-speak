<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { MicOff, VolumeX } from '@lucide/vue'
import type {
  VoiceOverlayConfig,
  VoiceOverlayParticipant,
  VoiceOverlayState,
} from '../audio/voiceOverlayBridge.ts'
import { initialOf, rowOpacityPercent } from './overlay-utils.ts'

interface OverlayHost {
  getState(): Promise<{ state: VoiceOverlayState; config: VoiceOverlayConfig }>
  onState(listener: (state: VoiceOverlayState) => void): () => void
  onConfig(listener: (config: VoiceOverlayConfig) => void): () => void
}

const host = (window as Window & { overlayHost?: OverlayHost }).overlayHost

const state = ref<VoiceOverlayState>({ channel: null, participants: [] })
const config = ref<VoiceOverlayConfig>({
  scalePercent: 100,
  positionXPercent: 9,
  positionYPercent: 50,
  speakingOpacityPercent: 80,
  silentOpacityPercent: 40,
})

onMounted(() => {
  void host?.getState().then((snapshot) => {
    state.value = snapshot.state
    config.value = snapshot.config
  })
  host?.onState((next) => { state.value = next })
  host?.onConfig((next) => { config.value = next })
})

function opacityPercent(participant: VoiceOverlayParticipant): number {
  return rowOpacityPercent(config.value, participant.speaking)
}

function avatarColor(name: string): string {
  const palette = ['#5865f2', '#248046', '#d83c3e', '#a64d79', '#ca8a04', '#0f766e', '#7c3aed', '#b45309']
  let hash = 0
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]
}

function onAvatarError(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.remove()
}
</script>

<template>
  <ul
    id="participants"
    :style="{ zoom: config.scalePercent / 100 }"
  >
    <li
      v-for="participant in state.participants"
      :key="participant.identity"
      class="participant"
      :class="{ speaking: participant.speaking }"
      :style="{ opacity: opacityPercent(participant) / 100 }"
    >
      <span class="participant-avatar" :style="{ backgroundColor: avatarColor(participant.name) }">
        <img v-if="participant.avatarUrl" class="participant-avatar-image" :src="participant.avatarUrl" alt="" @error="onAvatarError">
        <span v-else class="participant-avatar-initial">{{ initialOf(participant.name) }}</span>
      </span>
      <span class="participant-name">
        {{ participant.name }}<small v-if="participant.isLocal">（你）</small>
      </span>
      <span v-if="participant.deafened" class="participant-icon" role="img" aria-label="耳机已静音" title="耳机已静音">
        <VolumeX :size="14" />
      </span>
      <span v-else-if="participant.microphoneMuted" class="participant-icon" role="img" aria-label="麦克风已静音" title="麦克风已静音">
        <MicOff :size="14" />
      </span>
    </li>
  </ul>
</template>

<style>
:root {
  --overlay-row-bg: rgba(17, 18, 20, 0.82);
  --overlay-text-primary: #e6e6e6;
}

html, body {
  margin: 0;
  background: transparent;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: var(--overlay-text-primary);
  font-size: 15px;
  line-height: 1.4;
  overflow: hidden;
}

#participants {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  width: 280px;
}

.participant {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--overlay-row-bg);
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.participant-avatar {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  overflow: hidden;
}

.participant-avatar-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.participant-avatar-initial {
  font-size: 12px;
  line-height: 26px;
  color: #fff;
}

.participant-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.participant-icon {
  flex: none;
  display: inline-flex;
  color: #f87171;
}
</style>
