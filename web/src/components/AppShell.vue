<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EllipsisVertical, Hash, LogOut, Plus, Radio, ServerCog, X } from '@lucide/vue'
import AccountMenu from './AccountMenu.vue'
import ChannelActionMenu from './ChannelActionMenu.vue'
import GuildAdminPanel from './GuildAdminPanel.vue'
import PlatformAdminPanel from './PlatformAdminPanel.vue'
import ChangelogModal from './ChangelogModal.vue'
import ChatPane from './ChatPane.vue'
import LeaveGuildDialog from './LeaveGuildDialog.vue'
import LogoutDialog from './LogoutDialog.vue'
import MemberList from './MemberList.vue'
import PlatformGuildsPanel from './PlatformGuildsPanel.vue'
import ProfilePanel from './ProfilePanel.vue'
import GuildActionMenu from './GuildActionMenu.vue'
import UserControls from './UserControls.vue'
import UserAvatar from './UserAvatar.vue'
import VoiceChannel from './VoiceChannel.vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'
import type { Channel, GuildSummary, VersionResponse } from '../types'

const LAST_SEEN_VERSION_KEY = 'cws.lastSeenVersion'

const app = useAppStore()
const voice = useVoiceStore()
const channelsOpen = ref(false)
const membersOpen = ref(false)
const desktopMembersVisible = ref(true)
const wideMemberLayout = ref(window.matchMedia('(min-width: 1141px)').matches)
const profileOpen = ref(false)
const profileInitialTab = ref<'account' | 'audio'>('account')
const profileInitialAudioSubNav = ref<'input' | 'output'>('input')
const profileFocusReturn = ref<HTMLElement | null>(null)
const adminOpen = ref(false)
const adminInitialTab = ref<'guild' | 'channel' | 'users' | undefined>()
const adminInitialChannelId = ref<number | null>(null)
const changelogOpen = ref(false)
const platformOpen = ref(false)
const platformInitialGuildId = ref<number | null>(null)
const platformCreateOnOpen = ref(false)
const platformAdminOpen = ref(false)
const leavingGuild = ref(false)
const leaveGuildError = ref('')
const leaveTarget = ref<GuildSummary | null>(null)
const leaveDialogTrigger = ref<HTMLElement | null>(null)
const guildActionMenu = ref<{
  guild: GuildSummary
  x: number
  y: number
  align: 'start' | 'end'
  trigger: HTMLElement | null
} | null>(null)
const guildActionTrigger = ref<HTMLButtonElement | null>(null)
const channelActionMenu = ref<{
  channel: Channel
  x: number
  y: number
  trigger: HTMLElement | null
} | null>(null)
const actionToast = ref<{ message: string; type: 'success' | 'error' } | null>(null)
const accountTrigger = ref<HTMLButtonElement | null>(null)
const accountMenuOpen = ref(false)
const logoutOpen = ref(false)
const loggingOut = ref(false)
const logoutError = ref('')
const currentVersion = ref('')
let wideMemberQuery: MediaQueryList | null = null
let mobileQuery: MediaQueryList | null = null
let actionToastTimer: number | null = null

const membersVisible = computed(() => wideMemberLayout.value ? desktopMembersVisible.value : membersOpen.value)

