<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ArrowDown, ChevronUp, Hash, Menu, Send, Users } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { isSlashInput, type CommandFeedback, type SlashSuggestion } from '../slash-commands'
import type { Message } from '../types'

const monthDayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

defineProps<{ membersVisible: boolean }>()
const emit = defineEmits<{ channels: []; members: []; messageMenu: [message: Message, trigger: HTMLElement | null, x: number, y: number]; openProfile: [userId: number, trigger: HTMLElement | null, x: number, y: number] }>()
const app = useAppStore()
const toast = useToastStore()
const content = ref('')
const sending = ref(false)
const suggestions = ref<SlashSuggestion[]>([])
const activeSuggestion = ref(0)
const suggestionsDismissed = ref(false)
const list = ref<HTMLElement | null>(null)
const composer = ref<HTMLTextAreaElement | null>(null)
const atBottom = ref(true)
const dateLabelReference = ref(new Date())
const liveMessageIds = ref<ReadonlySet<number>>(new Set())
let markReadTimer: number | undefined
let dateLabelTimer: number | undefined
const liveMessageTimers = new Map<number, number>()
let restoringChannel = false
let programmaticScroll = false

type TimelineItem =
  | { kind: 'message'; key: number; message: Message }
  | { kind: 'feedback'; key: string; feedback: CommandFeedback }

const timelineItems = computed<TimelineItem[]>(() => [
  ...app.messages.map((message) => ({ kind: 'message' as const, key: message.id, message })),
  ...app.commandFeedbacks.map((feedback) => ({ kind: 'feedback' as const, key: feedback.id, feedback })),
].sort((a, b) => {
  const aTime = new Date(a.kind === 'message' ? a.message.createdAt : a.feedback.createdAt).getTime()
  const bTime = new Date(b.kind === 'message' ? b.message.createdAt : b.feedback.createdAt).getTime()
  return aTime - bTime || String(a.key).localeCompare(String(b.key))
}))

const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>(computed(() => ({
  count: timelineItems.value.length + 1,
  getScrollElement: () => list.value as HTMLDivElement | null,
  estimateSize: (index: number) => {
    if (index === 0) return app.hasEarlierMessages ? 46 : 205
    const item = timelineItems.value[index - 1]
    if (!item) return 68
    return item.kind === 'feedback' ? 112 : startsNewDay(index - 1) ? 101 : 68
  },
  getItemKey: (index: number) => index === 0 ? `history-${app.activeTextChannelId}` : (timelineItems.value[index - 1]?.key ?? index),
  overscan: 10,
})))
const visibleRows = computed(() => virtualizer.value.getVirtualItems().map((virtualRow) => {
  const itemIndex = virtualRow.index - 1
  const item = virtualRow.index === 0 ? null : timelineItems.value[itemIndex]
  const message = item?.kind === 'message' ? item.message : null
  return {
    virtualRow,
    item,
    message,
    dateLabel: message !== null && startsNewDay(itemIndex) ? formatMessageDate(message.createdAt, dateLabelReference.value) : null,
  }
}))
const totalSize = computed(() => virtualizer.value.getTotalSize())

onMounted(scheduleDateLabelRefresh)

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
  suggestionsDismissed.value = false
  refreshSuggestions()
})

watch(() => [app.activeTextChannelId, timelineItems.value.at(-1)?.key] as const, async ([channelId, itemKey], previous) => {
  if (channelId === null || itemKey === undefined) return
  const [previousChannelId, previousKey] = previous ?? [null, undefined]
  if (channelId !== previousChannelId || previousKey === undefined) {
    await restoreChannelPosition(channelId)
    return
  }
  if (itemKey === previousKey) return
  const latest = timelineItems.value.at(-1)
  if (latest?.kind === 'message') markLiveMessage(latest.message.id)
  if (atBottom.value) {
    await nextTick()
    await scrollToLatestStable()
  }
})

onBeforeUnmount(() => {
  if (markReadTimer) window.clearTimeout(markReadTimer)
  if (dateLabelTimer) window.clearTimeout(dateLabelTimer)
  liveMessageTimers.forEach((timer) => window.clearTimeout(timer))
  if (app.activeTextChannelId !== null && list.value) app.setChannelScroll(app.activeTextChannelId, list.value.scrollTop, atBottom.value)
})

