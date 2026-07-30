<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EllipsisVertical, Hash, LogOut, Plus, Radio, ServerCog, X } from '@lucide/vue'
import AccountMenu from './AccountMenu.vue'
import ChannelActionMenu from './ChannelActionMenu.vue'
import MessageActionMenu from './MessageActionMenu.vue'
import GuildAdminPanel from './GuildAdminPanel.vue'
import PlatformAdminPanel from './PlatformAdminPanel.vue'
import ChangelogModal from './ChangelogModal.vue'
import ChatPane from './ChatPane.vue'
import LeaveGuildDialog from './LeaveGuildDialog.vue'
import LogoutDialog from './LogoutDialog.vue'
import MemberList from './MemberList.vue'
import PlatformGuildsPanel from './PlatformGuildsPanel.vue'
import ProfileCard from './ProfileCard.vue'
import ProfilePanel from './ProfilePanel.vue'
import GuildActionMenu from './GuildActionMenu.vue'
import GuildIcon from './GuildIcon.vue'
import UserControls from './UserControls.vue'
import UserAvatar from './UserAvatar.vue'
import VoiceChannel from './VoiceChannel.vue'
import VoiceParticipantActionMenu from './VoiceParticipantActionMenu.vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { useVoiceStore, type VoiceParticipant } from '../stores/voice'
import { useVoiceShortcuts } from '../stores/voice-shortcuts'
import type { Channel, GuildSummary, Message, UserProfile, User, VersionResponse } from '../types'

const LAST_SEEN_VERSION_KEY = 'cws.lastSeenVersion'

const app = useAppStore()
const voice = useVoiceStore()
const toast = useToastStore()
useVoiceShortcuts()
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
const messageActionMenu = ref<{
  message: Message
  x: number
  y: number
  trigger: HTMLElement | null
} | null>(null)
const voiceParticipantActionMenu = ref<{
  guildId: number
  channelId: number
  userId: number
  x: number
  y: number
  trigger: HTMLElement | null
} | null>(null)
const participantManagementPending = ref(false)
const profileCard = ref<{ userId: number; x: number; y: number; trigger: HTMLElement | null; onClose: (() => void) | null } | null>(null)
const profileCardData = ref<UserProfile | null>(null)
const profileCardLoading = ref(false)
const profileCardFailed = ref(false)
let profileCardVersion = 0
const profileCardMember = computed(() => {
  if (!profileCard.value) return null
  return app.users.find((user) => user.id === profileCard.value!.userId) ?? null
})
const accountTrigger = ref<HTMLButtonElement | null>(null)
const accountMenuOpen = ref(false)
const logoutOpen = ref(false)
const loggingOut = ref(false)
const currentVersion = ref('')
let wideMemberQuery: MediaQueryList | null = null
let mobileQuery: MediaQueryList | null = null

