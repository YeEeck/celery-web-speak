<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { Hash, Radio, ServerCog, X } from '@lucide/vue'
import AdminPanel from './AdminPanel.vue'
import ChatPane from './ChatPane.vue'
import MemberList from './MemberList.vue'
import ProfilePanel from './ProfilePanel.vue'
import UserControls from './UserControls.vue'
import VoiceChannel from './VoiceChannel.vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'

const app = useAppStore()
const voice = useVoiceStore()
const channelsOpen = ref(false)
const membersOpen = ref(false)
const profileOpen = ref(false)
const adminOpen = ref(false)

watch(() => app.settings.audioBitrateKbps, (value, oldValue) => {
  if (oldValue !== undefined && value !== oldValue && voice.joined) void voice.applyBitrateChange()
})
watch(() => app.user?.voiceMuted, (value) => {
  if (value) void voice.syncServerMute(true)
})
onBeforeUnmount(() => void voice.leave())
</script>

<template>
  <main class="app-shell">
    <nav class="server-rail" aria-label="服务器">
      <button class="server-button active" title="Celery Web Speak">C</button>
      <span class="rail-divider" />
      <span class="rail-status" :class="app.socketStatus" title="业务连接状态"><Radio :size="18" /></span>
    </nav>

    <aside :class="['channel-sidebar', { 'mobile-drawer-open': channelsOpen }]">
      <header class="server-title">
        <span><strong>Celery Web Speak</strong><small>单频道服务器</small></span>
        <button class="icon-button mobile-only" title="关闭" @click="channelsOpen = false"><X :size="19" /></button>
      </header>
      <div class="channel-scroll">
        <div class="category-heading"><span>语音频道</span></div>
        <VoiceChannel />
        <div class="category-heading"><span>文字频道</span></div>
        <button class="channel-row active"><Hash :size="18" /><span class="channel-label"><strong>文字聊天</strong><small>最近 {{ app.settings.messageRetention }} 条</small></span></button>
        <div v-if="app.isAdmin" class="admin-entry">
          <button class="channel-row" @click="adminOpen = true; channelsOpen = false"><ServerCog :size="18" /><span class="channel-label"><strong>管理控制台</strong><small>{{ app.isServerAdmin ? '服务器与频道' : '频道管理' }}</small></span></button>
        </div>
      </div>
      <div v-if="voice.joined" class="voice-connection-panel">
        <span class="connection-indicator" /><span><strong>{{ voice.status === 'connected' ? '语音已连接' : '正在恢复连接' }}</strong><small>语音频道 / {{ app.settings.audioBitrateKbps }} kbps</small></span>
        <button class="icon-button" title="断开语音" @click="voice.leave()"><X :size="17" /></button>
      </div>
      <UserControls @settings="profileOpen = true" />
    </aside>

    <ChatPane @channels="channelsOpen = true" @members="membersOpen = true" />
    <MemberList />

    <div v-if="channelsOpen" class="drawer-scrim" @click="channelsOpen = false" />
    <div v-if="membersOpen" class="drawer-scrim member-scrim" @click="membersOpen = false">
      <MemberList :drawer="true" @close="membersOpen = false" @click.stop />
    </div>

    <div id="voice-audio-root" aria-hidden="true" />
    <ProfilePanel v-if="profileOpen" @close="profileOpen = false" />
    <AdminPanel v-if="adminOpen" @close="adminOpen = false" />
  </main>
</template>
