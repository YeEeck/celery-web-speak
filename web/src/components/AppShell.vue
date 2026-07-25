<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EllipsisVertical, Hash, Plus, Radio, ServerCog, X } from '@lucide/vue'
import AdminPanel from './AdminPanel.vue'
import ChangelogModal from './ChangelogModal.vue'
import ChatPane from './ChatPane.vue'
import LeaveServerDialog from './LeaveServerDialog.vue'
import MemberList from './MemberList.vue'
import PlatformServersPanel from './PlatformServersPanel.vue'
import ProfilePanel from './ProfilePanel.vue'
import ServerActionMenu from './ServerActionMenu.vue'
import UserControls from './UserControls.vue'
import VoiceChannel from './VoiceChannel.vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'
import type { ServerSummary, VersionResponse } from '../types'

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
const platformOpen = ref(false)
const platformInitialServerId = ref<number | null>(null)
const platformCreateOnOpen = ref(false)
const adminInitialTab = ref<'channel' | 'users' | 'invites'>('channel')
const adminPlatformMode = ref(false)
const leavingServer = ref(false)
const leaveServerError = ref('')
const leaveTarget = ref<ServerSummary | null>(null)
const leaveDialogTrigger = ref<HTMLElement | null>(null)
const serverActionMenu = ref<{
  server: ServerSummary
  x: number
  y: number
  align: 'start' | 'end'
  trigger: HTMLElement | null
} | null>(null)
const serverActionTrigger = ref<HTMLButtonElement | null>(null)
const currentVersion = ref('')
let wideMemberQuery: MediaQueryList | null = null
let mobileQuery: MediaQueryList | null = null

const membersVisible = computed(() => wideMemberLayout.value ? desktopMembersVisible.value : membersOpen.value)