const membersVisible = computed(() => wideMemberLayout.value ? desktopMembersVisible.value : membersOpen.value)
const voiceParticipantMenuTarget = computed(() => {
  const menu = voiceParticipantActionMenu.value
  if (!menu || voice.connectedGuildId !== menu.guildId || voice.connectedChannelId !== menu.channelId) return null
  return voice.participants.find((participant) => !participant.isLocal && participant.userId === menu.userId) ?? null
})
const voiceParticipantMenuMember = computed(() => {
  const target = voiceParticipantMenuTarget.value
  return target ? app.users.find((member) => member.id === target.userId) ?? null : null
})
const canManageVoiceParticipant = computed(() => {
  const target = voiceParticipantMenuMember.value
  const guild = app.activeGuild
  if (!target || !guild || !app.isGuildAdmin || target.id === app.user?.id || target.role === 'owner') return false
  return target.role !== 'admin' || app.isPlatformAdmin || guild.role === 'owner'
})

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
watch(() => app.activeGuildId, () => {
  closeGuildActionMenu()
  closeChannelActionMenu()
  closeMessageActionMenu()
  closeVoiceParticipantActionMenu()
  closeProfileCard()
})
watch(() => channelActionMenu.value === null || app.channels.some((channel) => channel.id === channelActionMenu.value?.channel.id), (exists) => {
  if (!exists) closeChannelActionMenu()
})
watch(() => app.activeTextChannelId, () => {
  closeMessageActionMenu()
})
watch(() => messageActionMenu.value === null || app.messages.some((message) => message.id === messageActionMenu.value?.message.id), (exists) => {
  if (!exists) closeMessageActionMenu()
})
watch(voiceParticipantMenuTarget, (target) => {
  if (!target && voiceParticipantActionMenu.value) closeVoiceParticipantActionMenu()
})
watch(() => app.moderatorVoiceDisconnect, (event) => {
  if (!event || !voice.handleModeratorDisconnect(event.guildId, event.channelId)) return
  toast.showWarning('你已被服务器管理员断开语音')
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
  closeVoiceParticipantActionMenu()
  closeProfileCard()
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
  closeChannelActionMenu()
  closeMessageActionMenu()
  closeVoiceParticipantActionMenu()
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
  logoutOpen.value = true
}

function closeLogoutDialog() {
  if (loggingOut.value) return
  logoutOpen.value = false
  void nextTick(() => accountTrigger.value?.focus())
}

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await voice.leave({ intent: 'active' })
    await app.logout()
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '退出登录失败')
  } finally {
    loggingOut.value = false
  }
}

function openGuildActionMenu(guild: GuildSummary, trigger: HTMLElement, x: number, y: number, align: 'start' | 'end') {
  closeChannelActionMenu()
  closeMessageActionMenu()
  closeVoiceParticipantActionMenu()
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
  closeMessageActionMenu()
  closeVoiceParticipantActionMenu()
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

function openMessageActionMenu(message: Message, trigger: HTMLElement | null, x: number, y: number) {
  closeAccountMenu()
  closeGuildActionMenu()
  closeChannelActionMenu()
  closeVoiceParticipantActionMenu()
  messageActionMenu.value = { message, trigger, x, y }
}

function closeMessageActionMenu() {
  messageActionMenu.value = null
}

const messageMenuCanDelete = computed(() => {
  const menu = messageActionMenu.value
  if (!menu) return false
  return app.isGuildAdmin || menu.message.userId === app.user?.id
})

async function copyMessageText(message: Message) {
  closeMessageActionMenu()
  try {
    await navigator.clipboard.writeText(message.content)
    toast.showSuccess('文本已复制')
  } catch {
    toast.showError('复制失败，请重试')
  }
}

async function deleteMenuMessage(message: Message) {
  closeMessageActionMenu()
  const guildId = app.activeGuildId
  if (guildId === null) return
  try {
    await request<void>(`/api/guilds/${guildId}/channels/${message.channelId}/messages/${message.id}`, { method: 'DELETE' })
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '删除消息失败')
  }
}

function openVoiceParticipantActionMenu(channel: Channel, participant: VoiceParticipant, trigger: HTMLElement, x: number, y: number) {
  if (participant.isLocal || voice.connectedGuildId === null || voice.connectedChannelId !== channel.id) return
  if (voiceParticipantActionMenu.value?.userId === participant.userId) {
    closeVoiceParticipantActionMenu(true)
    return
  }
  closeAccountMenu()
  closeGuildActionMenu()
  closeChannelActionMenu()
  closeMessageActionMenu()
  voiceParticipantActionMenu.value = {
    guildId: voice.connectedGuildId,
    channelId: channel.id,
    userId: participant.userId,
    x,
    y,
    trigger,
  }
}

function closeVoiceParticipantActionMenu(restoreFocus = false) {
  const trigger = voiceParticipantActionMenu.value?.trigger
  voiceParticipantActionMenu.value = null
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

async function setParticipantServerMute(participant: VoiceParticipant, muted: boolean) {
  const menu = voiceParticipantActionMenu.value
  const member = voiceParticipantMenuMember.value
  if (!menu || !member || participantManagementPending.value) return
  participantManagementPending.value = true
  closeVoiceParticipantActionMenu(true)
  try {
    await request(`/api/guilds/${menu.guildId}/members/${participant.userId}/mute`, {
      method: 'PATCH',
      body: JSON.stringify({ voiceMuted: muted, textMuted: member.textMuted }),
    })
    toast.showSuccess(muted ? `已对 ${participant.name} 启用服务器语音禁言` : `已解除 ${participant.name} 的服务器语音禁言`)
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '服务器语音禁言操作失败')
  } finally {
    participantManagementPending.value = false
  }
}

