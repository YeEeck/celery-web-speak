<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Ban, Clipboard, Gauge, KeyRound, Plus, Save, ShieldCheck, Ticket, Trash2, UserCog, UserMinus, UserPlus, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { ChannelType, GuildRole, Invite, PlatformRole, User } from '../types'
import { rangeProgressStyle } from '../utils/range'
import UserAvatar from './UserAvatar.vue'

const props = defineProps<{ initialTab?: 'channel' | 'users' | 'invites'; platformMode?: boolean }>()
defineEmits<{ close: [] }>()
const app = useAppStore()
const tab = ref<'channel' | 'users' | 'invites'>(props.platformMode
  ? (props.initialTab === 'invites' ? 'invites' : 'users')
  : (props.initialTab === 'users' ? 'users' : 'channel'))
const selectedChannelId = ref<number | null>(app.channels[0]?.id ?? null)
const selectedChannel = computed(() => app.channels.find((channel) => channel.id === selectedChannelId.value) ?? null)
const channelName = ref(selectedChannel.value?.name ?? '')
const bitrate = ref(selectedChannel.value?.audioBitrateKbps ?? 64)
const backgroundBitrate = ref(selectedChannel.value?.backgroundAudioBitrateKbps ?? 128)
const audioRedEnabled = ref(selectedChannel.value?.audioRedEnabled ?? true)
const backgroundAudioRedEnabled = ref(selectedChannel.value?.backgroundAudioRedEnabled ?? false)
const retention = ref(selectedChannel.value?.messageRetention ?? 500)
const newChannelType = ref<ChannelType>('text')
const newChannelName = ref('')
const selectedUserId = ref<number | null>(null)
const kickMinutes = ref(30)
const resetPassword = ref('')
const invites = ref<Invite[]>([])
const inviteCursor = ref('')
const invitesHasMore = ref(false)
const loadingInvites = ref(false)
const generatedCode = ref('')
const inviteUses = ref(1)
const inviteDays = ref(7)
const newUsername = ref('')
const newDisplayName = ref('')
const newPassword = ref('')
const newRole = ref<PlatformRole>('member')
const memberUsername = ref('')
const guildName = ref('')
const message = ref('')
const errorMessage = ref('')
const busy = ref(false)
const adminContent = ref<HTMLElement | null>(null)
const userDetail = ref<HTMLElement | null>(null)
const deleteTarget = ref<User | null>(null)
const deleteConfirmation = ref('')
const deleteConfirmationInput = ref<HTMLInputElement | null>(null)
const platformUsers = ref<User[]>([])

const guildContext = computed(() => props.platformMode ? null : app.activeGuild)
const adminSubtitle = computed(() => {
  if (!guildContext.value) return '平台管理员'
  const guildRole = guildContext.value.role === 'owner' ? '服务器所有者' : '服务器管理员'
  return app.isPlatformAdmin ? `${guildRole} · 平台管理员` : guildRole
})
const userPool = computed(() => guildContext.value ? app.users : platformUsers.value)
const selectedUser = computed(() => userPool.value.find((user) => user.id === selectedUserId.value) ?? null)
const manageableUsers = computed(() => userPool.value.filter((user) => user.id !== app.user!.id))
const canManageRoles = computed(() => app.isPlatformAdmin || guildContext.value?.role === 'owner')
const canRenameGuild = computed(() => app.isPlatformAdmin || guildContext.value?.role === 'owner')

watch(guildContext, (guild) => {
  guildName.value = guild?.name ?? ''
}, { immediate: true })

watch(selectedChannel, (channel) => {
  channelName.value = channel?.name ?? ''
  bitrate.value = channel?.audioBitrateKbps ?? 64
  backgroundBitrate.value = channel?.backgroundAudioBitrateKbps ?? 128
  audioRedEnabled.value = channel?.audioRedEnabled ?? true
  backgroundAudioRedEnabled.value = channel?.backgroundAudioRedEnabled ?? false
  retention.value = channel?.messageRetention ?? 500
})

