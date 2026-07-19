<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
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
const unreadMessages = ref(0)

const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>(computed(() => ({
  count: app.messages.length + 1,
  getScrollElement: () => list.value as HTMLDivElement | null,
  estimateSize: (index: number) => index === 0 ? (app.hasEarlierMessages ? 46 : 205) : 64,
  getItemKey: (index: number) => index === 0 ? 'history-status' : (app.messages[index - 1]?.id ?? index),
  overscan: 10,
})))
const visibleRows = computed(() => virtualizer.value.getVirtualItems().map((virtualRow) => ({
  virtualRow,
  message: virtualRow.index === 0 ? null : app.messages[virtualRow.index - 1],
})))
const totalSize = computed(() => virtualizer.value.getTotalSize())

onMounted(() => nextTick(scrollToLatest))
watch(() => app.messages.at(-1)?.id, (messageID, previousID) => {
  if (messageID === undefined || previousID === undefined || messageID <= previousID) return
  const added = app.messages.filter((message) => message.id > previousID).length
  if (atBottom.value) {
    void nextTick(scrollToLatest)
  } else {
    unreadMessages.value += added
  }
})

async function send() {
  const value = content.value.trim()
  if (!value || sending.value || app.user?.textMuted) return
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
  if (!composer.value) return
  composer.value.style.height = '0'
  composer.value.style.height = `${Math.min(composer.value.scrollHeight, 144)}px`
}

async function removeMessage(id: number) {
  await request<void>(`/api/messages/${id}`, { method: 'DELETE' })
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
  if (!list.value) return
  const distance = list.value.scrollHeight - list.value.scrollTop - list.value.clientHeight
  atBottom.value = distance < 80
  if (atBottom.value) unreadMessages.value = 0
}

function scrollToLatest() {
  if (!list.value) return
  virtualizer.value.scrollToIndex(app.messages.length, { align: 'end' })
  requestAnimationFrame(() => {
    if (!list.value) return
    list.value.scrollTop = list.value.scrollHeight
    handleScroll()
  })
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
      <h1 class="channel-title">文字聊天</h1>
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
                <strong class="intro-title">文字聊天</strong>
                <p>这是 Celery Web Speak 频道的开始。</p>
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
        <ArrowDown :size="15" />{{ unreadMessages ? `${unreadMessages} 条新消息` : '回到最新消息' }}
      </button>
    </div>

    <footer class="composer-area">
      <div :class="['composer', { disabled: app.user?.textMuted }]">
        <textarea
          ref="composer"
          v-model="content"
          :disabled="app.user?.textMuted"
          :placeholder="app.user?.textMuted ? '你已被文字禁言' : '发送消息到 #文字聊天'"
          maxlength="2000"
          rows="1"
          @input="resizeComposer"
          @keydown="keydown"
        />
        <span class="character-count" :class="{ near: content.length > 1800 }">{{ content.length }}/2000</span>
        <button class="send-button" :disabled="!content.trim() || sending || app.user?.textMuted" title="发送消息" @click="send"><Send :size="19" /></button>
      </div>
    </footer>
  </section>
</template>