async function disconnectVoiceParticipant(participant: VoiceParticipant) {
  const menu = voiceParticipantActionMenu.value
  if (!menu || participantManagementPending.value) return
  participantManagementPending.value = true
  closeVoiceParticipantActionMenu(true)
  try {
    await request(`/api/guilds/${menu.guildId}/channels/${menu.channelId}/voice/participants/${participant.userId}/disconnect`, { method: 'POST' })
    toast.showSuccess(`已断开 ${participant.name} 的语音`)
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '断开语音失败')
  } finally {
    participantManagementPending.value = false
  }
}

function openProfileCard(userId: number, trigger: HTMLElement, x: number, y: number, onClose: (() => void) | null) {
  if (profileCard.value?.userId === userId) {
    closeProfileCard(true)
    return
  }
  closeAccountMenu()
  closeGuildActionMenu()
  closeChannelActionMenu()
  closeMessageActionMenu()
  closeVoiceParticipantActionMenu()
  profileCard.value = { userId, x, y, trigger, onClose }
  profileCardData.value = null
  profileCardFailed.value = false
  profileCardLoading.value = true
  const version = ++profileCardVersion
  void fetchProfileCard(userId, version)
}

async function fetchProfileCard(userId: number, version: number) {
  try {
    const result = await request<{ profile: UserProfile }>(`/api/users/${userId}/profile`)
    if (version !== profileCardVersion) return
    profileCardData.value = result.profile
    profileCardFailed.value = false
  } catch {
    if (version !== profileCardVersion) return
    profileCardFailed.value = true
  } finally {
    if (version === profileCardVersion) profileCardLoading.value = false
  }
}

function closeProfileCard(restoreFocus = false) {
  const trigger = profileCard.value?.trigger
  profileCard.value?.onClose?.()
  if (profileCard.value) profileCard.value.onClose = null
  ++profileCardVersion
  profileCard.value = null
  profileCardData.value = null
  profileCardLoading.value = false
  profileCardFailed.value = false
  if (restoreFocus) void nextTick(() => trigger?.focus())
}

function openMemberCard(user: User, trigger: HTMLElement, x: number, y: number, onClose: () => void) {
  openProfileCard(user.id, trigger, x, y, onClose)
}

function openVoiceParticipantCard(_channel: Channel, participant: VoiceParticipant, trigger: HTMLElement, x: number, y: number, onClose: () => void) {
  openProfileCard(participant.userId, trigger, x, y, onClose)
}

function openProfileFromMessage(userId: number, trigger: HTMLElement | null, x: number, y: number) {
  openProfileCard(userId, trigger ?? (document.activeElement as HTMLElement) ?? null, x, y, null)
}

async function copyChannelName(channel: Channel) {
  closeChannelActionMenu(true)
  try {
    await navigator.clipboard.writeText(channel.name)
    toast.showSuccess('频道名称已复制')
  } catch {
    toast.showError('复制失败，请重试')
  }
}

async function markChannelRead(channel: Channel) {
  closeChannelActionMenu(true)
  try {
    await app.markChannelRead(channel.id)
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '标记为已读失败，请重试')
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
  leaveTarget.value = guild
}