onMounted(async () => {
  if (props.platformMode) {
    try {
      await loadPlatformUsers()
      await loadInvites()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '邀请码加载失败'
    }
  }
  selectedUserId.value = manageableUsers.value[0]?.id ?? null
})

async function loadPlatformUsers() {
  const payload = await request<{ users: User[] }>('/api/platform/users')
  platformUsers.value = payload.users ?? []
}

async function run(action: () => Promise<void>, success: string) {
  busy.value = true
  message.value = ''
  errorMessage.value = ''
  try {
    await action()
    message.value = success
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败'
  } finally {
    busy.value = false
  }
}

async function addMember() {
  if (!memberUsername.value.trim() || app.activeGuildId === null) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/members`, { method: 'POST', body: JSON.stringify({ username: memberUsername.value.trim() }) })
    memberUsername.value = ''
    await app.bootstrap()
    selectedUserId.value = manageableUsers.value.at(-1)?.id ?? null
  }, '成员已加入服务器')
}

async function renameGuild() {
  const name = guildName.value.trim()
  if (!name || app.activeGuildId === null) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    await app.bootstrap()
  }, '服务器名称已更新')
}

async function saveSettings() {
  const channel = selectedChannel.value
  if (!channel) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/channels/${channel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: channelName.value,
        audioBitrateKbps: channel.type === 'voice' ? bitrate.value : 0,
        backgroundAudioBitrateKbps: channel.type === 'voice' ? backgroundBitrate.value : 0,
        audioRedEnabled: channel.type === 'voice' && audioRedEnabled.value,
        backgroundAudioRedEnabled: channel.type === 'voice' && backgroundAudioRedEnabled.value,
        messageRetention: channel.type === 'text' ? retention.value : 0,
      }),
    })
    await app.bootstrap()
  }, '频道设置已更新')
}

async function createChannel() {
  if (!newChannelName.value.trim()) return
  await run(async () => {
    const payload = await request<{ channel: { id: number } }>(`/api/guilds/${app.activeGuildId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ type: newChannelType.value, name: newChannelName.value }),
    })
    newChannelName.value = ''
    await app.bootstrap()
    selectedChannelId.value = payload.channel.id
  }, '频道已创建')
}

async function deleteChannel() {
  const channel = selectedChannel.value
  if (!channel || !window.confirm(`永久删除${channel.type === 'text' ? '文字' : '语音'}频道“${channel.name}”？此操作无法恢复。`)) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/channels/${channel.id}`, { method: 'DELETE' })
    await app.bootstrap()
    selectedChannelId.value = app.channels[0]?.id ?? null
  }, '频道已永久删除')
}

const moderationPermission = computed(() => {
  const target = selectedUser.value
  if (!guildContext.value || !target) return { allowed: false, reason: '' }
  if (target.role === 'owner') {
    return {
      allowed: false,
      reason: app.isPlatformAdmin
        ? '服务器所有者不能在成员管理中被审核；如需更换所有者，请使用所有权转让。'
        : '服务器管理员不能管理服务器所有者。',
    }
  }
  if (target.role === 'admin' && !app.isPlatformAdmin && guildContext.value.role !== 'owner') {
    return { allowed: false, reason: '服务器管理员不能管理其他管理员。' }
  }
  return { allowed: true, reason: '' }
})

async function setMute(kind: 'voice' | 'text', value: boolean) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    if (app.activeGuildId === null) return
    await request<{ member: unknown }>(`/api/guilds/${app.activeGuildId}/members/${target.id}/mute`, {
      method: 'PATCH',
      body: JSON.stringify({
        voiceMuted: kind === 'voice' ? value : target.voiceMuted,
        textMuted: kind === 'text' ? value : target.textMuted,
      }),
    })
    await app.bootstrap()
    selectedUserId.value = target.id
  }, value ? '禁言已生效' : '禁言已解除')
}

async function setRole(role: PlatformRole | GuildRole) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    if (!guildContext.value) {
      await request(`/api/platform/users/${target.id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) })
      await loadPlatformUsers()
    } else {
      if (app.activeGuildId === null) return
      await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: role === 'admin' ? 'admin' : 'member' }) })
      await app.bootstrap()
    }
    selectedUserId.value = target.id
  }, guildContext.value ? '服务器角色已更新' : '平台角色已更新')
}

