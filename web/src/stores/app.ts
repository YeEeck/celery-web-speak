import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError, request } from '../api'
import type { BootstrapData, ChannelSettings, Message, User } from '../types'
import { useSoundStore } from './sounds'

type AuthPayload = { user: User }

export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const user = ref<User | null>(null)
  const users = ref<User[]>([])
  const messages = ref<Message[]>([])
  const hasEarlierMessages = ref(false)
  const loadingEarlierMessages = ref(false)
  const settings = ref<ChannelSettings>({ audioBitrateKbps: 64, messageRetention: 500 })
  const onlineIds = ref<number[]>([])
  const socketStatus = ref<'offline' | 'connecting' | 'online'>('offline')
  let socket: WebSocket | null = null
  let reconnectTimer: number | undefined

  const isAdmin = computed(() => user.value?.role === 'channel_admin' || user.value?.role === 'server_admin')
  const isServerAdmin = computed(() => user.value?.role === 'server_admin')

  async function initialize() {
    try {
      await bootstrap()
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        throw error
      }
    } finally {
      ready.value = true
    }
  }

  async function bootstrap() {
    const data = await request<BootstrapData>('/api/bootstrap')
    user.value = data.user
    users.value = data.users
    settings.value = data.settings
    messages.value = data.messages
    hasEarlierMessages.value = data.messagesHasMore
    trimMessagesToRetention()
    onlineIds.value = data.onlineIds ?? []
    if (!socket) connectSocket()
  }

  async function login(username: string, password: string) {
    const payload = await request<AuthPayload>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    user.value = payload.user
    await bootstrap()
  }

  async function register(inviteCode: string, username: string, displayName: string, password: string) {
    const payload = await request<AuthPayload>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ inviteCode, username, displayName, password }),
    })
    user.value = payload.user
    await bootstrap()
  }

  async function logout() {
    try {
      await request<void>('/api/auth/logout', { method: 'POST' })
    } finally {
      stopSocket()
      user.value = null
      users.value = []
      messages.value = []
      hasEarlierMessages.value = false
      loadingEarlierMessages.value = false
      onlineIds.value = []
    }
  }

  async function sendMessage(content: string) {
    await request<{ message: Message }>('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  }

  async function loadEarlier() {
    if (!messages.value.length || !hasEarlierMessages.value || loadingEarlierMessages.value) return 0
    loadingEarlierMessages.value = true
    const before = messages.value[0].id
    try {
      const payload = await request<{ messages: Message[]; hasMore: boolean }>(`/api/messages?before=${before}&limit=50`)
      const known = new Set(messages.value.map((message) => message.id))
      const additions = payload.messages.filter((message) => !known.has(message.id))
      messages.value = [...additions, ...messages.value]
      hasEarlierMessages.value = payload.hasMore
      trimMessagesToRetention()
      return additions.length
    } finally {
      loadingEarlierMessages.value = false
    }
  }

  async function updateProfile(payload: { displayName: string; currentPassword?: string; newPassword?: string }) {
    const result = await request<{ user: User }>('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({
        displayName: payload.displayName,
        currentPassword: payload.currentPassword ?? '',
        newPassword: payload.newPassword ?? '',
      }),
    })
    user.value = result.user
    upsertUser(result.user)
  }

  function connectSocket() {
    stopSocket()
    if (!user.value) return
    socketStatus.value = 'connecting'
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${protocol}//${location.host}/api/ws`)
    socket.onopen = () => {
      socketStatus.value = 'online'
    }
    socket.onmessage = (messageEvent) => {
      const event = JSON.parse(messageEvent.data) as { type: string; data: unknown }
      handleEvent(event.type, event.data)
    }
    socket.onclose = (event) => {
      socket = null
      socketStatus.value = 'offline'
      if (event.code === 1008) {
        user.value = null
        return
      }
      if (user.value) {
        reconnectTimer = window.setTimeout(connectSocket, 2500)
      }
    }
  }

  function stopSocket() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    if (socket) {
      socket.onclose = null
      socket.close()
    }
    socket = null
    socketStatus.value = 'offline'
  }

  function handleEvent(type: string, data: unknown) {
    if (type === 'presence') {
      onlineIds.value = data as number[]
    } else if (type === 'message_created') {
      const message = data as Message
      if (!messages.value.some((item) => item.id === message.id)) {
        messages.value.push(message)
        trimMessagesToRetention()
        if (message.userId !== user.value?.id) useSoundStore().play('message')
      }
    } else if (type === 'message_deleted') {
      const id = (data as { id: number }).id
      messages.value = messages.value.filter((message) => message.id !== id)
    } else if (type === 'settings_updated') {
      settings.value = data as ChannelSettings
      trimMessagesToRetention()
    } else if (type === 'user_updated') {
      upsertUser(data as Partial<User> & { id: number })
    } else if (type === 'user_deleted') {
      removeUser((data as { id: number }).id)
    } else if (type === 'session_revoked') {
      stopSocket()
      user.value = null
    }
  }

  function upsertUser(update: Partial<User> & { id: number }) {
    const index = users.value.findIndex((item) => item.id === update.id)
    if (index >= 0) {
      users.value[index] = { ...users.value[index], ...update }
    } else if (isCompleteUser(update)) {
      users.value.push(update)
    }
    if (user.value?.id === update.id) user.value = { ...user.value, ...update }
  }

  function trimMessagesToRetention() {
    const excess = messages.value.length - settings.value.messageRetention
    if (excess > 0) messages.value.splice(0, excess)
  }

  function removeUser(userId: number) {
    users.value = users.value.filter((item) => item.id !== userId)
    onlineIds.value = onlineIds.value.filter((id) => id !== userId)
    messages.value = messages.value.map((message) => message.userId === userId
      ? { ...message, username: '', displayName: '已删除用户', role: 'member' }
      : message)
    if (user.value?.id === userId) {
      stopSocket()
      user.value = null
    }
  }

  return {
    ready,
    user,
    users,
    messages,
    hasEarlierMessages,
    loadingEarlierMessages,
    settings,
    onlineIds,
    socketStatus,
    isAdmin,
    isServerAdmin,
    initialize,
    bootstrap,
    login,
    register,
    logout,
    sendMessage,
    loadEarlier,
    updateProfile,
    removeUser,
  }
})

function isCompleteUser(value: Partial<User>): value is User {
  return typeof value.id === 'number' && typeof value.username === 'string' && typeof value.displayName === 'string'
}
