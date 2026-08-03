<script setup lang="ts">
import { computed, inject, nextTick, reactive, ref, watch } from 'vue'
import { Eraser, Hash, Plus, Radio, Save, Trash2, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import type { Channel, ChannelType } from '../types'
import { guildAdminContextKey } from './guild-admin-context'
import { rangeProgressStyle } from '../utils/range'

const app = useAppStore()
const toast = useToastStore()
const { busy } = inject(guildAdminContextKey)!
const props = defineProps<{ initialChannelId?: number | null }>()

async function run(action: () => Promise<void>, success: string) {
  busy.value = true
  try {
    await toast.runAction(action, success)
  } finally {
    busy.value = false
  }
}

interface ChannelSettingsDraft {
  name: string
  audioBitrateKbps: number
  backgroundAudioBitrateKbps: number
  audioRedEnabled: boolean
  backgroundAudioRedEnabled: boolean
  messageRetention: number
}

const channelTypeDetails: Record<ChannelType, { label: string; deletionWarning: string }> = {
  text: {
    label: '文字频道',
    deletionWarning: '频道内所有消息将被永久删除，此操作无法恢复。',
  },
  voice: {
    label: '语音频道',
    deletionWarning: '语音房间及其通话记录将被永久移除，此操作无法恢复。',
  },
}

function firstDisplayedChannelId() {
  return app.voiceChannels[0]?.id ?? app.textChannels[0]?.id ?? null
}

function settingsDraft(channel?: Channel | null): ChannelSettingsDraft {
  return {
    name: channel?.name ?? '',
    audioBitrateKbps: channel?.audioBitrateKbps ?? 64,
    backgroundAudioBitrateKbps: channel?.backgroundAudioBitrateKbps ?? 128,
    audioRedEnabled: channel?.audioRedEnabled ?? true,
    backgroundAudioRedEnabled: channel?.backgroundAudioRedEnabled ?? false,
    messageRetention: channel?.messageRetention ?? 500,
  }
}

const selectedChannelId = ref<number | null>(app.channels.some((channel) => channel.id === props.initialChannelId) ? props.initialChannelId! : firstDisplayedChannelId())
const selectedChannel = computed(() => app.channels.find((channel) => channel.id === selectedChannelId.value) ?? null)
const selectedChannelTypeDetails = computed(() => selectedChannel.value ? channelTypeDetails[selectedChannel.value.type] : null)
const draft = reactive(settingsDraft(selectedChannel.value))
const newChannelType = ref<ChannelType>('text')
const newChannelName = ref('')
const showCreateDialog = ref(false)
const createNameInput = ref<HTMLInputElement | null>(null)
const showDeleteConfirmation = ref(false)
const deleteConfirmation = ref('')
const showClearConfirmation = ref(false)
const clearMessageCount = ref<number | null>(null)

const voiceOnlineCount = computed(() => {
  const channel = selectedChannel.value
  if (!channel || channel.type !== 'voice') return 0
  return app.voiceRooms.find((room) => room.channelId === channel.id)?.participants.length ?? 0
})

const channelStats = ref<{ messageCount: number; contentBytes: number } | null>(null)

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

async function loadChannelStats(channel: Channel | null) {
  if (!channel || channel.type !== 'text') return
  try {
    const payload = await request<{ messageCount: number; contentBytes: number }>(`/api/guilds/${app.activeGuildId}/channels/${channel.id}/stats`)
    if (selectedChannel.value?.id === channel.id) channelStats.value = payload
  } catch {
    // 统计为只读展示，加载失败时保持占位符
  }
}

watch(selectedChannel, (channel) => {
  Object.assign(draft, settingsDraft(channel))
  showDeleteConfirmation.value = false
  deleteConfirmation.value = ''
  showClearConfirmation.value = false
  clearMessageCount.value = null
  channelStats.value = null
  loadChannelStats(channel)
})
loadChannelStats(selectedChannel.value)

function openClearConfirmation() {
  const channel = selectedChannel.value
  if (!channel) return
  showClearConfirmation.value = true
  clearMessageCount.value = null
  request<{ messageCount: number }>(`/api/guilds/${app.activeGuildId}/channels/${channel.id}/stats`)
    .then((stats) => {
      if (selectedChannel.value?.id === channel.id) clearMessageCount.value = stats.messageCount
    })
    .catch(() => {
      clearMessageCount.value = 0
    })
}

async function clearChannelMessages() {
  const channel = selectedChannel.value
  if (!channel) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/channels/${channel.id}/messages`, { method: 'DELETE' })
    showClearConfirmation.value = false
    clearMessageCount.value = null
    channelStats.value = { messageCount: 0, contentBytes: 0 }
  }, '频道消息已清空')
}

function openCreateDialog() {
  newChannelType.value = 'text'
  newChannelName.value = ''
  showCreateDialog.value = true
  nextTick(() => createNameInput.value?.focus())
}

function closeCreateDialog() {
  if (busy.value) return
  showCreateDialog.value = false
  newChannelName.value = ''
}

async function saveSettings() {
  const channel = selectedChannel.value
  if (!channel) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/channels/${channel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: draft.name,
        audioBitrateKbps: channel.type === 'voice' ? draft.audioBitrateKbps : 0,
        backgroundAudioBitrateKbps: channel.type === 'voice' ? draft.backgroundAudioBitrateKbps : 0,
        audioRedEnabled: channel.type === 'voice' && draft.audioRedEnabled,
        backgroundAudioRedEnabled: channel.type === 'voice' && draft.backgroundAudioRedEnabled,
        messageRetention: channel.type === 'text' ? draft.messageRetention : 0,
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
    showCreateDialog.value = false
    await app.bootstrap()
    selectedChannelId.value = payload.channel.id
  }, '频道已创建')
}

async function deleteChannel() {
  const channel = selectedChannel.value
  if (!channel || deleteConfirmation.value !== channel.name) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/channels/${channel.id}`, { method: 'DELETE' })
    showDeleteConfirmation.value = false
    deleteConfirmation.value = ''
    await app.bootstrap()
    selectedChannelId.value = firstDisplayedChannelId()
  }, '频道已永久删除')
}
</script>