async function kick() {
  const target = selectedUser.value
  if (!target) return
  const until = new Date(Date.now() + kickMinutes.value * 60_000).toISOString()
  await run(async () => {
    if (app.activeGuildId === null) return
    await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned: false, temporaryBanUntil: until }) })
    await app.bootstrap()
  }, `已将 ${target.displayName} 移出频道`)
}

async function clearTemporaryBan() {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    if (app.activeGuildId === null) return
    await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/temporary-ban`, { method: 'DELETE' })
    await app.bootstrap()
  }, '临时封禁已解除')
}

async function removeMember() {
  const target = selectedUser.value
  if (!target || app.activeGuildId === null || !window.confirm(`将 ${target.displayName} 移出当前服务器？历史消息会保留，之后可重新添加。`)) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/kick`, { method: 'POST' })
    await app.bootstrap()
    selectedUserId.value = manageableUsers.value[0]?.id ?? null
  }, '成员已移出服务器')
}

async function permanentBan(banned: boolean) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    if (!guildContext.value) {
      await request(`/api/platform/users/${target.id}/suspend`, { method: 'PATCH', body: JSON.stringify({ suspended: banned }) })
      await loadPlatformUsers()
    } else {
      await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned }) })
      await app.bootstrap()
    }
  }, banned ? (guildContext.value ? '服务器永久封禁已生效' : '平台账号已停用') : (guildContext.value ? '服务器永久封禁已解除' : '平台账号已恢复'))
}

async function doResetPassword() {
  const target = selectedUser.value
  if (!target || resetPassword.value.length < 10) return
  await run(async () => {
    await request(`/api/platform/users/${target.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: resetPassword.value }),
    })
    resetPassword.value = ''
  }, '密码已重置，该用户的其他会话已退出')
}

function openDeleteDialog(target: User) {
  errorMessage.value = ''
  deleteTarget.value = target
  deleteConfirmation.value = ''
  nextTick(() => deleteConfirmationInput.value?.focus())
}

function closeDeleteDialog() {
  if (busy.value) return
  deleteTarget.value = null
  deleteConfirmation.value = ''
}

async function deleteUser() {
  const target = deleteTarget.value
  if (!target || deleteConfirmation.value !== target.username) return
  await run(async () => {
    await request(`/api/platform/users/${target.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ username: deleteConfirmation.value }),
    })
    app.removeUser(target.id)
    if (!guildContext.value) platformUsers.value = platformUsers.value.filter((user) => user.id !== target.id)
    deleteTarget.value = null
    deleteConfirmation.value = ''
    selectedUserId.value = manageableUsers.value[0]?.id ?? null
  }, `账号 @${target.username} 已删除`)
}

async function createUser() {
  await run(async () => {
    await request('/api/platform/users', {
      method: 'POST',
      body: JSON.stringify({ username: newUsername.value, displayName: newDisplayName.value, password: newPassword.value, role: newRole.value }),
    })
    newUsername.value = ''
    newDisplayName.value = ''
    newPassword.value = ''
    newRole.value = 'member'
    await app.bootstrap()
    await loadPlatformUsers()
  }, '账号已创建')
}

