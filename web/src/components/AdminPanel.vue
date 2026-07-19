<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { Ban, Check, Clipboard, Gauge, KeyRound, Save, ShieldCheck, Ticket, UserCog, UserPlus, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { Invite, Role, User } from '../types'
import UserAvatar from './UserAvatar.vue'

defineEmits<{ close: [] }>()
const app = useAppStore()
const tab = ref<'channel' | 'users' | 'invites'>('channel')
const bitrate = ref(app.settings.audioBitrateKbps)
const retention = ref(app.settings.messageRetention)
const selectedUserId = ref<number | null>(null)
const kickMinutes = ref(30)
const resetPassword = ref('')
const invites = ref<Invite[]>([])
const generatedCode = ref('')
const inviteUses = ref(1)
const inviteDays = ref(7)
const newUsername = ref('')
const newDisplayName = ref('')
const newPassword = ref('')
const newRole = ref<Role>('member')
const message = ref('')
const errorMessage = ref('')
const busy = ref(false)
const userDetail = ref<HTMLElement | null>(null)

const selectedUser = computed(() => app.users.find((user) => user.id === selectedUserId.value) ?? null)
const manageableUsers = computed(() => app.users.filter((user) => user.id !== app.user!.id))

onMounted(async () => {
  selectedUserId.value = manageableUsers.value[0]?.id ?? null
  if (app.isServerAdmin) await loadInvites()
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

async function saveSettings() {
  await run(async () => {
    await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ audioBitrateKbps: bitrate.value, messageRetention: retention.value }),
    })
  }, '频道设置已更新')
}

function canModerate(user: User) {
  return app.user!.role === 'server_admin' || user.role === 'member'
}

async function setMute(kind: 'voice' | 'text', value: boolean) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    const result = await request<{ user: User }>(`/api/admin/users/${target.id}/mute`, {
      method: 'PATCH',
      body: JSON.stringify({
        voiceMuted: kind === 'voice' ? value : target.voiceMuted,
        textMuted: kind === 'text' ? value : target.textMuted,
      }),
    })
    await app.bootstrap()
    selectedUserId.value = result.user.id
  }, value ? '禁言已生效' : '禁言已解除')
}

async function setRole(role: Role) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    await request(`/api/admin/users/${target.id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) })
    await app.bootstrap()
  }, '管理员级别已更新')
}

async function kick() {
  const target = selectedUser.value
  if (!target) return
  const until = new Date(Date.now() + kickMinutes.value * 60_000).toISOString()
  await run(async () => {
    await request(`/api/admin/users/${target.id}/kick`, {
      method: 'POST',
      body: JSON.stringify({ until, reason: '由管理员移出频道' }),
    })
    await app.bootstrap()
  }, `已将 ${target.displayName} 移出频道`)
}

async function clearTemporaryBan() {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    await request(`/api/admin/users/${target.id}/temporary-ban`, { method: 'DELETE' })
    await app.bootstrap()
  }, '临时封禁已解除')
}

async function permanentBan(banned: boolean) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    await request(`/api/admin/users/${target.id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned }) })
    await app.bootstrap()
  }, banned ? '账号已永久封禁' : '永久封禁已解除')
}

