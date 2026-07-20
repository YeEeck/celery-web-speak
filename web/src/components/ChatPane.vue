<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ArrowDown, ChevronUp, Hash, Menu, Send, Trash2, Users } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'

defineProps<{ membersVisible: boolean }>()
defineEmits<{ channels: []; members: [] }>()
const app = useAppStore()
const content = ref('')
const sending = ref(false)
const list = ref<HTMLElement | null>(null)
const composer = ref<HTMLTextAreaElement | null>(null)
const atBottom = ref(true)
let markReadTimer: number | undefined
let restoringChannel = false
let programmaticScroll = false

const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>(computed(() => ({
  count: app.messages.length + 1,
  getScrollElement: () => list.value as HTMLDivElement | null,
  estimateSize: (index: number) => index === 0 ? (app.hasEarlierMessages ? 46 : 205) : 64,
  getItemKey: (index: number) => index === 0 ? `history-${app.activeTextChannelId}` : (app.messages[index - 1]?.id ?? index),
  overscan: 10,
})))
const visibleRows = computed(() => virtualizer.value.getVirtualItems().map((virtualRow) => ({
  virtualRow,
  message: virtualRow.index === 0 ? null : app.messages[virtualRow.index - 1],
})))
const totalSize = computed(() => virtualizer.value.getTotalSize())

watch(() => app.activeTextChannelId, async (channelId, previousChannelId) => {
  if (typeof previousChannelId === 'number' && list.value) app.setChannelScroll(previousChannelId, list.value.scrollTop, atBottom.value)
  content.value = channelId === null ? '' : app.getChannelDraft(channelId)
  resizeComposer()
  if (channelId === null) return
  restoringChannel = true
  try {
    await app.loadChannelMessages(channelId)
    await restoreChannelPosition(channelId)
  } finally {
    restoringChannel = false
    handleScroll()
  }
}, { immediate: true })

watch(content, (value) => {
  if (app.activeTextChannelId !== null) app.setChannelDraft(app.activeTextChannelId, value)
})

watch(() => [app.activeTextChannelId, app.messages.at(-1)?.id] as const, async ([channelId, messageID], previous) => {
  if (channelId === null || messageID === undefined) return
  const [previousChannelId, previousID] = previous ?? [null, undefined]
  if (channelId !== previousChannelId || previousID === undefined) {
    await restoreChannelPosition(channelId)
    return
  }
  if (messageID <= previousID) return
  if (atBottom.value) {
    await nextTick()
    await scrollToLatestStable()
  }
})

onBeforeUnmount(() => {
  if (markReadTimer) window.clearTimeout(markReadTimer)
  if (app.activeTextChannelId !== null && list.value) app.setChannelScroll(app.activeTextChannelId, list.value.scrollTop, atBottom.value)
})

async function send() {
  const value = content.value.trim()
  if (!value || sending.value || app.user?.textMuted || !app.activeTextChannel) return
  sending.value = true
  try {
    await app.sendMessage(value)
    content.value = ''
    resizeComposer()
  } finally {
    sending.value = false
  }
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

function resizeComposer() {
  void nextTick(() => {
    if (!composer.value) return
    composer.value.style.height = '0'
    composer.value.style.height = `${Math.min(composer.value.scrollHeight, 144)}px`
  })
}

async function removeMessage(id: number) {
  if (app.activeTextChannelId === null) return
  await request<void>(`/api/channels/${app.activeTextChannelId}/messages/${id}`, { method: 'DELETE' })
}

async function loadEarlierMessages() {
  const anchorID = app.messages[0]?.id
  const anchorOffset = anchorID === undefined ? null : messageOffset(anchorID)
  const added = await app.loadEarlier()
  if (!anchorID || added === 0) return
  await nextTick()
  virtualizer.value.measure()
  const anchorIndex = app.messages.findIndex((message) => message.id === anchorID)
  if (anchorIndex < 0) return
  virtualizer.value.scrollToIndex(anchorIndex + 1, { align: 'start' })
  for (let attempt = 0; attempt < 3 && anchorOffset !== null && list.value; attempt++) {
    await animationFrame()
    const currentOffset = messageOffset(anchorID)
    if (currentOffset !== null) list.value.scrollTop += currentOffset - anchorOffset
  }
}

function handleScroll() {
  if (restoringChannel || programmaticScroll || !list.value || app.activeTextChannelId === null) return
  const distance = list.value.scrollHeight - list.value.scrollTop - list.value.clientHeight
  atBottom.value = distance < 80
  app.setChannelScroll(app.activeTextChannelId, list.value.scrollTop, atBottom.value)
  if (atBottom.value) scheduleMarkRead()
}

function scheduleMarkRead() {
  if (!app.activeUnreadCount) return
  if (markReadTimer) window.clearTimeout(markReadTimer)
  markReadTimer = window.setTimeout(() => {
    if (atBottom.value) void app.markActiveChannelRead()
  }, 200)
}

function scrollToLatest() {
  void scrollToLatestStable()
}

async function scrollToLatestStable() {
  if (!list.value) return
  const channelId = app.activeTextChannelId
  programmaticScroll = true
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!list.value || channelId !== app.activeTextChannelId) return
      list.value.scrollTop = list.value.scrollHeight
      await animationFrame()
    }
  } finally {
    programmaticScroll = false
    handleScroll()
  }
}