async function loadInvites(reset = true) {
  if (loadingInvites.value) return
  loadingInvites.value = true
  try {
    const query = !reset && inviteCursor.value ? `?cursor=${encodeURIComponent(inviteCursor.value)}` : ''
    const payload = await request<{ invites: Invite[] | null; hasMore: boolean; nextCursor: string }>(`/api/platform/invites${query}`)
    const pageInvites = Array.isArray(payload.invites) ? payload.invites : []
    if (reset) {
      invites.value = pageInvites
    } else {
      const loadedIDs = new Set(invites.value.map((invite) => invite.id))
      invites.value.push(...pageInvites.filter((invite) => !loadedIDs.has(invite.id)))
    }
    inviteCursor.value = payload.nextCursor
    invitesHasMore.value = payload.hasMore
  } finally {
    loadingInvites.value = false
  }
}

async function createInvite() {
  await run(async () => {
    const expiresAt = new Date(Date.now() + inviteDays.value * 86_400_000).toISOString()
    const payload = await request<{ invite: Invite }>('/api/platform/invites', {
      method: 'POST',
      body: JSON.stringify({ maxUses: inviteUses.value, expiresAt }),
    })
    generatedCode.value = payload.invite.code ?? ''
    await loadInvites(true)
  }, '邀请码已生成')
}

async function loadMoreInvites() {
  await run(() => loadInvites(false), '更多邀请码已加载')
}