watch(() => {
  if (app.activeServerId !== voice.connectedServerId) return null
  const channel = app.voiceChannels.find((item) => item.id === voice.connectedChannelId)
  if (!channel) return null
  return channel
}, (channel) => {
  if (!channel) return
  const changes = voice.updateConnectedChannelSettings(channel)
  if (voice.joined && (changes.microphoneChanged || changes.backgroundAudioChanged)) {
    void voice.applyPublishSettingsChange(changes.microphoneChanged, changes.backgroundAudioChanged)
  }
})
watch(() => app.activeServerId === voice.connectedServerId && app.voiceChannels.some((channel) => channel.id === voice.connectedChannelId), (exists) => {
  if (!exists && voice.joined && app.activeServerId === voice.connectedServerId) void voice.leave()
})
watch(() => voice.connectedServerId === null || app.servers.some((server) => server.id === voice.connectedServerId && server.joined), (hasMembership) => {
  if (!hasMembership && voice.joined) void voice.leave({ notifyServer: false })
})
watch(() => app.activeServerId === voice.connectedServerId ? app.user?.voiceMuted : false, (value) => {
  if (value) void voice.syncServerMute(true)
})
watch(() => app.socketStatus, (value) => {
  if (value === 'online') voice.retryDeafenedSync()
})
watch(() => app.activeServerId, () => closeServerActionMenu())
watch(() => leaveTarget.value === null || app.servers.some((server) => server.id === leaveTarget.value?.id && server.joined), (hasMembership) => {
  if (!hasMembership && !leavingServer.value) closeLeaveServerDialog()
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

function openPlatformServers(serverId: number | null = null, create = false) {
  platformInitialServerId.value = serverId
  platformCreateOnOpen.value = create
  platformOpen.value = true
}

function openServer(server: ServerSummary) {
  if (!server.joined) {
    openPlatformServers(server.id)
    return
  }
  if (!mobileQuery?.matches) {
    void app.selectServer(server.id)
    return
  }
  if (server.id === app.activeServerId) {
    channelsOpen.value = !channelsOpen.value
    return
  }
  void selectMobileRailServer(server.id)
}

async function selectMobileRailServer(serverId: number) {
  await app.selectServer(serverId)
  channelsOpen.value = true
}

function openServerActionMenu(server: ServerSummary, trigger: HTMLElement, x: number, y: number, align: 'start' | 'end') {
  serverActionMenu.value = { server, trigger, x, y, align }
}

function openHeaderServerActions(event: MouseEvent) {
  const server = app.activeServer
  const trigger = event.currentTarget as HTMLElement
  if (!server) return
  if (serverActionMenu.value?.trigger === trigger) {
    closeServerActionMenu(true)
    return
  }
  const bounds = trigger.getBoundingClientRect()
  const headerBounds = mobileQuery?.matches ? trigger.closest('.server-title')?.getBoundingClientRect() : null
  openServerActionMenu(server, trigger, headerBounds ? headerBounds.right - 10 : bounds.right, (headerBounds?.bottom ?? bounds.bottom) + 4, 'end')
}

function openServerContextMenu(server: ServerSummary, event: MouseEvent) {
  openServerActionMenu(server, event.currentTarget as HTMLElement, event.clientX, event.clientY, 'start')
}

function openServerKeyboardMenu(server: ServerSummary, event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  openServerActionMenu(server, trigger, bounds.right + 4, bounds.top, 'start')
}

function closeServerActionMenu(restoreFocus = false) {
  const trigger = serverActionMenu.value?.trigger
  serverActionMenu.value = null
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

async function openServerAdmin(server: ServerSummary) {
  const trigger = serverActionMenu.value?.trigger ?? null
  closeServerActionMenu()
  const previousServerId = app.activeServerId
  try {
    if (server.id !== previousServerId) await app.selectServer(server.id)
  } catch (error) {
    try {
      if (previousServerId !== null && app.servers.some((item) => item.id === previousServerId && item.joined)) await app.selectServer(previousServerId)
      else await app.bootstrap()
    } catch {
      // 保留原始切换错误。
    }
    window.alert(error instanceof Error ? error.message : '服务器加载失败')
    void nextTick(() => trigger?.focus())
    return
  }
  adminInitialTab.value = 'channel'
  adminPlatformMode.value = false
  adminOpen.value = true
  channelsOpen.value = false
}

function openServerPlatformManagement(server: ServerSummary) {
  closeServerActionMenu()
  openPlatformServers(server.id)
  channelsOpen.value = false
}

function confirmLeaveServer(server: ServerSummary) {
  leaveDialogTrigger.value = serverActionMenu.value?.trigger ?? null
  closeServerActionMenu()
  leaveServerError.value = ''
  leaveTarget.value = server
}

function closeLeaveServerDialog() {
  if (leavingServer.value) return
  const trigger = leaveDialogTrigger.value
  leaveTarget.value = null
  leaveServerError.value = ''
  leaveDialogTrigger.value = null
  void nextTick(() => trigger?.focus())
}

function openPlatformAccounts() {
  platformOpen.value = false
  adminInitialTab.value = 'users'
  adminPlatformMode.value = true
  adminOpen.value = true
}

async function leaveServer() {
  const server = leaveTarget.value
  if (!server || server.role === 'owner' || leavingServer.value) return
  leavingServer.value = true
  leaveServerError.value = ''
  try {
    await request(`/api/servers/${server.id}/leave`, { method: 'POST' })
    if (voice.connectedServerId === server.id) {
      try {
        await voice.leave({ notifyServer: false })
      } catch {
        // 后端已经清理目标服务器的语音参与者，继续刷新成员状态。
      }
    }
    await app.bootstrap()
    leaveTarget.value = null
    leaveDialogTrigger.value = null
    channelsOpen.value = false
  } catch (error) {
    leaveServerError.value = error instanceof Error ? error.message : '离开服务器失败'
  } finally {
    leavingServer.value = false
  }
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
      <span class="rail-logo" title="Celery Web Speak"><img class="server-icon" src="/favicon.svg" alt="" /></span>
      <span class="rail-status" :class="app.socketStatus" title="业务连接状态"><Radio :size="18" /></span>
      <span class="rail-divider" />
      <button v-if="app.isPlatformAdmin" class="server-button platform-manage" type="button" title="平台服务器管理" @click="openPlatformServers()"><ServerCog :size="20" /></button>
      <span v-if="app.isPlatformAdmin" class="rail-divider" />
      <div class="rail-scroll">
        <button
          v-for="server in app.servers"
          :key="server.id"
          :class="['server-button', { active: server.id === app.activeServerId, 'metadata-only': !server.joined }]"
          type="button"
          :title="server.joined ? server.name : `${server.name}（仅管理信息）`"
          :aria-label="server.joined ? server.name : `${server.name}（仅管理信息）`"
          @click="openServer(server)"
          @contextmenu.prevent="openServerContextMenu(server, $event)"
          @keydown="openServerKeyboardMenu(server, $event)"
        >
          <span class="server-initial">{{ server.name.trim().slice(0, 1).toUpperCase() }}</span>
          <span v-if="server.unreadCount" class="server-unread" />
        </button>
        <button v-if="app.isPlatformAdmin" class="server-button add-server" type="button" title="创建服务器" @click="openPlatformServers(null, true)"><Plus :size="22" /></button>
      </div>
    </nav>

    <aside :class="['channel-sidebar', { 'mobile-drawer-open': channelsOpen }]">
      <header class="server-title">
        <span><strong>{{ app.activeServer?.name ?? '尚未加入服务器' }}</strong><small>{{ app.activeServer ? '服务器频道' : '请联系服务器管理员' }}</small></span>
        <button v-if="app.activeServer" ref="serverActionTrigger" class="icon-button server-actions-trigger" type="button" title="服务器操作" aria-label="服务器操作" :aria-expanded="serverActionMenu?.trigger === serverActionTrigger" @click="openHeaderServerActions"><EllipsisVertical :size="20" /></button>
        <button v-if="app.isPlatformAdmin && !app.activeServer" class="icon-button mobile-only" title="平台服务器管理" @click="openPlatformServers(); channelsOpen = false"><ServerCog :size="19" /></button>
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
    <ServerActionMenu
      v-if="serverActionMenu"
      :server="serverActionMenu.server"
      :is-platform-admin="app.isPlatformAdmin"
      :x="serverActionMenu.x"
      :y="serverActionMenu.y"
      :align="serverActionMenu.align"
      :trigger="serverActionMenu.trigger"
      @close="closeServerActionMenu"
      @manage="openServerAdmin"
      @platform="openServerPlatformManagement"
      @leave="confirmLeaveServer"
    />
    <LeaveServerDialog v-if="leaveTarget" :server="leaveTarget" :busy="leavingServer" :error="leaveServerError" @cancel="closeLeaveServerDialog" @confirm="leaveServer" />
    <ProfilePanel v-if="profileOpen" @close="profileOpen = false" @changelog="changelogOpen = true" />
    <AdminPanel v-if="adminOpen" :initial-tab="adminInitialTab" :platform-mode="adminPlatformMode" @close="adminOpen = false" />
    <PlatformServersPanel v-if="platformOpen" :initial-server-id="platformInitialServerId" :create-on-open="platformCreateOnOpen" @accounts="openPlatformAccounts" @close="platformOpen = false" />
    <ChangelogModal v-if="changelogOpen" @close="closeChangelog" />
  </main>
</template>
