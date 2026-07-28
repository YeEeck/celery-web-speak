<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { Ban, Clipboard, KeyRound, Plus, Ticket, Trash2, UserCog, UserPlus, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { Invite, PlatformRole, User } from '../types'
import UserAvatar from './UserAvatar.vue'

defineEmits<{ close: [] }>()
const app = useAppStore()
const tab = ref<'users' | 'invites'>('users')
const selectedUserId = ref<number | null>(null)
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
const message = ref('')
const errorMessage = ref('')
const busy = ref(false)
const adminContent = ref<HTMLElement | null>(null)
const userDetail = ref<HTMLElement | null>(null)
const deleteTarget = ref<User | null>(null)
const deleteConfirmation = ref('')
const deleteConfirmationInput = ref<HTMLInputElement | null>(null)
const platformUsers = ref<User[]>([])

const selectedUser = computed(() => platformUsers.value.find((user) => user.id === selectedUserId.value) ?? null)
const manageableUsers = computed(() => platformUsers.value.filter((user) => user.id !== app.user!.id))

onMounted(async () => {
  try {
    await loadPlatformUsers()
    await loadInvites()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '邀请码加载失败'
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

async function setRole(role: PlatformRole) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    await request(`/api/platform/users/${target.id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) })
    await loadPlatformUsers()
    selectedUserId.value = target.id
  }, '平台角色已更新')
}

async function permanentBan(banned: boolean) {
  const target = selectedUser.value
  if (!target) return
  await run(async () => {
    await request(`/api/platform/users/${target.id}/suspend`, { method: 'PATCH', body: JSON.stringify({ suspended: banned }) })
    await loadPlatformUsers()
  }, banned ? '平台账号已停用' : '平台账号已恢复')
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
    platformUsers.value = platformUsers.value.filter((user) => user.id !== target.id)
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
  return user.isPlatformAdmin ? '平台管理员' : '普通账号'
}

function selectUser(userId: number) {
  if (selectedUserId.value === userId) return
  selectedUserId.value = userId
  nextTick(() => userDetail.value?.scrollTo({ top: 0 }))
}

function selectTab(nextTab: 'users' | 'invites') {
  if (tab.value === nextTab) return
  tab.value = nextTab
  nextTick(() => adminContent.value?.scrollTo({ top: 0 }))
}
</script>

<template>
  <div class="modal-backdrop admin-backdrop" @mousedown.self="$emit('close')">
    <section class="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <header class="panel-header">
        <div><h2 id="admin-title">平台管理</h2><p>平台管理员</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="admin-tabs">
        <button :class="{ active: tab === 'users' }" @click="selectTab('users')"><UserCog :size="17" />平台账号</button>
        <button :class="{ active: tab === 'invites' }" @click="selectTab('invites')"><Ticket :size="17" />创建与邀请</button>
      </nav>

      <div ref="adminContent" :class="['admin-content', { contained: tab === 'users' }]">
        <section v-if="tab === 'users'" class="user-admin-layout">
          <aside class="admin-user-list">
            <button
              v-for="member in manageableUsers"
              :key="member.id"
              class="platform-user-item"
              :class="{ active: selectedUserId === member.id }"
              @click="selectUser(member.id)"
            >
              <UserAvatar :name="member.displayName" :size="32" :user="member" />
              <span><strong>{{ member.displayName }}</strong><small>{{ roleLabel(member) }}</small></span>
            </button>
          </aside>
          <div v-if="selectedUser" ref="userDetail" class="user-admin-detail">
            <header><UserAvatar :name="selectedUser.displayName" :size="48" :user="selectedUser" /><div><h3>{{ selectedUser.displayName }}</h3><p>@{{ selectedUser.username }}</p></div></header>
            <label><span>平台角色</span><select :value="selectedUser.isPlatformAdmin ? 'platform_admin' : 'member'" @change="setRole(($event.target as HTMLSelectElement).value as PlatformRole)"><option value="member">普通账号</option><option value="platform_admin">平台管理员</option></select></label>
            <label><span>重置密码</span><span class="inline-actions"><input v-model="resetPassword" type="password" minlength="10" placeholder="至少 10 位" /><button class="secondary-button" :disabled="resetPassword.length < 10" @click="doResetPassword"><KeyRound :size="16" />重置</button></span></label>
            <button :class="['secondary-button', { 'danger-text': !selectedUser.permanentlyBanned }]" @click="permanentBan(!selectedUser.permanentlyBanned)"><Ban :size="16" />{{ selectedUser.permanentlyBanned ? '恢复平台账号' : '停用平台账号' }}</button>
            <div class="account-danger-zone">
              <div><strong>删除账号</strong><p>撤销登录并永久移除账号，历史消息将匿名保留。</p></div>
              <button class="secondary-button danger-text" @click="openDeleteDialog(selectedUser)"><Trash2 :size="16" />删除账号</button>
            </div>
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