async function revokeInvite(invite: Invite) {
  if (!window.confirm(`确定撤销邀请码“${invite.code || `#${invite.id}`}”吗？`)) return
  await run(async () => {
    await request(`/api/platform/invites/${invite.id}`, { method: 'DELETE' })
    await loadInvites(true)
  }, '邀请码已撤销')
}

async function deleteInvite(invite: Invite) {
  if (!window.confirm(`永久删除邀请码“${invite.code || `#${invite.id}`}”？此操作无法恢复。`)) return
  await run(async () => {
    await request(`/api/platform/invites/${invite.id}/permanent`, { method: 'DELETE' })
    await loadInvites(true)
  }, '邀请码已永久删除')
}

async function copyCode(code: string) {
  await navigator.clipboard.writeText(code)
  message.value = '邀请码已复制'
}

type InviteStatus = 'active' | 'exhausted' | 'expired' | 'revoked'

function inviteStatus(invite: Invite): InviteStatus {
  if (invite.revokedAt) return 'revoked'
  if (invite.useCount >= invite.maxUses) return 'exhausted'
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'active'
}

function inviteStatusLabel(invite: Invite) {
  const labels = { active: '有效', exhausted: '已用完', expired: '已过期', revoked: '已撤销' }
  return labels[inviteStatus(invite)]
}

function roleLabel(user: User) {
  if (props.platformMode) return user.isPlatformAdmin ? '平台管理员' : '普通账号'
  return user.role === 'owner' ? '服务器所有者' : user.role === 'admin' ? '服务器管理员' : '普通成员'
}

function selectUser(userId: number) {
  if (selectedUserId.value === userId) return
  selectedUserId.value = userId
  nextTick(() => userDetail.value?.scrollTo({ top: 0 }))
}

function selectTab(nextTab: 'channel' | 'users' | 'invites') {
  if (tab.value === nextTab) return
  tab.value = nextTab
  nextTick(() => adminContent.value?.scrollTo({ top: 0 }))
}
</script>

<template>
  <div class="modal-backdrop admin-backdrop" @mousedown.self="$emit('close')">
    <section class="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <header class="panel-header">
        <div><h2 id="admin-title">{{ guildContext ? '服务器管理' : '平台管理' }}</h2><p>{{ adminSubtitle }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="admin-tabs">
        <button v-if="guildContext" :class="{ active: tab === 'channel' }" @click="selectTab('channel')"><Gauge :size="17" />频道</button>
        <button :class="{ active: tab === 'users' }" @click="selectTab('users')"><UserCog :size="17" />{{ guildContext ? '成员' : '平台账号' }}</button>
        <button v-if="platformMode" :class="{ active: tab === 'invites' }" @click="selectTab('invites')"><Ticket :size="17" />创建与邀请</button>
      </nav>

      <div ref="adminContent" :class="['admin-content', { 'users-content': tab === 'users' }]">
        <section v-if="tab === 'channel'" class="settings-section channel-settings">
          <template v-if="canRenameGuild">
            <h3>服务器设置</h3>
            <div class="guild-rename-row">
              <input v-model.trim="guildName" maxlength="64" aria-label="服务器名称" />
              <button class="secondary-button" :disabled="busy || !guildName || guildName === guildContext?.name" @click="renameGuild"><Save :size="16" />保存名称</button>
            </div>
          </template>
          <h3>创建频道</h3>
          <div class="channel-create-row">
            <select v-model="newChannelType" aria-label="频道类型"><option value="text">文字频道</option><option value="voice">语音频道</option></select>
            <input v-model.trim="newChannelName" maxlength="32" placeholder="频道名称" aria-label="新频道名称" @keydown.enter="createChannel" />
            <button class="primary-button" :disabled="busy || !newChannelName" @click="createChannel"><Plus :size="17" />创建</button>
          </div>
          <h3>频道设置</h3>
          <label><span>选择频道</span><select v-model.number="selectedChannelId"><option v-for="channel in app.channels" :key="channel.id" :value="channel.id">{{ channel.type === 'text' ? '#' : '语音' }} {{ channel.name }}</option></select></label>
          <template v-if="selectedChannel">
            <label><span>频道名称</span><input v-model.trim="channelName" maxlength="32" /></label>
            <label v-if="selectedChannel.type === 'voice'" class="range-setting">
              <span>Opus 发送码率 <strong>{{ bitrate }} kbps</strong></span>
              <input v-model.number="bitrate" type="range" min="32" max="128" step="8" :style="rangeProgressStyle(bitrate, 32, 128)" />
              <span class="range-labels"><small>32 kbps</small><small>128 kbps</small></span>
            </label>
            <label v-if="selectedChannel.type === 'voice'" class="range-setting">
              <span>背景音码率 <strong>{{ backgroundBitrate }} kbps</strong></span>
              <input v-model.number="backgroundBitrate" type="range" min="64" max="256" step="16" :style="rangeProgressStyle(backgroundBitrate, 64, 256)" />
              <span class="range-labels"><small>64 kbps</small><small>256 kbps</small></span>
            </label>
            <label v-if="selectedChannel.type === 'voice'" class="setting-toggle">
              <span>语音 RED 丢包冗余</span>
              <input v-model="audioRedEnabled" type="checkbox" aria-label="语音 RED 丢包冗余" />
            </label>
            <label v-if="selectedChannel.type === 'voice'" class="setting-toggle">
              <span>背景音 RED 丢包冗余</span>
              <input v-model="backgroundAudioRedEnabled" type="checkbox" aria-label="背景音 RED 丢包冗余" />
            </label>
            <label v-else><span>保留消息数量</span><input v-model.number="retention" type="number" min="100" max="5000" step="100" /></label>
            <div class="channel-admin-actions">
              <button class="primary-button" :disabled="busy || !channelName" @click="saveSettings"><Save :size="17" />保存频道设置</button>
              <button class="secondary-button danger-text" :disabled="busy" @click="deleteChannel"><Trash2 :size="16" />永久删除</button>
            </div>
          </template>
        </section>

        <section v-else-if="tab === 'users'" class="user-admin-layout">
          <aside class="admin-user-list">
            <form v-if="guildContext" class="member-add-form" @submit.prevent="addMember">
              <input v-model.trim="memberUsername" aria-label="成员完整登录名" placeholder="完整登录名" />
              <button class="icon-button" type="submit" title="添加成员" :disabled="busy || !memberUsername"><UserPlus :size="17" /></button>
            </form>
            <button
              v-for="member in manageableUsers"
              :key="member.id"
              :class="{ active: selectedUserId === member.id }"
              @click="selectUser(member.id)"
            >
              <UserAvatar :name="member.displayName" :size="32" />
              <span><strong>{{ member.displayName }}</strong><small>{{ roleLabel(member) }}</small></span>
            </button>
          </aside>
          <div v-if="selectedUser" ref="userDetail" class="user-admin-detail">
            <header><UserAvatar :name="selectedUser.displayName" :size="48" /><div><h3>{{ selectedUser.displayName }}</h3><p>@{{ selectedUser.username }}</p></div></header>
            <template v-if="guildContext && moderationPermission.allowed">
              <div class="toggle-list">
                <label><span>语音禁言</span><input type="checkbox" :checked="selectedUser.voiceMuted" @change="setMute('voice', ($event.target as HTMLInputElement).checked)" /></label>
                <label><span>文字禁言</span><input type="checkbox" :checked="selectedUser.textMuted" @change="setMute('text', ($event.target as HTMLInputElement).checked)" /></label>
              </div>
              <label><span>临时封禁服务器访问</span><span class="inline-actions"><select v-model.number="kickMinutes"><option :value="5">5 分钟</option><option :value="30">30 分钟</option><option :value="60">1 小时</option><option :value="1440">24 小时</option></select><button class="secondary-button danger-text" @click="kick">封禁</button></span></label>
              <button v-if="selectedUser.temporaryBanUntil" class="secondary-button" @click="clearTemporaryBan">解除临时封禁</button>
              <button :class="['secondary-button', { 'danger-text': !selectedUser.permanentlyBanned }]" @click="permanentBan(!selectedUser.permanentlyBanned)"><Ban :size="16" />{{ selectedUser.permanentlyBanned ? '解除服务器永久封禁' : '服务器永久封禁' }}</button>
              <button class="secondary-button danger-text" @click="removeMember"><UserMinus :size="16" />移出服务器</button>
            </template>
            <p v-else-if="guildContext && moderationPermission.reason" class="permission-note"><ShieldCheck :size="17" />{{ moderationPermission.reason }}</p>

            <template v-if="guildContext && canManageRoles && selectedUser.role !== 'owner'">
              <label><span>服务器角色</span><select :value="selectedUser.role" @change="setRole(($event.target as HTMLSelectElement).value as GuildRole)"><option value="member">普通成员</option><option value="admin">服务器管理员</option></select></label>
            </template>
            <template v-if="!guildContext">
              <label><span>平台角色</span><select :value="selectedUser.isPlatformAdmin ? 'platform_admin' : 'member'" @change="setRole(($event.target as HTMLSelectElement).value as PlatformRole)"><option value="member">普通账号</option><option value="platform_admin">平台管理员</option></select></label>
              <label><span>重置密码</span><span class="inline-actions"><input v-model="resetPassword" type="password" minlength="10" placeholder="至少 10 位" /><button class="secondary-button" :disabled="resetPassword.length < 10" @click="doResetPassword"><KeyRound :size="16" />重置</button></span></label>
              <button :class="['secondary-button', { 'danger-text': !selectedUser.permanentlyBanned }]" @click="permanentBan(!selectedUser.permanentlyBanned)"><Ban :size="16" />{{ selectedUser.permanentlyBanned ? '恢复平台账号' : '停用平台账号' }}</button>
              <div class="account-danger-zone">
                <div><strong>删除账号</strong><p>撤销登录并永久移除账号，历史消息将匿名保留。</p></div>
                <button class="secondary-button danger-text" @click="openDeleteDialog(selectedUser)"><Trash2 :size="16" />删除账号</button>
              </div>
            </template>
          </div>
        </section>

        <section v-else class="account-admin-grid">
          <form class="settings-section" @submit.prevent="createUser">
            <h3><UserPlus :size="18" />预先创建账号</h3>
            <label><span>登录名</span><input v-model.trim="newUsername" required minlength="3" maxlength="32" /></label>
            <label><span>显示名称</span><input v-model.trim="newDisplayName" required maxlength="32" /></label>
            <label><span>初始密码</span><input v-model="newPassword" required type="password" minlength="10" /></label>
            <label><span>平台角色</span><select v-model="newRole"><option value="member">普通账号</option><option value="platform_admin">平台管理员</option></select></label>
            <button class="primary-button" :disabled="busy"><UserPlus :size="17" />创建账号</button>
          </form>

          <section class="settings-section">
            <h3><Ticket :size="18" />邀请码</h3>
            <div class="two-column">
              <label><span>可使用次数</span><input v-model.number="inviteUses" type="number" min="1" max="1000" /></label>
              <label><span>有效天数</span><input v-model.number="inviteDays" type="number" min="1" max="365" /></label>
            </div>
            <button class="primary-button" :disabled="busy" @click="createInvite"><Ticket :size="17" />生成邀请码</button>
            <div v-if="generatedCode" class="generated-code"><code>{{ generatedCode }}</code><button class="icon-button" title="复制新邀请码" @click="copyCode(generatedCode)"><Clipboard :size="18" /></button></div>
            <div class="invite-list" aria-label="邀请码列表">
              <article v-for="invite in invites" :key="invite.id" :class="['invite-row', { inactive: inviteStatus(invite) !== 'active' }]">
                <div class="invite-row-heading">
                  <code v-if="invite.code">{{ invite.code }}</code>
                  <span v-else class="legacy-invite">旧邀请码 #{{ invite.id }}（原码不可恢复）</span>
                  <span :class="['invite-status', inviteStatus(invite)]">{{ inviteStatusLabel(invite) }}</span>
                </div>
                <div class="invite-row-details">
                  <span>{{ invite.useCount }} / {{ invite.maxUses }} 次</span>
                  <span>{{ new Date(invite.expiresAt).toLocaleString('zh-CN') }} 到期</span>
                  <span>{{ new Date(invite.createdAt).toLocaleString('zh-CN') }} 创建</span>
                </div>
                <div class="invite-actions">
                  <button v-if="invite.code" class="icon-button" title="复制邀请码" @click="copyCode(invite.code)"><Clipboard :size="17" /></button>
                  <button v-if="!invite.revokedAt" class="icon-button" title="撤销邀请码" @click="revokeInvite(invite)"><X :size="17" /></button>
                  <button class="icon-button danger" title="永久删除邀请码" @click="deleteInvite(invite)"><Trash2 :size="17" /></button>
                </div>
              </article>
              <p v-if="!loadingInvites && invites.length === 0" class="invite-empty">暂无邀请码</p>
            </div>
            <button v-if="invitesHasMore" class="secondary-button invite-load-more" :disabled="loadingInvites" @click="loadMoreInvites">{{ loadingInvites ? '正在加载' : '加载更多' }}</button>
          </section>
        </section>
      </div>
      <footer class="panel-footer"><span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span></footer>
      <div v-if="deleteTarget" class="account-delete-backdrop" @mousedown.self="closeDeleteDialog" @keydown.esc.stop="closeDeleteDialog">
        <section class="account-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="account-delete-title" aria-describedby="account-delete-description">
          <header>
            <div><h3 id="account-delete-title">永久删除账号？</h3><p id="account-delete-description">该操作无法恢复。账号会立即退出登录和语音，历史消息将显示为“已删除用户”。</p></div>
            <button class="icon-button" title="关闭" :disabled="busy" @click="closeDeleteDialog"><X :size="19" /></button>
          </header>
          <label>
            <span>输入登录名 <code>{{ deleteTarget.username }}</code> 以确认</span>
            <input ref="deleteConfirmationInput" v-model="deleteConfirmation" autocomplete="off" spellcheck="false" />
          </label>
          <p v-if="errorMessage" class="form-error">{{ errorMessage }}</p>
          <div class="account-delete-actions">
            <button class="secondary-button" :disabled="busy" @click="closeDeleteDialog">取消</button>
            <button class="account-delete-confirm" :disabled="busy || deleteConfirmation !== deleteTarget.username" @click="deleteUser"><Trash2 :size="16" />{{ busy ? '正在删除' : '永久删除' }}</button>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>