<template>
  <section class="channel-admin-layout">
    <aside class="channel-admin-list" aria-label="频道列表">
      <button class="secondary-button channel-create-trigger" type="button" @click="openCreateDialog"><Plus :size="16" />创建频道</button>
      <div class="category-heading"><span>语音频道</span></div>
      <button
        v-for="channel in app.voiceChannels"
        :key="channel.id"
        type="button"
        class="channel-admin-item"
        :class="{ active: channel.id === selectedChannelId }"
        @click="selectedChannelId = channel.id"
      >
        <Radio :size="17" /><span>{{ channel.name }}</span>
      </button>
      <div class="category-heading"><span>文字频道</span></div>
      <button
        v-for="channel in app.textChannels"
        :key="channel.id"
        type="button"
        class="channel-admin-item"
        :class="{ active: channel.id === selectedChannelId }"
        @click="selectedChannelId = channel.id"
      >
        <Hash :size="17" /><span>{{ channel.name }}</span>
      </button>
    </aside>

    <div v-if="selectedChannel" class="channel-admin-detail">
      <header>
        <span class="channel-admin-mark"><Hash v-if="selectedChannel.type === 'text'" :size="22" /><Radio v-else :size="22" /></span>
        <div><h3>{{ selectedChannel.name }}</h3><p>{{ selectedChannelTypeDetails?.label }}</p></div>
      </header>
      <dl class="guild-metadata">
        <div><dt>频道类型</dt><dd>{{ selectedChannelTypeDetails?.label }}</dd></div>
        <div><dt>创建时间</dt><dd>{{ new Date(selectedChannel.createdAt).toLocaleString('zh-CN') }}</dd></div>
        <div v-if="selectedChannel.type === 'text'"><dt>消息占用</dt><dd>{{ channelStats ? `${channelStats.messageCount} 条消息 · ${formatBytes(channelStats.contentBytes)}` : '—' }}</dd></div>
        <div v-if="selectedChannel.type === 'voice'"><dt>语音在线</dt><dd>{{ voiceOnlineCount }} 人</dd></div>
      </dl>

      <section class="settings-section channel-settings">
        <h3>频道设置</h3>
        <label><span>频道名称</span><input v-model.trim="draft.name" maxlength="32" /></label>
        <label v-if="selectedChannel.type === 'voice'" class="range-setting">
          <span>Opus 发送码率 <strong>{{ draft.audioBitrateKbps }} kbps</strong></span>
          <input v-model.number="draft.audioBitrateKbps" type="range" min="32" max="128" step="8" :style="rangeProgressStyle(draft.audioBitrateKbps, 32, 128)" />
          <span class="range-labels"><small>32 kbps</small><small>128 kbps</small></span>
        </label>
        <label v-if="selectedChannel.type === 'voice'" class="range-setting">
          <span>背景音码率 <strong>{{ draft.backgroundAudioBitrateKbps }} kbps</strong></span>
          <input v-model.number="draft.backgroundAudioBitrateKbps" type="range" min="64" max="256" step="16" :style="rangeProgressStyle(draft.backgroundAudioBitrateKbps, 64, 256)" />
          <span class="range-labels"><small>64 kbps</small><small>256 kbps</small></span>
        </label>
        <label v-if="selectedChannel.type === 'voice'" class="setting-toggle">
          <span>语音 RED 丢包冗余</span>
          <input v-model="draft.audioRedEnabled" type="checkbox" aria-label="语音 RED 丢包冗余" />
        </label>
        <label v-if="selectedChannel.type === 'voice'" class="setting-toggle">
          <span>背景音 RED 丢包冗余</span>
          <input v-model="draft.backgroundAudioRedEnabled" type="checkbox" aria-label="背景音 RED 丢包冗余" />
        </label>
        <label v-else><span>保留消息数量</span><input v-model.number="draft.messageRetention" type="number" min="100" max="5000" step="100" /></label>
        <div class="channel-admin-actions">
          <button class="primary-button" :disabled="busy || !draft.name" @click="saveSettings"><Save :size="17" />保存频道设置</button>
        </div>
      </section>

      <section class="channel-admin-danger">
        <div v-if="selectedChannel.type === 'text'" class="channel-danger-row">
          <div><h3><Eraser :size="18" />清空消息</h3><p>删除频道内全部消息，频道本体与保留设置保留。</p></div>
          <button v-if="!showClearConfirmation" class="secondary-button danger-text" type="button" @click="openClearConfirmation">清空消息</button>
          <div v-else class="channel-delete-confirmation">
            <p class="channel-clear-warning">将永久删除 <strong>{{ clearMessageCount ?? '…' }}</strong> 条消息，此操作无法恢复。</p>
            <button class="secondary-button" type="button" @click="showClearConfirmation = false; clearMessageCount = null">取消</button>
            <button class="danger-button" type="button" :disabled="busy" @click="clearChannelMessages">确认清空</button>
          </div>
        </div>
        <div class="channel-danger-row">
          <div><h3><Trash2 :size="18" />删除频道</h3><p>{{ selectedChannelTypeDetails?.deletionWarning }}</p></div>
          <button v-if="!showDeleteConfirmation" class="secondary-button danger-text" type="button" @click="showDeleteConfirmation = true">删除</button>
          <div v-else class="channel-delete-confirmation">
            <input v-model="deleteConfirmation" :placeholder="selectedChannel.name" aria-label="输入频道名称确认删除" />
            <button class="secondary-button" type="button" @click="showDeleteConfirmation = false; deleteConfirmation = ''">取消</button>
            <button class="danger-button" type="button" :disabled="busy || deleteConfirmation !== selectedChannel.name" @click="deleteChannel">确认删除</button>
          </div>
        </div>
      </section>
    </div>

    <div v-if="showCreateDialog" class="channel-create-backdrop" @mousedown.self="closeCreateDialog" @keydown.esc.stop="closeCreateDialog">
      <section class="channel-create-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-create-title">
        <header>
          <h3 id="channel-create-title">创建频道</h3>
          <button class="icon-button" title="关闭" :disabled="busy" @click="closeCreateDialog"><X :size="19" /></button>
        </header>
        <label><span>频道类型</span><select v-model="newChannelType" aria-label="频道类型"><option value="text">文字频道</option><option value="voice">语音频道</option></select></label>
        <label><span>频道名称</span><input ref="createNameInput" v-model.trim="newChannelName" maxlength="32" placeholder="频道名称" aria-label="新频道名称" @keydown.enter="createChannel" /></label>
        <div class="channel-create-actions">
          <button class="secondary-button" type="button" :disabled="busy" @click="closeCreateDialog">取消</button>
          <button class="primary-button" type="button" :disabled="busy || !newChannelName" @click="createChannel"><Plus :size="17" />创建</button>
        </div>
      </section>
    </div>
  </section>
</template>
