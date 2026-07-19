<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ChevronUp, Hash, Menu, Send, Trash2, Users } from '@lucide/vue'
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

onMounted(() => nextTick(scrollToBottom))
watch(() => app.messages.length, () => nextTick(scrollToBottomIfNear))

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

function scrollToBottom() {
  if (list.value) list.value.scrollTop = list.value.scrollHeight
}

function scrollToBottomIfNear() {
  if (!list.value) return
  const distance = list.value.scrollHeight - list.value.scrollTop - list.value.clientHeight
  if (distance < 180) scrollToBottom()
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
      <strong>文字聊天</strong>
      <span class="header-divider" />
      <small :class="['socket-state', app.socketStatus]">{{ app.socketStatus === 'online' ? '实时连接正常' : app.socketStatus === 'connecting' ? '正在连接' : '连接已断开' }}</small>
      <button
        :class="['icon-button', 'member-toggle', { active: membersVisible }]"
        :title="membersVisible ? '隐藏成员列表' : '显示成员列表'"
        :aria-pressed="membersVisible"
        @click="$emit('members')"
      ><Users :size="20" /></button>
    </header>

    <div ref="list" class="message-list">
      <button v-if="app.messages.length >= 50" class="load-earlier" @click="app.loadEarlier()"><ChevronUp :size="15" />加载更早消息</button>
      <div class="channel-intro">
        <span class="intro-icon"><Hash :size="28" /></span>
        <h2>文字聊天</h2>
        <p>这是 Celery Web Speak 频道的开始。</p>
      </div>
      <article v-for="message in app.messages" :key="message.id" class="message-row">
        <UserAvatar :name="message.displayName" :size="40" />
        <div class="message-body">
          <header>
            <strong>{{ message.displayName }}</strong>
            <span v-if="roleLabel(message.role)" :class="['role-chip', message.role]">{{ roleLabel(message.role) }}</span>
            <time>{{ formatTime(message.createdAt) }}</time>
          </header>
          <p>{{ message.content }}</p>
        </div>
        <button v-if="app.isAdmin" class="message-action" title="删除消息" @click="removeMessage(message.id)"><Trash2 :size="16" /></button>
      </article>
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