function markLiveMessage(messageID: number) {
  liveMessageIds.value = new Set(liveMessageIds.value).add(messageID)
  const previousTimer = liveMessageTimers.get(messageID)
  if (previousTimer) window.clearTimeout(previousTimer)
  liveMessageTimers.set(messageID, window.setTimeout(() => {
    const next = new Set(liveMessageIds.value)
    next.delete(messageID)
    liveMessageIds.value = next
    liveMessageTimers.delete(messageID)
  }, 220))
}

function refreshSuggestions() {
  if (suggestionsDismissed.value || !isSlashInput(content.value)) {
    suggestions.value = []
    activeSuggestion.value = 0
    return
  }
  suggestions.value = app.getSlashCommandSuggestions(content.value)
  if (activeSuggestion.value >= suggestions.value.length) activeSuggestion.value = 0
}

function acceptSuggestion(suggestion = suggestions.value[activeSuggestion.value]) {
  if (!suggestion) return
  content.value = suggestion.value
  suggestionsDismissed.value = false
  activeSuggestion.value = 0
  resizeComposer()
  void nextTick(() => composer.value?.focus())
}

async function send() {
  const value = content.value.trim()
  const channelId = app.activeTextChannelId
  const guildId = app.activeGuildId
  if (!value || sending.value || channelId === null || guildId === null || !app.activeTextChannel) return
  sending.value = true
  try {
    if (isSlashInput(value)) {
      const result = await app.executeSlashCommand(value, channelId)
      if (result.kind === 'message') {
        await app.sendMessage(result.content, channelId, guildId)
        clearCurrentInput(channelId, guildId)
      } else if (result.clearInput) {
        clearCurrentInput(channelId, guildId)
      } else {
        focusComposer()
      }
    } else {
      await app.sendMessage(value, channelId, guildId)
      clearCurrentInput(channelId, guildId)
    }
  } catch (error) {
    toast.showError(error instanceof Error ? error.message : '发送消息失败')
    focusComposer()
  } finally {
    sending.value = false
    refreshSuggestions()
  }
}

function clearCurrentInput(channelId: number, guildId: number) {
  app.setChannelDraft(channelId, '', guildId)
  if (app.activeGuildId !== guildId || app.activeTextChannelId !== channelId) return
  content.value = ''
  resizeComposer()
}

function focusComposer() {
  void nextTick(() => composer.value?.focus())
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && suggestions.value.length) {
    event.preventDefault()
    suggestionsDismissed.value = true
    suggestions.value = []
    return
  }
  if (suggestions.value.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    activeSuggestion.value = (activeSuggestion.value + delta + suggestions.value.length) % suggestions.value.length
    return
  }
  if (suggestions.value.length && (event.key === 'Tab' || event.key === 'Enter')) {
    event.preventDefault()
    acceptSuggestion()
    return
  }
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

function openMessageMenu(message: Message, event: MouseEvent) {
  event.preventDefault()
  const trigger = event.currentTarget as HTMLElement | null
  const bounds = trigger?.getBoundingClientRect()
  emit('messageMenu', message, trigger, event.clientX || (bounds?.right ?? 0), event.clientY || (bounds?.top ?? 0))
}

function openMessageAuthorProfile(message: Message, event: MouseEvent) {
  const trigger = event.currentTarget as HTMLElement | null
  const bounds = trigger?.getBoundingClientRect()
  emit('openProfile', message.userId, trigger, event.clientX || (bounds?.left ?? 0), event.clientY || (bounds?.top ?? 0))
}

async function loadEarlierMessages() {
  const anchorID = app.messages[0]?.id
  const anchorOffset = anchorID === undefined ? null : messageOffset(anchorID)
  const added = await app.loadEarlier()
  if (!anchorID || added === 0) return
  await nextTick()
  virtualizer.value.measure()
  const anchorIndex = timelineItems.value.findIndex((item) => item.kind === 'message' && item.message.id === anchorID)
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
    ?.querySelector<HTMLElement>('.message-body')
  return element ? element.getBoundingClientRect().top - list.value.getBoundingClientRect().top : null
}

function animationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function startsNewDay(messageIndex: number) {
  const item = timelineItems.value[messageIndex]
  if (!item || item.kind !== 'message') return false
  const message = item.message
  const previous = timelineItems.value.slice(0, messageIndex).reverse().find((candidate) => candidate.kind === 'message')
  if (!previous || previous.kind !== 'message') return true
  return localDateKey(message.createdAt) !== localDateKey(previous.message.createdAt)
}

