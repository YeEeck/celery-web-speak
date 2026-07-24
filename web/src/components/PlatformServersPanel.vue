<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { LogIn, Plus, RefreshCw, Save, ServerCog, Trash2, UserCog, UserRoundCog, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { ServerSummary, User } from '../types'

const props = defineProps<{ initialServerId?: number | null; createOnOpen?: boolean }>()
const emit = defineEmits<{ close: []; accounts: [] }>()
const app = useAppStore()
const servers = ref<ServerSummary[]>([])
const users = ref<User[]>([])
const selectedServerId = ref<number | null>(props.initialServerId ?? null)
const newServerName = ref('')
const newOwnerUsername = ref('')
const newOwnerId = ref<number | null>(null)
const renamedServerName = ref('')
const deleteConfirmation = ref('')
const showDeleteConfirmation = ref(false)
const busy = ref(false)
const loading = ref(false)
const message = ref('')
const errorMessage = ref('')
const createNameInput = ref<HTMLInputElement | null>(null)

const selectedServer = computed(() => servers.value.find((server) => server.id === selectedServerId.value) ?? null)
const selectedOwner = computed(() => users.value.find((user) => user.id === selectedServer.value?.ownerUserId) ?? null)
const ownerCandidates = computed(() => users.value.filter((user) => !user.permanentlyBanned && user.id !== selectedServer.value?.ownerUserId))

watch(() => props.initialServerId, (id) => {
  if (id) selectedServerId.value = id
})
watch(selectedServerId, () => {
  newOwnerId.value = null
  deleteConfirmation.value = ''
  showDeleteConfirmation.value = false
  message.value = ''
  errorMessage.value = ''
})
watch(selectedServer, (server) => {
  renamedServerName.value = server?.name ?? ''
}, { immediate: true })

onMounted(async () => {
  await refresh()
  if (props.createOnOpen) await nextTick(() => createNameInput.value?.focus())
})

async function refresh() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [serverPayload, userPayload] = await Promise.all([
      request<{ servers: ServerSummary[] }>('/api/platform/servers'),
      request<{ users: User[] }>('/api/platform/users'),
    ])
    servers.value = serverPayload.servers ?? []
    users.value = userPayload.users ?? []
    if (!selectedServerId.value || !servers.value.some((server) => server.id === selectedServerId.value)) {
      selectedServerId.value = servers.value[0]?.id ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载失败'
  } finally {
    loading.value = false
  }
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

async function createServer() {
  const name = newServerName.value.trim()
  const ownerUsername = newOwnerUsername.value.trim()
  if (!name || !ownerUsername) return
  await run(async () => {
    const payload = await request<{ server: ServerSummary }>('/api/platform/servers', {
      method: 'POST',
      body: JSON.stringify({ name, ownerUsername }),
    })
    newServerName.value = ''
    newOwnerUsername.value = ''
    await Promise.all([refresh(), app.bootstrap()])
    selectedServerId.value = payload.server.id
  }, '服务器已创建')
}

async function joinServer() {
  const server = selectedServer.value
  if (!server) return
  await run(async () => {
    await request(`/api/platform/servers/${server.id}/join`, { method: 'POST' })
    await Promise.all([refresh(), app.bootstrap()])
    await app.selectServer(server.id)
  }, '已加入服务器')
}

async function renameServer() {
  const server = selectedServer.value
  const name = renamedServerName.value.trim()
  if (!server || !name || name === server.name) return
  await run(async () => {
    await request(`/api/platform/servers/${server.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    await Promise.all([refresh(), app.bootstrap()])
    selectedServerId.value = server.id
  }, '服务器名称已更新')
}

async function transferOwner() {
  const server = selectedServer.value
  if (!server || !newOwnerId.value) return
  await run(async () => {
    await request(`/api/platform/servers/${server.id}/owner`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: newOwnerId.value }),
    })
    await Promise.all([refresh(), app.bootstrap()])
  }, '所有权已转让')
}

async function deleteServer() {
  const server = selectedServer.value
  if (!server || deleteConfirmation.value !== server.name) return
  await run(async () => {
    await request(`/api/platform/servers/${server.id}`, { method: 'DELETE' })
    selectedServerId.value = null
    deleteConfirmation.value = ''
    showDeleteConfirmation.value = false
    await Promise.all([refresh(), app.bootstrap()])
  }, '服务器已删除')
}
</script>

<template>
  <div class="modal-backdrop platform-backdrop" @mousedown.self="emit('close')">
    <section class="platform-panel" role="dialog" aria-modal="true" aria-labelledby="platform-servers-title">
      <header class="panel-header">
        <div><h2 id="platform-servers-title">平台服务器</h2><p>{{ servers.length }} 个服务器</p></div>
        <span class="panel-header-actions">
          <button class="icon-button" type="button" title="平台账号与邀请码" @click="emit('accounts')"><UserCog :size="18" /></button>
          <button class="icon-button" type="button" title="刷新" :disabled="loading || busy" @click="refresh"><RefreshCw :size="18" /></button>
          <button class="icon-button" type="button" title="关闭" @click="emit('close')"><X :size="21" /></button>
        </span>
      </header>

      <div class="platform-server-layout">
        <aside class="platform-server-list">
          <form class="platform-create-form" @submit.prevent="createServer">
            <h3><Plus :size="17" />创建服务器</h3>
            <input ref="createNameInput" v-model.trim="newServerName" maxlength="64" placeholder="服务器名称" aria-label="服务器名称" />
            <input v-model.trim="newOwnerUsername" maxlength="32" placeholder="所有者完整登录名" aria-label="所有者完整登录名" />
            <button class="primary-button" type="submit" :disabled="busy || !newServerName || !newOwnerUsername"><Plus :size="17" />创建</button>
          </form>
          <nav aria-label="平台服务器列表">
            <button v-for="server in servers" :key="server.id" type="button" :class="{ active: server.id === selectedServerId }" @click="selectedServerId = server.id">
              <span class="server-initial">{{ server.name.trim().slice(0, 1).toUpperCase() }}</span>
              <span><strong>{{ server.name }}</strong><small>{{ server.joined ? '已加入' : '仅管理信息' }}</small></span>
            </button>
          </nav>
        </aside>

        <div v-if="selectedServer" class="platform-server-detail">
          <header>
            <span class="platform-server-mark">{{ selectedServer.name.trim().slice(0, 1).toUpperCase() }}</span>
            <div><h3>{{ selectedServer.name }}</h3><p>服务器 #{{ selectedServer.id }}</p></div>
          </header>
          <dl class="server-metadata">
            <div><dt>所有者</dt><dd>{{ selectedOwner?.displayName ?? `用户 #${selectedServer.ownerUserId}` }}</dd></div>
            <div><dt>成员</dt><dd>{{ selectedServer.memberCount }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ new Date(selectedServer.createdAt).toLocaleString('zh-CN') }}</dd></div>
            <div><dt>状态</dt><dd>{{ selectedServer.joined ? '已加入' : '未加入' }}</dd></div>
          </dl>

            <button v-if="!selectedServer.joined" class="primary-button" type="button" :disabled="busy" @click="joinServer"><LogIn :size="17" />加入为服务器管理员</button>

            <section class="platform-owner-action">
              <h3><ServerCog :size="18" />服务器名称</h3>
              <div class="inline-actions">
                <input v-model.trim="renamedServerName" maxlength="64" aria-label="修改服务器名称" />
                <button class="secondary-button" type="button" :disabled="busy || !renamedServerName || renamedServerName === selectedServer.name" @click="renameServer"><Save :size="16" />保存</button>
              </div>
            </section>

            <section class="platform-owner-action">
            <h3><UserRoundCog :size="18" />转让所有权</h3>
            <div class="inline-actions">
              <select v-model="newOwnerId" aria-label="新所有者">
                <option :value="null" disabled>选择新所有者</option>
                <option v-for="user in ownerCandidates" :key="user.id" :value="user.id">{{ user.displayName }} (@{{ user.username }})</option>
              </select>
              <button class="secondary-button" type="button" :disabled="busy || !newOwnerId" @click="transferOwner">转让</button>
            </div>
          </section>

          <section class="platform-server-danger">
            <div><h3><Trash2 :size="18" />删除服务器</h3><p>{{ selectedServer.memberCount }} 名成员</p></div>
            <button v-if="!showDeleteConfirmation" class="secondary-button danger-text" type="button" @click="showDeleteConfirmation = true">删除</button>
            <div v-else class="server-delete-confirmation">
              <input v-model="deleteConfirmation" :placeholder="selectedServer.name" aria-label="输入服务器名称确认删除" />
              <button class="secondary-button" type="button" @click="showDeleteConfirmation = false; deleteConfirmation = ''">取消</button>
              <button class="danger-button" type="button" :disabled="busy || deleteConfirmation !== selectedServer.name" @click="deleteServer">确认删除</button>
            </div>
          </section>
        </div>
        <div v-else class="platform-server-empty"><ServerCog :size="30" /><span>暂无服务器</span></div>
      </div>

      <footer class="panel-footer"><span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span></footer>
    </section>
  </div>
</template>
