<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Hash, Plus, Radio, ServerCog, X } from '@lucide/vue'
import AdminPanel from './AdminPanel.vue'
import ChangelogModal from './ChangelogModal.vue'
import ChatPane from './ChatPane.vue'
import MemberList from './MemberList.vue'
import ProfilePanel from './ProfilePanel.vue'
import UserControls from './UserControls.vue'
import VoiceChannel from './VoiceChannel.vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'
import type { VersionResponse } from '../types'

const LAST_SEEN_VERSION_KEY = 'cws.lastSeenVersion'

const app = useAppStore()
const voice = useVoiceStore()
const channelsOpen = ref(false)
const membersOpen = ref(false)
const desktopMembersVisible = ref(true)
const wideMemberLayout = ref(window.matchMedia('(min-width: 1141px)').matches)
const profileOpen = ref(false)
const adminOpen = ref(false)
const changelogOpen = ref(false)
const currentVersion = ref('')
let wideMemberQuery: MediaQueryList | null = null
let mobileQuery: MediaQueryList | null = null

const membersVisible = computed(() => wideMemberLayout.value ? desktopMembersVisible.value : membersOpen.value)

watch(() => {
  const channel = app.voiceChannels.find((item) => item.id === voice.connectedChannelId)
  if (!channel) return null
  return {
    microphone: `${channel.audioBitrateKbps ?? 64}:${channel.audioRedEnabled ?? true}`,
    backgroundAudio: `${channel.backgroundAudioBitrateKbps ?? 128}:${channel.backgroundAudioRedEnabled ?? false}`,
  }
}, (value, oldValue) => {
  if (!value || !oldValue || !voice.joined) return
  const microphoneChanged = value.microphone !== oldValue.microphone
  const backgroundAudioChanged = value.backgroundAudio !== oldValue.backgroundAudio
  if (microphoneChanged || backgroundAudioChanged) {
    void voice.applyPublishSettingsChange(microphoneChanged, backgroundAudioChanged)
  }
})
watch(() => app.activeServerId === voice.connectedServerId && app.voiceChannels.some((channel) => channel.id === voice.connectedChannelId), (exists) => {
  if (!exists && voice.joined && app.activeServerId === voice.connectedServerId) void voice.leave()
})
watch(() => app.user?.voiceMuted, (value) => {
  if (value) void voice.syncServerMute(true)
})
watch(() => app.socketStatus, (value) => {
  if (value === 'online') voice.retryDeafenedSync()
})
onMounted(() => {
  wideMemberQuery = window.matchMedia('(min-width: 1141px)')
  mobileQuery = window.matchMedia('(max-width: 760px)')
  wideMemberQuery.addEventListener('change', handleWideMemberLayout)
  mobileQuery.addEventListener('change', closeTemporaryDrawers)
  void checkVersionAndShowChangelog()
})
onBeforeUnmount(() => {
  wideMemberQuery?.removeEventListener('change', handleWideMemberLayout)
  mobileQuery?.removeEventListener('change', closeTemporaryDrawers)
  void voice.leave()
})

function toggleMembers() {
  if (wideMemberLayout.value) {
    desktopMembersVisible.value = !desktopMembersVisible.value
  } else {
    membersOpen.value = !membersOpen.value
  }
}

function handleWideMemberLayout(event: MediaQueryListEvent) {
  wideMemberLayout.value = event.matches
  closeTemporaryDrawers()
}

function closeTemporaryDrawers() {
  channelsOpen.value = false
  membersOpen.value = false
}

function selectTextChannel(channelId: number) {
  void app.selectTextChannel(channelId)
  channelsOpen.value = false
}

function selectMobileServer(event: Event) {
  const serverId = Number((event.target as HTMLSelectElement).value)
  if (serverId > 0) void app.selectServer(serverId)
}

async function createServer() {
  const name = window.prompt('服务器名称')?.trim()
  if (!name) return
  const ownerUsername = window.prompt('所有者完整登录名')?.trim()
  if (!ownerUsername) return
  await request('/api/platform/servers', { method: 'POST', body: JSON.stringify({ name, ownerUsername }) })
  await app.bootstrap()
}

async function checkVersionAndShowChangelog() {
  try {
    const data = await request<VersionResponse>('/api/version')
    currentVersion.value = data.version
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY)
    if (lastSeen !== data.version) {
      changelogOpen.value = true
    }
  } catch {
    // 静默跳过，不弹窗
  }
}