function localDateKey(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function formatMessageDate(value: string, reference: Date) {
  const date = new Date(value)
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate())
  if (localDateKey(date) === localDateKey(today)) return '今天'

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (localDateKey(date) === localDateKey(yesterday)) return '昨天'

  return date.getFullYear() === reference.getFullYear()
    ? monthDayFormatter.format(date)
    : fullDateFormatter.format(date)
}

function scheduleDateLabelRefresh() {
  if (dateLabelTimer) window.clearTimeout(dateLabelTimer)
  const now = new Date()
  dateLabelReference.value = now
  const nextMidnight = new Date(now)
  nextMidnight.setHours(24, 0, 0, 0)
  dateLabelTimer = window.setTimeout(scheduleDateLabelRefresh, nextMidnight.getTime() - now.getTime() + 100)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatFullTime(value: string) {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function roleLabel(role: string) {
  if (role === 'owner') return '服务器所有者'
  if (role === 'admin') return '服务器管理员'
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
            :class="['virtual-message-row', { 'history-row': row.virtualRow.index === 0, 'live-message': row.message && liveMessageIds.has(row.message.id) }]"
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
            <template v-else-if="row.message">
              <div v-if="row.dateLabel" class="message-date-divider" role="separator" :aria-label="row.dateLabel">
                <span>{{ row.dateLabel }}</span>
              </div>
              <article class="message-row" @contextmenu="openMessageMenu(row.message, $event)">
                <button class="message-author-avatar" type="button" :title="`查看${row.message.displayName}的个人信息`" :aria-label="`查看${row.message.displayName}的个人信息`" @click="openMessageAuthorProfile(row.message, $event)">
                  <UserAvatar :name="row.message.displayName" :size="40" :user="app.users.find((u) => u.id === row.message?.userId)" />
                </button>
                <div class="message-body" data-user-content>
                  <header>
                    <button class="message-author-name" type="button" @click="openMessageAuthorProfile(row.message, $event)">{{ row.message.displayName }}</button>
                    <span v-if="roleLabel(row.message.role)" :class="['role-chip', row.message.role]">{{ roleLabel(row.message.role) }}</span>
                    <time><span class="time-short">{{ formatTime(row.message.createdAt) }}</span><span class="time-full">{{ formatFullTime(row.message.createdAt) }}</span></time>
                  </header>
                  <p>{{ row.message.content }}</p>
                </div>
              </article>
            </template>
            <article v-else-if="row.item?.kind === 'feedback'" :class="['command-feedback', row.item.feedback.tone]" :data-feedback-id="row.item.feedback.id">
              <header class="command-feedback-header">
                <strong>斜杠指令反馈</strong>
                <span class="command-feedback-private">仅你可见</span>
              </header>
              <strong class="command-feedback-title">{{ row.item.feedback.title }}</strong>
              <p>{{ row.item.feedback.body }}</p>
            </article>
          </div>
        </div>
      </div>
      <Transition name="motion-popover">
        <button v-if="!atBottom" class="jump-to-latest" @click="scrollToLatest">
          <ArrowDown :size="15" />{{ app.activeUnreadCount ? `${app.activeUnreadCount} 条新消息` : '回到最新消息' }}
        </button>
      </Transition>
    </div>

    <footer class="composer-area">
      <div v-if="suggestions.length" class="command-suggestions" role="listbox" aria-label="斜杠指令建议">
        <button
          v-for="(suggestion, index) in suggestions"
          :key="suggestion.id"
          :class="['command-suggestion', { active: index === activeSuggestion }]"
          type="button"
          role="option"
          :aria-selected="index === activeSuggestion"
          @mousedown.prevent
          @click="acceptSuggestion(suggestion)"
        >
          <span>{{ suggestion.label }}</span>
          <small>{{ suggestion.description }}</small>
        </button>
      </div>
      <div :class="['composer', { disabled: app.user?.textMuted }]">
        <textarea
          ref="composer"
          v-model="content"
          :disabled="!app.activeTextChannel"
          :placeholder="app.user?.textMuted ? '你已被文字禁言' : `发送消息到 #${app.activeTextChannel?.name ?? '文字频道'}`"
          maxlength="2000"
          rows="1"
          @input="resizeComposer"
          @keydown="keydown"
        />
        <div class="composer-actions">
          <span class="character-count" :class="{ near: content.length > 1800 }">{{ content.length }}/2000</span>
          <button class="send-button" :disabled="!content.trim() || sending || !app.activeTextChannel" title="发送消息" @click="send"><Send :size="19" /></button>
        </div>
      </div>
    </footer>
  </section>
</template>
