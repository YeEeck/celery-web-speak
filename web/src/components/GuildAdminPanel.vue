<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue'
import { Gauge, Plus, Save, Settings, Trash2, UserCog, X } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import type { ChannelType } from '../types'
import { rangeProgressStyle } from '../utils/range'
import { guildAdminContextKey } from './guild-admin-context'
import GuildSettingsTab from './GuildSettingsTab.vue'
import MemberAdminTab from './MemberAdminTab.vue'

defineEmits<{ close: [] }>()
const app = useAppStore()
const canSeeGuildTab = computed(() => app.isPlatformAdmin || app.activeGuild?.role === 'owner')
const tab = ref<'guild' | 'channel' | 'users'>(canSeeGuildTab.value ? 'guild' : 'channel')
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
const message = ref('')
const errorMessage = ref('')
const busy = ref(false)
const adminContent = ref<HTMLElement | null>(null)

const guildContext = computed(() => app.activeGuild)
const adminSubtitle = computed(() => {
  const guildRole = guildContext.value?.role === 'owner' ? '服务器所有者' : '服务器管理员'
  return app.isPlatformAdmin ? `${guildRole} · 平台管理员` : guildRole
})

watch(selectedChannel, (channel) => {
  channelName.value = channel?.name ?? ''
  bitrate.value = channel?.audioBitrateKbps ?? 64
  backgroundBitrate.value = channel?.backgroundAudioBitrateKbps ?? 128
  audioRedEnabled.value = channel?.audioRedEnabled ?? true
  backgroundAudioRedEnabled.value = channel?.backgroundAudioRedEnabled ?? false
  retention.value = channel?.messageRetention ?? 500
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

provide(guildAdminContextKey, { busy, run })

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

function selectTab(nextTab: 'guild' | 'channel' | 'users') {
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
        <button v-if="canSeeGuildTab" :class="{ active: tab === 'guild' }" @click="selectTab('guild')"><Settings :size="17" />服务器</button>
        <button :class="{ active: tab === 'channel' }" @click="selectTab('channel')"><Gauge :size="17" />频道</button>
        <button :class="{ active: tab === 'users' }" @click="selectTab('users')"><UserCog :size="17" />成员</button>
      </nav>

      <div ref="adminContent" :class="['admin-content', { 'users-content': tab === 'users' }]">
        <GuildSettingsTab v-if="tab === 'guild'" />

        <section v-else-if="tab === 'channel'" class="settings-section channel-settings">
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

        <MemberAdminTab v-else />
      </div>
      <footer class="panel-footer"><span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span></footer>
    </section>
  </div>
</template>