function closeChangelog() {
  changelogOpen.value = false
  if (currentVersion.value) {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, currentVersion.value)
  }
}
</script>

<template>
  <main :class="['app-shell', { 'members-collapsed': wideMemberLayout && !desktopMembersVisible }]">
    <nav class="server-rail" aria-label="服务器">
      <button
        v-for="server in app.servers"
        :key="server.id"
        :class="['server-button', { active: server.id === app.activeServerId, 'metadata-only': !server.joined }]"
        type="button"
        :title="server.joined ? server.name : `${server.name}（仅管理信息）`"
        @click="server.joined && app.selectServer(server.id)"
      >
        <span class="server-initial">{{ server.name.trim().slice(0, 1).toUpperCase() }}</span>
        <span v-if="server.unreadCount" class="server-unread" />
      </button>
      <span class="rail-divider" />
      <button v-if="app.isPlatformAdmin" class="server-button add-server" type="button" title="创建服务器" @click="createServer"><Plus :size="22" /></button>
      <span class="rail-status" :class="app.socketStatus" title="业务连接状态"><Radio :size="18" /></span>
    </nav>

    <aside :class="['channel-sidebar', { 'mobile-drawer-open': channelsOpen }]">
      <header class="server-title">
        <span><strong>{{ app.activeServer?.name ?? '尚未加入服务器' }}</strong><small>{{ app.activeServer ? '服务器频道' : '请联系服务器管理员' }}</small></span>
        <select class="mobile-server-select mobile-only" :value="app.activeServerId ?? ''" aria-label="切换服务器" @change="selectMobileServer">
          <option v-for="server in app.servers.filter((item) => item.joined)" :key="server.id" :value="server.id">{{ server.name }}</option>
        </select>
        <button class="icon-button mobile-only" title="关闭" @click="channelsOpen = false"><X :size="19" /></button>
      </header>
      <div class="channel-scroll">
        <p v-if="!app.activeServer" class="server-empty">尚未加入任何服务器，请联系服务器管理员将你加入服务器。</p>
        <div v-if="app.activeServer" class="category-heading"><span>语音频道</span></div>
        <VoiceChannel v-for="channel in app.voiceChannels" :key="channel.id" :channel="channel" />
        <div v-if="app.activeServer" class="category-heading"><span>文字频道</span></div>
        <button
          v-for="channel in app.textChannels"
          :key="channel.id"
          :class="['channel-row', { active: app.activeTextChannelId === channel.id }]"
          @click="selectTextChannel(channel.id)"
        >
          <Hash :size="18" />
          <span class="channel-label"><strong>{{ channel.name }}</strong><small>最近 {{ channel.messageRetention }} 条</small></span>
          <span v-if="app.channelReadStates[channel.id]?.unreadCount" class="channel-unread">{{ app.channelReadStates[channel.id].unreadCount }}</span>
        </button>
        <div v-if="app.isAdmin" class="admin-entry">
          <button class="channel-row" @click="adminOpen = true; channelsOpen = false"><ServerCog :size="18" /><span class="channel-label"><strong>管理控制台</strong><small>{{ app.isServerAdmin ? '服务器与频道' : '频道管理' }}</small></span></button>
        </div>
      </div>
      <div v-if="voice.joined" class="voice-connection-panel">
        <span class="connection-indicator" /><span><strong>{{ voice.status === 'connected' ? '语音已连接' : '正在恢复连接' }}</strong><small>{{ voice.connectedServerName }} / {{ voice.connectedChannelName }}</small></span>
        <button class="icon-button" title="断开语音" @click="voice.leave()"><X :size="17" /></button>
      </div>
      <UserControls @settings="profileOpen = true" />
    </aside>

    <ChatPane :members-visible="membersVisible" @channels="channelsOpen = true" @members="toggleMembers" />
    <MemberList />

    <div v-if="channelsOpen" class="drawer-scrim" @click="channelsOpen = false" />
    <div v-if="membersOpen" class="drawer-scrim member-scrim" @click="membersOpen = false">
      <MemberList :drawer="true" @close="membersOpen = false" @click.stop />
    </div>

    <div id="voice-audio-root" aria-hidden="true" />
    <ProfilePanel v-if="profileOpen" @close="profileOpen = false" @changelog="changelogOpen = true" />
    <AdminPanel v-if="adminOpen" @close="adminOpen = false" />
    <ChangelogModal v-if="changelogOpen" @close="closeChangelog" />
  </main>
</template>
