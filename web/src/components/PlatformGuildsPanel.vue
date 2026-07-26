<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { LogIn, Plus, RefreshCw, Save, ServerCog, Trash2, UserCog, UserRoundCog, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { GuildSummary, User } from '../types'

const props = defineProps<{ initialGuildId?: number | null; createOnOpen?: boolean }>()
const emit = defineEmits<{ close: []; accounts: [] }>()
const app = useAppStore()
const guilds = ref<GuildSummary[]>([])
const users = ref<User[]>([])
const selectedGuildId = ref<number | null>(props.initialGuildId ?? null)
const newGuildName = ref('')
const newOwnerUsername = ref('')
const newOwnerId = ref<number | null>(null)
const renamedGuildName = ref('')
const deleteConfirmation = ref('')
const showDeleteConfirmation = ref(false)
const busy = ref(false)
const loading = ref(false)
const message = ref('')
const errorMessage = ref('')
const createNameInput = ref<HTMLInputElement | null>(null)

const selectedGuild = computed(() => guilds.value.find((guild) => guild.id === selectedGuildId.value) ?? null)
const selectedOwner = computed(() => users.value.find((user) => user.id === selectedGuild.value?.ownerUserId) ?? null)
const ownerCandidates = computed(() => users.value.filter((user) => !user.permanentlyBanned && user.id !== selectedGuild.value?.ownerUserId))

watch(() => props.initialGuildId, (id) => {
  if (id) selectedGuildId.value = id
})
watch(selectedGuildId, () => {
  newOwnerId.value = null
  deleteConfirmation.value = ''
  showDeleteConfirmation.value = false
  message.value = ''
  errorMessage.value = ''
})
watch(selectedGuild, (guild) => {
  renamedGuildName.value = guild?.name ?? ''
}, { immediate: true })

onMounted(async () => {
  await refresh()
  if (props.createOnOpen) await nextTick(() => createNameInput.value?.focus())
})

async function refresh() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [guildPayload, userPayload] = await Promise.all([
      request<{ guilds: GuildSummary[] }>('/api/platform/guilds'),
      request<{ users: User[] }>('/api/platform/users'),
    ])
    guilds.value = guildPayload.guilds ?? []
    users.value = userPayload.users ?? []
    if (!selectedGuildId.value || !guilds.value.some((guild) => guild.id === selectedGuildId.value)) {
      selectedGuildId.value = guilds.value[0]?.id ?? null
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

async function createGuild() {
  const name = newGuildName.value.trim()
  const ownerUsername = newOwnerUsername.value.trim()
  if (!name || !ownerUsername) return
  await run(async () => {
    const payload = await request<{ guild: GuildSummary }>('/api/platform/guilds', {
      method: 'POST',
      body: JSON.stringify({ name, ownerUsername }),
    })
    newGuildName.value = ''
    newOwnerUsername.value = ''
    await Promise.all([refresh(), app.bootstrap()])
    selectedGuildId.value = payload.guild.id
  }, '服务器已创建')
}

async function joinGuild() {
  const guild = selectedGuild.value
  if (!guild) return
  await run(async () => {
    await request(`/api/platform/guilds/${guild.id}/join`, { method: 'POST' })
    await Promise.all([refresh(), app.bootstrap()])
    await app.selectGuild(guild.id)
  }, '已加入服务器')
}

async function renameGuild() {
  const guild = selectedGuild.value
  const name = renamedGuildName.value.trim()
  if (!guild || !name || name === guild.name) return
  await run(async () => {
    await request(`/api/platform/guilds/${guild.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    await Promise.all([refresh(), app.bootstrap()])
    selectedGuildId.value = guild.id
  }, '服务器名称已更新')
}

async function transferOwner() {
  const guild = selectedGuild.value
  if (!guild || !newOwnerId.value) return
  await run(async () => {
    await request(`/api/platform/guilds/${guild.id}/owner`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: newOwnerId.value }),
    })
    await Promise.all([refresh(), app.bootstrap()])
  }, '所有权已转让')
}

async function deleteGuild() {
  const guild = selectedGuild.value
  if (!guild || deleteConfirmation.value !== guild.name) return
  await run(async () => {
    await request(`/api/platform/guilds/${guild.id}`, { method: 'DELETE' })
    selectedGuildId.value = null
    deleteConfirmation.value = ''
    showDeleteConfirmation.value = false
    await Promise.all([refresh(), app.bootstrap()])
  }, '服务器已删除')
}
</script>

<template>
  <div class="modal-backdrop platform-backdrop" @mousedown.self="emit('close')">
    <section class="platform-panel" role="dialog" aria-modal="true" aria-labelledby="platform-guilds-title">
      <header class="panel-header">
        <div><h2 id="platform-guilds-title">平台服务器</h2><p>{{ guilds.length }} 个服务器</p></div>
        <span class="panel-header-actions">
          <button class="icon-button" type="button" title="平台账号与邀请码" @click="emit('accounts')"><UserCog :size="18" /></button>
          <button class="icon-button" type="button" title="刷新" :disabled="loading || busy" @click="refresh"><RefreshCw :size="18" /></button>
          <button class="icon-button" type="button" title="关闭" @click="emit('close')"><X :size="21" /></button>
        </span>
      </header>

      <div class="platform-guild-layout">
        <aside class="platform-guild-list">
          <form class="platform-create-form" @submit.prevent="createGuild">
            <h3><Plus :size="17" />创建服务器</h3>
            <input ref="createNameInput" v-model.trim="newGuildName" maxlength="64" placeholder="服务器名称" aria-label="服务器名称" />
            <input v-model.trim="newOwnerUsername" maxlength="32" placeholder="所有者完整登录名" aria-label="所有者完整登录名" />
            <button class="primary-button" type="submit" :disabled="busy || !newGuildName || !newOwnerUsername"><Plus :size="17" />创建</button>
          </form>
          <nav aria-label="平台服务器列表">
            <button v-for="guild in guilds" :key="guild.id" type="button" :class="{ active: guild.id === selectedGuildId }" @click="selectedGuildId = guild.id">
              <span class="guild-initial">{{ guild.name.trim().slice(0, 1).toUpperCase() }}</span>
              <span><strong>{{ guild.name }}</strong><small>{{ guild.joined ? '已加入' : '仅管理信息' }}</small></span>
            </button>
          </nav>
        </aside>

        <div v-if="selectedGuild" class="platform-guild-detail">
          <header>
            <span class="platform-guild-mark">{{ selectedGuild.name.trim().slice(0, 1).toUpperCase() }}</span>
            <div><h3>{{ selectedGuild.name }}</h3><p>服务器 #{{ selectedGuild.id }}</p></div>
          </header>
          <dl class="guild-metadata">
            <div><dt>所有者</dt><dd>{{ selectedOwner?.displayName ?? `用户 #${selectedGuild.ownerUserId}` }}</dd></div>
            <div><dt>成员</dt><dd>{{ selectedGuild.memberCount }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ new Date(selectedGuild.createdAt).toLocaleString('zh-CN') }}</dd></div>
            <div><dt>状态</dt><dd>{{ selectedGuild.joined ? '已加入' : '未加入' }}</dd></div>
          </dl>

            <button v-if="!selectedGuild.joined" class="primary-button" type="button" :disabled="busy" @click="joinGuild"><LogIn :size="17" />加入为服务器管理员</button>

            <section class="platform-owner-action">
              <h3><ServerCog :size="18" />服务器名称</h3>
              <div class="inline-actions">
                <input v-model.trim="renamedGuildName" maxlength="64" aria-label="修改服务器名称" />
                <button class="secondary-button" type="button" :disabled="busy || !renamedGuildName || renamedGuildName === selectedGuild.name" @click="renameGuild"><Save :size="16" />保存</button>
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

          <section class="platform-guild-danger">
            <div><h3><Trash2 :size="18" />删除服务器</h3><p>{{ selectedGuild.memberCount }} 名成员</p></div>
            <button v-if="!showDeleteConfirmation" class="secondary-button danger-text" type="button" @click="showDeleteConfirmation = true">删除</button>
            <div v-else class="guild-delete-confirmation">
              <input v-model="deleteConfirmation" :placeholder="selectedGuild.name" aria-label="输入服务器名称确认删除" />
              <button class="secondary-button" type="button" @click="showDeleteConfirmation = false; deleteConfirmation = ''">取消</button>
              <button class="danger-button" type="button" :disabled="busy || deleteConfirmation !== selectedGuild.name" @click="deleteGuild">确认删除</button>
            </div>
          </section>
        </div>
        <div v-else class="platform-guild-empty"><ServerCog :size="30" /><span>暂无服务器</span></div>
      </div>

      <footer class="panel-footer"><span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span></footer>
    </section>
  </div>
</template>