watch(() => {
  if (app.activeGuildId !== voice.connectedGuildId) return null
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
watch(() => app.activeGuildId === voice.connectedGuildId && app.voiceChannels.some((channel) => channel.id === voice.connectedChannelId), (exists) => {
  if (!exists && voice.joined && app.activeGuildId === voice.connectedGuildId) void voice.leave()
})
watch(() => voice.connectedGuildId === null || app.guilds.some((guild) => guild.id === voice.connectedGuildId && guild.joined), (hasMembership) => {
  if (!hasMembership && voice.joined) void voice.leave({ notifyGuild: false })
})
watch(() => app.activeGuildId === voice.connectedGuildId ? app.user?.voiceMuted : undefined, (value) => {
  if (value !== undefined) void voice.syncGuildMute(value)
}, { immediate: true })
watch(() => app.socketStatus, (value) => {
  if (value === 'online') voice.retryDeafenedSync()
})
watch(() => app.activeGuildId, () => {
  closeGuildActionMenu()
  closeChannelActionMenu()
})
watch(() => channelActionMenu.value === null || app.channels.some((channel) => channel.id === channelActionMenu.value?.channel.id), (exists) => {
  if (!exists) closeChannelActionMenu()
})
watch(() => leaveTarget.value === null || app.guilds.some((guild) => guild.id === leaveTarget.value?.id && guild.joined), (hasMembership) => {
  if (!hasMembership && !leavingGuild.value) closeLeaveGuildDialog()
})
onMounted(() => {
  wideMemberQuery = window.matchMedia('(min-width: 1141px)')
  mobileQuery = window.matchMedia('(max-width: 760px)')
  wideMemberQuery.addEventListener('change', handleWideMemberLayout)
  mobileQuery.addEventListener('change', closeTemporaryDrawers)
  void voice.initializeDevices()
  void checkVersionAndShowChangelog()
})
onBeforeUnmount(() => {
  wideMemberQuery?.removeEventListener('change', handleWideMemberLayout)
  mobileQuery?.removeEventListener('change', closeTemporaryDrawers)
  if (actionToastTimer !== null) window.clearTimeout(actionToastTimer)
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
  closeAccountMenu()
}

function selectTextChannel(channelId: number) {
  void app.selectTextChannel(channelId)
  channelsOpen.value = false
}

function openPlatformGuilds(guildId: number | null = null, create = false) {
  platformInitialGuildId.value = guildId
  platformCreateOnOpen.value = create
  platformOpen.value = true
}

function openGuild(guild: GuildSummary) {
  closeAccountMenu()
  if (!guild.joined) {
    openPlatformGuilds(guild.id)
    return
  }
  if (!mobileQuery?.matches) {
    void app.selectGuild(guild.id)
    return
  }
  if (guild.id === app.activeGuildId) {
    channelsOpen.value = !channelsOpen.value
    return
  }
  void selectMobileRailGuild(guild.id)
}

async function selectMobileRailGuild(guildId: number) {
  await app.selectGuild(guildId)
  channelsOpen.value = true
}

function toggleAccountMenu() {
  if (accountMenuOpen.value) {
    closeAccountMenu(true)
    return
  }
  closeGuildActionMenu()
  channelsOpen.value = false
  accountMenuOpen.value = true
}

function closeAccountMenu(restoreFocus = false) {
  accountMenuOpen.value = false
  if (restoreFocus) void nextTick(() => accountTrigger.value?.focus())
}

function openProfile() {
  closeAccountMenu()
  profileInitialTab.value = 'account'
  profileInitialAudioSubNav.value = 'input'
  profileFocusReturn.value = accountTrigger.value
  profileOpen.value = true
}

function openVoiceSettings(kind: 'input' | 'output', trigger: HTMLButtonElement) {
  profileInitialTab.value = 'audio'
  profileInitialAudioSubNav.value = kind
  profileFocusReturn.value = trigger
  profileOpen.value = true
}

function closeProfile() {
  profileOpen.value = false
  const target = profileFocusReturn.value ?? accountTrigger.value
  profileFocusReturn.value = null
  void nextTick(() => target?.focus())
}

function openLogoutDialog() {
  closeAccountMenu()
  logoutError.value = ''
  logoutOpen.value = true
}

function closeLogoutDialog() {
  if (loggingOut.value) return
  logoutOpen.value = false
  logoutError.value = ''
  void nextTick(() => accountTrigger.value?.focus())
}

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  logoutError.value = ''
  try {
    await voice.leave({ playLeaveSound: true })
    await app.logout()
  } catch (error) {
    logoutError.value = error instanceof Error ? error.message : '退出登录失败'
  } finally {
    loggingOut.value = false
  }
}

function openGuildActionMenu(guild: GuildSummary, trigger: HTMLElement, x: number, y: number, align: 'start' | 'end') {
  closeChannelActionMenu()
  guildActionMenu.value = { guild, trigger, x, y, align }
}

function openHeaderGuildActions(event: MouseEvent) {
  const guild = app.activeGuild
  const trigger = event.currentTarget as HTMLElement
  if (!guild) return
  if (guildActionMenu.value?.trigger === trigger) {
    closeGuildActionMenu(true)
    return
  }
  const bounds = trigger.getBoundingClientRect()
  const headerBounds = mobileQuery?.matches ? trigger.closest('.guild-title')?.getBoundingClientRect() : null
  openGuildActionMenu(guild, trigger, headerBounds ? headerBounds.right - 10 : bounds.right, (headerBounds?.bottom ?? bounds.bottom) + 4, 'end')
}

function openGuildContextMenu(guild: GuildSummary, event: MouseEvent) {
  openGuildActionMenu(guild, event.currentTarget as HTMLElement, event.clientX, event.clientY, 'start')
}

function openGuildKeyboardMenu(guild: GuildSummary, event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  openGuildActionMenu(guild, trigger, bounds.right + 4, bounds.top, 'start')
}

function closeGuildActionMenu(restoreFocus = false) {
  const trigger = guildActionMenu.value?.trigger
  guildActionMenu.value = null
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

async function openGuildAdmin(guild: GuildSummary) {
  const trigger = guildActionMenu.value?.trigger ?? null
  closeGuildActionMenu()
  const previousGuildId = app.activeGuildId
  try {
    if (guild.id !== previousGuildId) await app.selectGuild(guild.id)
  } catch (error) {
    try {
      if (previousGuildId !== null && app.guilds.some((item) => item.id === previousGuildId && item.joined)) await app.selectGuild(previousGuildId)
      else await app.bootstrap()
    } catch {
      // 保留原始切换错误。
    }
    window.alert(error instanceof Error ? error.message : '服务器加载失败')
    void nextTick(() => trigger?.focus())
    return
  }
  adminInitialTab.value = undefined
  adminInitialChannelId.value = null
  adminOpen.value = true
  channelsOpen.value = false
}

function openChannelActionMenu(channel: Channel, trigger: HTMLElement, x: number, y: number) {
  closeAccountMenu()
  closeGuildActionMenu()
  channelActionMenu.value = { channel, trigger, x, y }
}

function openTextChannelContextMenu(channel: Channel, event: MouseEvent) {
  openChannelActionMenu(channel, event.currentTarget as HTMLElement, event.clientX, event.clientY)
}

function openTextChannelKeyboardMenu(channel: Channel, event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  openChannelActionMenu(channel, trigger, bounds.right + 4, bounds.top)
}

function closeChannelActionMenu(restoreFocus = false) {
  const trigger = channelActionMenu.value?.trigger
  channelActionMenu.value = null
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

function showActionToast(message: string, type: 'success' | 'error') {
  if (actionToastTimer !== null) window.clearTimeout(actionToastTimer)
  actionToast.value = { message, type }
  actionToastTimer = window.setTimeout(() => {
    actionToast.value = null
    actionToastTimer = null
  }, 2000)
}

async function copyChannelName(channel: Channel) {
  closeChannelActionMenu(true)
  try {
    await navigator.clipboard.writeText(channel.name)
    showActionToast('频道名称已复制', 'success')
  } catch {
    showActionToast('复制失败，请重试', 'error')
  }
}

async function markChannelRead(channel: Channel) {
  closeChannelActionMenu(true)
  try {
    await app.markChannelRead(channel.id)
  } catch (error) {
    showActionToast(error instanceof Error ? error.message : '标记为已读失败，请重试', 'error')
  }
}

function editChannel(channel: Channel) {
  closeChannelActionMenu()
  adminInitialTab.value = 'channel'
  adminInitialChannelId.value = channel.id
  adminOpen.value = true
  channelsOpen.value = false
}

function closeGuildAdmin() {
  adminOpen.value = false
  adminInitialTab.value = undefined
  adminInitialChannelId.value = null
}

function openGuildPlatformManagement(guild: GuildSummary) {
  closeGuildActionMenu()
  openPlatformGuilds(guild.id)
  channelsOpen.value = false
}

function confirmLeaveGuild(guild: GuildSummary) {
  leaveDialogTrigger.value = guildActionMenu.value?.trigger ?? null
  closeGuildActionMenu()
  leaveGuildError.value = ''
  leaveTarget.value = guild
}

function closeLeaveGuildDialog() {
  if (leavingGuild.value) return
  const trigger = leaveDialogTrigger.value
  leaveTarget.value = null
  leaveGuildError.value = ''
  leaveDialogTrigger.value = null
  void nextTick(() => trigger?.focus())
}

function openPlatformAccounts() {
  platformOpen.value = false
  platformAdminOpen.value = true
}

async function leaveGuild() {
  const guild = leaveTarget.value
  if (!guild || guild.role === 'owner' || leavingGuild.value) return
  leavingGuild.value = true
  leaveGuildError.value = ''
  try {
    await request(`/api/guilds/${guild.id}/leave`, { method: 'POST' })
    if (voice.connectedGuildId === guild.id) {
      try {
        await voice.leave({ notifyGuild: false, playLeaveSound: true })
      } catch {
        // 后端已经清理目标服务器的语音参与者，继续刷新成员状态。
      }
    }
    await app.bootstrap()
    leaveTarget.value = null
    leaveDialogTrigger.value = null
    channelsOpen.value = false
  } catch (error) {
    leaveGuildError.value = error instanceof Error ? error.message : '离开服务器失败'
  } finally {
    leavingGuild.value = false
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
    <nav class="guild-rail" aria-label="服务器">
      <span class="rail-logo" title="Celery Web Speak"><img class="guild-icon" src="/favicon.svg" alt="" /></span>
      <span class="rail-status" :class="app.socketStatus" title="业务连接状态"><Radio :size="18" /></span>
      <span class="rail-divider" />
      <button v-if="app.isPlatformAdmin" class="guild-button platform-manage" type="button" title="平台服务器管理" @click="openPlatformGuilds()"><ServerCog :size="20" /></button>
      <span v-if="app.isPlatformAdmin" class="rail-divider" />
      <div class="rail-scroll">
        <button
          v-for="guild in app.guilds"
          :key="guild.id"
          :class="['guild-button', { active: guild.id === app.activeGuildId, 'metadata-only': !guild.joined }]"
          type="button"
          :title="guild.joined ? guild.name : `${guild.name}（仅管理信息）`"
          :aria-label="guild.joined ? guild.name : `${guild.name}（仅管理信息）`"
          @click="openGuild(guild)"
          @contextmenu.prevent="openGuildContextMenu(guild, $event)"
          @keydown="openGuildKeyboardMenu(guild, $event)"
        >
          <span class="guild-initial">{{ guild.name.trim().slice(0, 1).toUpperCase() }}</span>
          <span v-if="guild.unreadCount" class="guild-unread" />
        </button>
        <button v-if="app.isPlatformAdmin" class="guild-button add-guild" type="button" title="创建服务器" @click="openPlatformGuilds(null, true)"><Plus :size="22" /></button>
      </div>
      <div class="rail-account">
        <button
          ref="accountTrigger"
          class="account-trigger"
          type="button"
          title="用户账户"
          :aria-label="`${app.user!.displayName}的用户账户`"
          :aria-expanded="accountMenuOpen"
          aria-controls="account-menu"
          @click="toggleAccountMenu"
        ><UserAvatar :name="app.user!.displayName" :size="42" :online="true" /></button>
      </div>
    </nav>

    <aside :class="['channel-sidebar', { 'mobile-drawer-open': channelsOpen }]">
      <header class="guild-title">
        <span><strong>{{ app.activeGuild?.name ?? '尚未加入服务器' }}</strong><small v-if="!app.activeGuild">请联系服务器管理员</small></span>
        <button v-if="app.activeGuild" ref="guildActionTrigger" class="icon-button guild-actions-trigger" type="button" title="服务器操作" aria-label="服务器操作" :aria-expanded="guildActionMenu?.trigger === guildActionTrigger" @click="openHeaderGuildActions"><EllipsisVertical :size="20" /></button>
        <button v-if="app.isPlatformAdmin && !app.activeGuild" class="icon-button mobile-only" title="平台服务器管理" @click="openPlatformGuilds(); channelsOpen = false"><ServerCog :size="19" /></button>
        <button class="icon-button mobile-only" title="关闭" @click="channelsOpen = false"><X :size="19" /></button>
      </header>
      <div class="channel-scroll">
        <p v-if="!app.activeGuild" class="guild-empty">尚未加入任何服务器，请联系服务器管理员将你加入服务器。</p>
        <div v-if="app.activeGuild" class="category-heading"><span>语音频道</span></div>
        <VoiceChannel v-for="channel in app.voiceChannels" :key="channel.id" :channel="channel" @channel-menu="openChannelActionMenu" />
        <div v-if="app.activeGuild" class="category-heading"><span>文字频道</span></div>
        <button
          v-for="channel in app.textChannels"
          :key="channel.id"
          :class="['channel-row', { active: app.activeTextChannelId === channel.id }]"
          @click="selectTextChannel(channel.id)"
          @contextmenu.prevent="openTextChannelContextMenu(channel, $event)"
          @keydown="openTextChannelKeyboardMenu(channel, $event)"
        >
          <Hash :size="18" />
          <span class="channel-label"><strong>{{ channel.name }}</strong><small>最近 {{ channel.messageRetention }} 条</small></span>
          <span v-if="app.channelReadStates[channel.id]?.unreadCount" class="channel-unread">{{ app.channelReadStates[channel.id].unreadCount }}</span>
        </button>
      </div>
      <div v-if="voice.joined" class="voice-connection-panel">
        <div class="voice-connection-summary">
          <span class="connection-indicator" />
          <span>
            <strong>{{ voice.status === 'connecting' ? '正在连接' : voice.status === 'connected' ? '语音已连接' : '正在重连' }}</strong>
            <small class="voice-connection-detail">
              <span class="voice-connection-location">{{ voice.connectedGuildName }} / {{ voice.connectedChannelName }}</span>
              <span class="voice-connection-bitrate">· {{ voice.connectedAudioBitrateKbps }} kbps</span>
            </small>
          </span>
          <button
            class="icon-button danger voice-disconnect-button"
            type="button"
            :title="voice.status === 'connecting' ? '取消语音连接' : '断开语音'"
            :aria-label="voice.status === 'connecting' ? '取消语音连接' : '断开语音'"
            @click="voice.leave({ playLeaveSound: true })"
          ><LogOut :size="18" /></button>
        </div>
        <p v-if="voice.transmissionModeError" class="voice-control-error" role="alert">{{ voice.transmissionModeError }}</p>
      </div>
      <UserControls @settings="openVoiceSettings" />
    </aside>

    <ChatPane :members-visible="membersVisible" @channels="channelsOpen = true" @members="toggleMembers" />
    <MemberList />

    <div v-if="channelsOpen" class="drawer-scrim" @click="channelsOpen = false" />
    <div v-if="membersOpen" class="drawer-scrim member-scrim" @click="membersOpen = false">
      <MemberList :drawer="true" @close="membersOpen = false" @click.stop />
    </div>

    <div id="voice-audio-root" aria-hidden="true" />
    <GuildActionMenu
      v-if="guildActionMenu"
      :guild="guildActionMenu.guild"
      :is-platform-admin="app.isPlatformAdmin"
      :x="guildActionMenu.x"
      :y="guildActionMenu.y"
      :align="guildActionMenu.align"
      :trigger="guildActionMenu.trigger"
      @close="closeGuildActionMenu"
      @manage="openGuildAdmin"
      @platform="openGuildPlatformManagement"
      @leave="confirmLeaveGuild"
    />
    <ChannelActionMenu
      v-if="channelActionMenu"
      :channel="channelActionMenu.channel"
      :unread-count="app.channelReadStates[channelActionMenu.channel.id]?.unreadCount ?? 0"
      :can-manage="app.isGuildAdmin"
      :x="channelActionMenu.x"
      :y="channelActionMenu.y"
      :trigger="channelActionMenu.trigger"
      @close="closeChannelActionMenu"
      @copy="copyChannelName"
      @mark-read="markChannelRead"
      @edit="editChannel"
    />
    <div v-if="actionToast" class="action-toast" :class="actionToast.type" role="status" aria-live="polite">{{ actionToast.message }}</div>
    <AccountMenu v-if="accountMenuOpen" :trigger="accountTrigger" @close="closeAccountMenu" @settings="openProfile" @logout="openLogoutDialog" />
    <LeaveGuildDialog v-if="leaveTarget" :guild="leaveTarget" :busy="leavingGuild" :error="leaveGuildError" @cancel="closeLeaveGuildDialog" @confirm="leaveGuild" />
    <LogoutDialog v-if="logoutOpen" :busy="loggingOut" :error="logoutError" :voice-joined="voice.joined" @cancel="closeLogoutDialog" @confirm="logout" />
    <ProfilePanel
      v-if="profileOpen"
      :initial-tab="profileInitialTab"
      :initial-audio-sub-nav="profileInitialAudioSubNav"
      @close="closeProfile"
      @changelog="changelogOpen = true"
    />
    <GuildAdminPanel v-if="adminOpen" :initial-tab="adminInitialTab" :initial-channel-id="adminInitialChannelId" @close="closeGuildAdmin" />
    <PlatformAdminPanel v-if="platformAdminOpen" @close="platformAdminOpen = false" />
    <PlatformGuildsPanel v-if="platformOpen" :initial-guild-id="platformInitialGuildId" :create-on-open="platformCreateOnOpen" @accounts="openPlatformAccounts" @close="platformOpen = false" />
    <ChangelogModal v-if="changelogOpen" @close="closeChangelog" />
  </main>
</template>
