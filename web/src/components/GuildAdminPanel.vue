<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Ban, Gauge, Plus, Save, ShieldCheck, Trash2, UserCog, UserMinus, UserPlus, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { ChannelType, GuildRole, User } from '../types'
import { rangeProgressStyle } from '../utils/range'
import UserAvatar from './UserAvatar.vue'

defineEmits<{ close: [] }>()
const app = useAppStore()
const tab = ref<'channel' | 'users'>('channel')
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
const memberUsername = ref('')
const guildName = ref('')
const message = ref('')
const errorMessage = ref('')
const busy = ref(false)
const adminContent = ref<HTMLElement | null>(null)
const userDetail = ref<HTMLElement | null>(null)

const guildContext = computed(() => app.activeGuild)
const adminSubtitle = computed(() => {
  const guildRole = guildContext.value?.role === 'owner' ? '服务器所有者' : '服务器管理员'
  return app.isPlatformAdmin ? `${guildRole} · 平台管理员` : guildRole
})
const selectedUser = computed(() => app.users.find((user) => user.id === selectedUserId.value) ?? null)
const manageableUsers = computed(() => app.users.filter((user) => user.id !== app.user!.id))
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

onMounted(() => {
  selectedUserId.value = manageableUsers.value[0]?.id ?? null
})

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

async function setRole(role: GuildRole) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    if (app.activeGuildId === null) return
    await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) })
    await app.bootstrap()
    selectedUserId.value = target.id
  }, '服务器角色已更新')
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
    await request(`/api/guilds/${app.activeGuildId}/members/${target.id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned }) })
    await app.bootstrap()
  }, banned ? '服务器永久封禁已生效' : '服务器永久封禁已解除')
}

function roleLabel(user: User) {
  return user.role === 'owner' ? '服务器所有者' : user.role === 'admin' ? '服务器管理员' : '普通成员'
}

function selectUser(userId: number) {
  if (selectedUserId.value === userId) return
  selectedUserId.value = userId
  nextTick(() => userDetail.value?.scrollTo({ top: 0 }))
}

function selectTab(nextTab: 'channel' | 'users') {
  if (tab.value === nextTab) return
  tab.value = nextTab
  nextTick(() => adminContent.value?.scrollTo({ top: 0 }))
}
</script>

<template>
  <div class="modal-backdrop admin-backdrop" @mousedown.self="$emit('close')">
    <section class="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <header class="panel-header">
        <div><h2 id="admin-title">服务器管理</h2><p>{{ adminSubtitle }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="admin-tabs">
        <button :class="{ active: tab === 'channel' }" @click="selectTab('channel')"><Gauge :size="17" />频道</button>
        <button :class="{ active: tab === 'users' }" @click="selectTab('users')"><UserCog :size="17" />成员</button>
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

        <section v-else class="user-admin-layout">
          <aside class="admin-user-list">
            <form class="member-add-form" @submit.prevent="addMember">
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
            <template v-if="moderationPermission.allowed">
              <div class="toggle-list">
                <label><span>语音禁言</span><input type="checkbox" :checked="selectedUser.voiceMuted" @change="setMute('voice', ($event.target as HTMLInputElement).checked)" /></label>
                <label><span>文字禁言</span><input type="checkbox" :checked="selectedUser.textMuted" @change="setMute('text', ($event.target as HTMLInputElement).checked)" /></label>
              </div>
              <label><span>临时封禁服务器访问</span><span class="inline-actions"><select v-model.number="kickMinutes"><option :value="5">5 分钟</option><option :value="30">30 分钟</option><option :value="60">1 小时</option><option :value="1440">24 小时</option></select><button class="secondary-button danger-text" @click="kick">封禁</button></span></label>
              <button v-if="selectedUser.temporaryBanUntil" class="secondary-button" @click="clearTemporaryBan">解除临时封禁</button>
              <button :class="['secondary-button', { 'danger-text': !selectedUser.permanentlyBanned }]" @click="permanentBan(!selectedUser.permanentlyBanned)"><Ban :size="16" />{{ selectedUser.permanentlyBanned ? '解除服务器永久封禁' : '服务器永久封禁' }}</button>
              <button class="secondary-button danger-text" @click="removeMember"><UserMinus :size="16" />移出服务器</button>
            </template>
            <p v-else-if="moderationPermission.reason" class="permission-note"><ShieldCheck :size="17" />{{ moderationPermission.reason }}</p>

            <template v-if="canManageRoles && selectedUser.role !== 'owner'">
              <label><span>服务器角色</span><select :value="selectedUser.role" @change="setRole(($event.target as HTMLSelectElement).value as GuildRole)"><option value="member">普通成员</option><option value="admin">服务器管理员</option></select></label>
            </template>
          </div>
        </section>
      </div>
      <footer class="panel-footer"><span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span></footer>
    </section>
  </div>
</template>