async function doResetPassword() {
  const target = selectedUser.value
  if (!target || resetPassword.value.length < 10) return
  await run(async () => {
    await request(`/api/admin/users/${target.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: resetPassword.value }),
    })
    resetPassword.value = ''
  }, '密码已重置，该用户的其他会话已退出')
}

async function createUser() {
  await run(async () => {
    await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: newUsername.value, displayName: newDisplayName.value, password: newPassword.value, role: newRole.value }),
    })
    newUsername.value = ''
    newDisplayName.value = ''
    newPassword.value = ''
    await app.bootstrap()
  }, '账号已创建')
}

async function loadInvites() {
  const payload = await request<{ invites: Invite[] }>('/api/admin/invites')
  invites.value = payload.invites
}

async function createInvite() {
  await run(async () => {
    const expiresAt = new Date(Date.now() + inviteDays.value * 86_400_000).toISOString()
    const payload = await request<{ invite: Invite }>('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ maxUses: inviteUses.value, expiresAt }),
    })
    generatedCode.value = payload.invite.code ?? ''
    await loadInvites()
  }, '邀请码已生成')
}

async function revokeInvite(id: number) {
  await run(async () => {
    await request(`/api/admin/invites/${id}`, { method: 'DELETE' })
    await loadInvites()
  }, '邀请码已撤销')
}

async function copyCode() {
  await navigator.clipboard.writeText(generatedCode.value)
  message.value = '邀请码已复制'
}

function roleLabel(role: Role) {
  return role === 'server_admin' ? '服务器管理员' : role === 'channel_admin' ? '频道管理员' : '普通成员'
}

function selectUser(userId: number) {
  if (selectedUserId.value === userId) return
  selectedUserId.value = userId
  nextTick(() => userDetail.value?.scrollTo({ top: 0 }))
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="$emit('close')">
    <section :class="['admin-panel', { 'users-panel': tab === 'users' }]" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <header class="panel-header">
        <div><h2 id="admin-title">管理控制台</h2><p>{{ app.user!.role === 'server_admin' ? '服务器管理员' : '频道管理员' }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="admin-tabs">
        <button :class="{ active: tab === 'channel' }" @click="tab = 'channel'"><Gauge :size="17" />频道</button>
        <button :class="{ active: tab === 'users' }" @click="tab = 'users'"><UserCog :size="17" />成员</button>
        <button v-if="app.isServerAdmin" :class="{ active: tab === 'invites' }" @click="tab = 'invites'"><Ticket :size="17" />账号与邀请</button>
      </nav>

      <div :class="['admin-content', { 'users-content': tab === 'users' }]">
        <section v-if="tab === 'channel'" class="settings-section channel-settings">
          <h3>语音质量</h3>
          <label class="range-setting">
            <span>Opus 发送码率 <strong>{{ bitrate }} kbps</strong></span>
            <input v-model.number="bitrate" type="range" min="32" max="128" step="8" />
            <span class="range-labels"><small>32 kbps</small><small>128 kbps</small></span>
          </label>
          <h3>文字消息</h3>
          <label><span>保留消息数量</span><input v-model.number="retention" type="number" min="100" max="5000" step="100" /></label>
          <button class="primary-button" :disabled="busy" @click="saveSettings"><Save :size="17" />保存频道设置</button>
        </section>

        <section v-else-if="tab === 'users'" class="user-admin-layout">
          <aside class="admin-user-list">
            <button
              v-for="member in manageableUsers"
              :key="member.id"
              :class="{ active: selectedUserId === member.id }"
              @click="selectUser(member.id)"
            >
              <UserAvatar :name="member.displayName" :size="32" />
              <span><strong>{{ member.displayName }}</strong><small>{{ roleLabel(member.role) }}</small></span>
            </button>
          </aside>
          <div v-if="selectedUser" ref="userDetail" class="user-admin-detail">
            <header><UserAvatar :name="selectedUser.displayName" :size="48" /><div><h3>{{ selectedUser.displayName }}</h3><p>@{{ selectedUser.username }}</p></div></header>
            <template v-if="canModerate(selectedUser)">
              <div class="toggle-list">
                <label><span>语音禁言</span><input type="checkbox" :checked="selectedUser.voiceMuted" @change="setMute('voice', ($event.target as HTMLInputElement).checked)" /></label>
                <label><span>文字禁言</span><input type="checkbox" :checked="selectedUser.textMuted" @change="setMute('text', ($event.target as HTMLInputElement).checked)" /></label>
              </div>
              <label><span>移出频道并临时封禁</span><span class="inline-actions"><select v-model.number="kickMinutes"><option :value="5">5 分钟</option><option :value="30">30 分钟</option><option :value="60">1 小时</option><option :value="1440">24 小时</option></select><button class="secondary-button danger-text" @click="kick">移出</button></span></label>
              <button v-if="selectedUser.temporaryBanUntil" class="secondary-button" @click="clearTemporaryBan">解除临时封禁</button>
            </template>
            <p v-else class="permission-note"><ShieldCheck :size="17" />频道管理员不能管理其他管理员。</p>

            <template v-if="app.isServerAdmin">
              <label><span>管理员级别</span><select :value="selectedUser.role" @change="setRole(($event.target as HTMLSelectElement).value as Role)"><option value="member">普通成员</option><option value="channel_admin">频道管理员</option><option value="server_admin">服务器管理员</option></select></label>
              <label><span>重置密码</span><span class="inline-actions"><input v-model="resetPassword" type="password" minlength="10" placeholder="至少 10 位" /><button class="secondary-button" :disabled="resetPassword.length < 10" @click="doResetPassword"><KeyRound :size="16" />重置</button></span></label>
              <button :class="['secondary-button', { 'danger-text': !selectedUser.permanentlyBanned }]" @click="permanentBan(!selectedUser.permanentlyBanned)"><Ban :size="16" />{{ selectedUser.permanentlyBanned ? '解除永久封禁' : '永久封禁账号' }}</button>
            </template>
          </div>
        </section>

        <section v-else class="account-admin-grid">
          <form class="settings-section" @submit.prevent="createUser">
            <h3><UserPlus :size="18" />预先创建账号</h3>
            <label><span>登录名</span><input v-model.trim="newUsername" required minlength="3" maxlength="32" /></label>
            <label><span>显示名称</span><input v-model.trim="newDisplayName" required maxlength="32" /></label>
            <label><span>初始密码</span><input v-model="newPassword" required type="password" minlength="10" /></label>
            <label><span>角色</span><select v-model="newRole"><option value="member">普通成员</option><option value="channel_admin">频道管理员</option><option value="server_admin">服务器管理员</option></select></label>
            <button class="primary-button" :disabled="busy"><UserPlus :size="17" />创建账号</button>
          </form>

          <section class="settings-section">
            <h3><Ticket :size="18" />邀请码</h3>
            <div class="two-column">
              <label><span>可使用次数</span><input v-model.number="inviteUses" type="number" min="1" max="1000" /></label>
              <label><span>有效天数</span><input v-model.number="inviteDays" type="number" min="1" max="365" /></label>
            </div>
            <button class="primary-button" :disabled="busy" @click="createInvite"><Ticket :size="17" />生成邀请码</button>
            <div v-if="generatedCode" class="generated-code"><code>{{ generatedCode }}</code><button class="icon-button" title="复制邀请码" @click="copyCode"><Clipboard :size="18" /></button></div>
            <div class="invite-list">
              <div v-for="invite in invites" :key="invite.id" :class="{ inactive: invite.revokedAt || invite.useCount >= invite.maxUses || new Date(invite.expiresAt) < new Date() }">
                <span><strong>{{ invite.useCount }} / {{ invite.maxUses }} 次</strong><small>{{ new Date(invite.expiresAt).toLocaleDateString('zh-CN') }} 到期</small></span>
                <Check v-if="invite.useCount >= invite.maxUses" :size="17" />
                <button v-else-if="!invite.revokedAt" class="icon-button" title="撤销邀请码" @click="revokeInvite(invite.id)"><X :size="17" /></button>
              </div>
            </div>
          </section>
        </section>
      </div>
      <footer class="panel-footer"><span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span></footer>
    </section>
  </div>
</template>
