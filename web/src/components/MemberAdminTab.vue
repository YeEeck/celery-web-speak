<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref } from 'vue'
import { Ban, ShieldCheck, UserMinus, UserPlus } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { GuildRole, User } from '../types'
import { guildAdminContextKey } from './guild-admin-context'
import UserAvatar from './UserAvatar.vue'

const app = useAppStore()
const { busy, run } = inject(guildAdminContextKey)!
const selectedUserId = ref<number | null>(null)
const kickMinutes = ref(30)
const memberUsername = ref('')
const userDetail = ref<HTMLElement | null>(null)

const guildContext = computed(() => app.activeGuild)
const selectedUser = computed(() => app.users.find((user) => user.id === selectedUserId.value) ?? null)
const manageableUsers = computed(() => app.users.filter((user) => user.id !== app.user!.id))
const canManageRoles = computed(() => app.isPlatformAdmin || guildContext.value?.role === 'owner')

onMounted(() => {
  selectedUserId.value = manageableUsers.value[0]?.id ?? null
})

async function addMember() {
  if (!memberUsername.value.trim() || app.activeGuildId === null) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/members`, { method: 'POST', body: JSON.stringify({ username: memberUsername.value.trim() }) })
    memberUsername.value = ''
    await app.bootstrap()
    selectedUserId.value = manageableUsers.value.at(-1)?.id ?? null
  }, '成员已加入服务器')
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
</script>

<template>
  <section class="user-admin-layout">
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
</template>