async function restoreChannelPosition(channelId: number) {
  await nextTick()
  if (channelId !== app.activeTextChannelId || !list.value) return
  const saved = app.getChannelScroll(channelId)
  if (saved === null || saved.atBottom) {
    virtualizer.value.measure()
    await scrollToLatestStable()
  } else {
    virtualizer.value.measure()
    await animationFrame()
    if (!list.value || channelId !== app.activeTextChannelId) return
    list.value.scrollTop = saved.top
    handleScroll()
  }
}

function measureElement(element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) virtualizer.value.measureElement(element)
}

function messageOffset(messageID: number) {
  if (!list.value) return null
  const element = Array.from(list.value.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find((item) => Number(item.dataset.messageId) === messageID)
  return element ? element.getBoundingClientRect().top - list.value.getBoundingClientRect().top : null
}

function animationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function roleLabel(role: string) {
  if (role === 'server_admin') return '服务器管理员'
  if (role === 'channel_admin') return '频道管理员'
  return ''
}
</script>

<template>
  <section class="chat-pane">
    <header class="chat-header">
      <button class="icon-button mobile-only" title="频道" @click="$emit('channels')"><Menu :size="20" /></button>
      <Hash :size="21" class="muted-icon" />
      <h1 class="channel-title">{{ app.activeTextChannel?.name ?? '文字频道' }}</h1>
      <span class="header-divider" />
      <small :class="['socket-state', app.socketStatus]">{{ app.socketStatus === 'online' ? '实时连接正常' : app.socketStatus === 'connecting' ? '正在连接' : '连接已断开' }}</small>
      <button
        :class="['icon-button', 'member-toggle', { active: membersVisible }]"
        :title="membersVisible ? '隐藏成员列表' : '显示成员列表'"
        :aria-pressed="membersVisible"
        @click="$emit('members')"
      ><Users :size="20" /></button>
    </header>

    <div class="message-list-wrap">
      <div ref="list" class="message-list" @scroll.passive="handleScroll">
        <div class="virtual-message-list" :style="{ height: `${totalSize}px` }">
          <div
            v-for="row in visibleRows"
            :key="String(row.virtualRow.key)"
            :ref="measureElement"
            :data-index="row.virtualRow.index"
            :data-message-id="row.message?.id"
            :class="['virtual-message-row', { 'history-row': row.virtualRow.index === 0 }]"
            :style="{ transform: `translateY(${row.virtualRow.start}px)` }"
          >
            <template v-if="row.virtualRow.index === 0">
              <button
                v-if="app.hasEarlierMessages"
                class="load-earlier"
                :disabled="app.loadingEarlierMessages"
                @click="loadEarlierMessages"
              ><ChevronUp :size="15" />{{ app.loadingEarlierMessages ? '加载中' : '加载更早消息' }}</button>
              <div v-else class="channel-intro">
                <span class="intro-icon"><Hash :size="28" /></span>
                <strong class="intro-title">{{ app.activeTextChannel?.name }}</strong>
                <p>这是 #{{ app.activeTextChannel?.name }} 的开始。</p>
              </div>
            </template>
            <article v-else-if="row.message" class="message-row">
              <UserAvatar :name="row.message.displayName" :size="40" />
              <div class="message-body">
                <header>
                  <strong>{{ row.message.displayName }}</strong>
                  <span v-if="roleLabel(row.message.role)" :class="['role-chip', row.message.role]">{{ roleLabel(row.message.role) }}</span>
                  <time>{{ formatTime(row.message.createdAt) }}</time>
                </header>
                <p>{{ row.message.content }}</p>
              </div>
              <button v-if="app.isAdmin" class="message-action" title="删除消息" @click="removeMessage(row.message.id)"><Trash2 :size="16" /></button>
            </article>
          </div>
        </div>
      </div>
      <button v-if="!atBottom" class="jump-to-latest" @click="scrollToLatest">
        <ArrowDown :size="15" />{{ app.activeUnreadCount ? `${app.activeUnreadCount} 条新消息` : '回到最新消息' }}
      </button>
    </div>

    <footer class="composer-area">
      <div :class="['composer', { disabled: app.user?.textMuted }]">
        <textarea
          ref="composer"
          v-model="content"
          :disabled="app.user?.textMuted || !app.activeTextChannel"
          :placeholder="app.user?.textMuted ? '你已被文字禁言' : `发送消息到 #${app.activeTextChannel?.name ?? '文字频道'}`"
          maxlength="2000"
          rows="1"
          @input="resizeComposer"
          @keydown="keydown"
        />
        <span class="character-count" :class="{ near: content.length > 1800 }">{{ content.length }}/2000</span>
        <button class="send-button" :disabled="!content.trim() || sending || app.user?.textMuted || !app.activeTextChannel" title="发送消息" @click="send"><Send :size="19" /></button>
      </div>
    </footer>
  </section>
</template>