function closeLeaveGuildDialog() {
  if (leavingGuild.value) return
  const trigger = leaveDialogTrigger.value
  leaveTarget.value = null
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
  try {
    await request(`/api/guilds/${guild.id}/leave`, { method: 'POST' })
    if (voice.connectedGuildId === guild.id) {
      try {
        await voice.leave({ notifyGuild: false, intent: 'active' })
      } catch {
        // 后端已经清理目标服务器的语音参与者，继续刷新成员状态。
      }
    }
    await app.bootstrap()
    leaveTarget.value = null
    leaveDialogTrigger.value = null
    channelsOpen.value = false
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '离开服务器失败')
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
          <GuildIcon :name="guild.name" :guild="guild" />
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
        ><UserAvatar :name="app.user!.displayName" :size="42" :online="true" :user="app.user ?? undefined" /></button>
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
        <VoiceChannel
          v-for="channel in app.voiceChannels"
          :key="channel.id"
          :channel="channel"
          :action-menu-user-id="voiceParticipantActionMenu?.channelId === channel.id ? voiceParticipantActionMenu.userId : null"
          @channel-menu="openChannelActionMenu"
          @participant-menu="openVoiceParticipantActionMenu"
          @participant-card="openVoiceParticipantCard"
        />
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
            @click="voice.leave({ intent: 'active' })"
          ><LogOut :size="18" /></button>
        </div>
        <p v-if="voice.transmissionModeError" class="voice-control-error" role="alert">{{ voice.transmissionModeError }}</p>
      </div>
      <UserControls @settings="openVoiceSettings" />
    </aside>

    <ChatPane :members-visible="membersVisible" @channels="channelsOpen = true" @members="toggleMembers" @message-menu="openMessageActionMenu" @open-profile="openProfileFromMessage" />
    <MemberList @open-member="openMemberCard" />

    <div v-if="channelsOpen" class="drawer-scrim" @click="channelsOpen = false" />
    <div v-if="membersOpen" class="drawer-scrim member-scrim" @click="membersOpen = false">
      <MemberList :drawer="true" @close="membersOpen = false" @open-member="openMemberCard" @click.stop />
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
    <MessageActionMenu
      v-if="messageActionMenu"
      :message="messageActionMenu.message"
      :can-delete="messageMenuCanDelete"
      :x="messageActionMenu.x"
      :y="messageActionMenu.y"
      :trigger="messageActionMenu.trigger"
      @close="closeMessageActionMenu"
      @copy="copyMessageText"
      @delete="deleteMenuMessage"
    />
    <VoiceParticipantActionMenu
      v-if="voiceParticipantActionMenu && voiceParticipantMenuTarget"
      :participant="voiceParticipantMenuTarget"
      :member="voiceParticipantMenuMember"
      :can-manage="canManageVoiceParticipant"
      :management-pending="participantManagementPending"
      :x="voiceParticipantActionMenu.x"
      :y="voiceParticipantActionMenu.y"
      :trigger="voiceParticipantActionMenu.trigger"
      @close="closeVoiceParticipantActionMenu"
      @server-mute="setParticipantServerMute"
      @disconnect="disconnectVoiceParticipant"
    />
    <ProfileCard
      v-if="profileCard"
      :user-id="profileCard.userId"
      :profile="profileCardData"
      :member="profileCardMember"
      :loading="profileCardLoading"
      :failed="profileCardFailed"
      :x="profileCard.x"
      :y="profileCard.y"
      :trigger="profileCard.trigger"
      :is-self="profileCard.userId === app.user?.id"
      @close="closeProfileCard"
    />
    <div class="action-toast-stack" role="region" aria-live="polite" aria-label="操作反馈">
      <div v-for="item in toast.toasts" :key="item.id" :class="['action-toast', item.type]" role="status" @mouseenter="toast.pause(item.id)" @mouseleave="toast.resume(item.id)">
        <span>{{ item.message }}</span>
        <button class="action-toast-close" type="button" title="关闭" aria-label="关闭提示" @click="toast.dismiss(item.id)"><X :size="14" /></button>
      </div>
    </div>
    <AccountMenu v-if="accountMenuOpen" :trigger="accountTrigger" @close="closeAccountMenu" @settings="openProfile" @logout="openLogoutDialog" />
    <LeaveGuildDialog v-if="leaveTarget" :guild="leaveTarget" :busy="leavingGuild" @cancel="closeLeaveGuildDialog" @confirm="leaveGuild" />
    <LogoutDialog v-if="logoutOpen" :busy="loggingOut" :voice-joined="voice.joined" @cancel="closeLogoutDialog" @confirm="logout" />
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
