import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError, request } from '../api'
import type { BootstrapData, Channel, ChannelReadState, Message, ServerBootstrapData, ServerSummary, User, VoiceRoom } from '../types'
import { useSoundStore } from './sounds'

type AuthPayload = { user: User }
type SocketEvent = { type: string; serverId?: number; data: unknown }

interface MessageState {
  messages: Message[]
  hasEarlier: boolean
  loading: boolean
  loaded: boolean
}

const VOICE_ROOMS_REFRESH_DELAY_MS = 350

export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const user = ref<User | null>(null)
  const users = ref<User[]>([])
  const servers = ref<ServerSummary[]>([])
  const activeServerId = ref<number | null>(savedServerID())
  const channels = ref<Channel[]>([])
  const channelReadStates = ref<Record<number, ChannelReadState>>({})
  const messageStates = ref<Record<number, MessageState>>({})
  const activeTextChannelId = ref<number | null>(savedChannelID(activeServerId.value))
  const voiceRooms = ref<VoiceRoom[]>([])
  const onlineIds = ref<number[]>([])
  const socketStatus = ref<'offline' | 'connecting' | 'online'>('offline')
  let socket: WebSocket | null = null
  let reconnectTimer: number | undefined
  let pageLifecycleInstalled = false
  let synchronizingSocket: WebSocket | null = null
  let socketActivityVersion = 0
  let voiceRoomsRefreshTimer: number | undefined
  let serverBootstrapVersion = 0
  const messageLoadVersions = new Map<number, number>()

  const isAdmin = computed(() => activeServer.value?.role === 'owner' || activeServer.value?.role === 'admin')
  const isServerAdmin = computed(() => activeServer.value?.role === 'owner' || activeServer.value?.role === 'admin')
  const isPlatformAdmin = computed(() => user.value?.isPlatformAdmin === true)
  const activeServer = computed(() => servers.value.find((server) => server.id === activeServerId.value && server.joined) ?? null)
  const textChannels = computed(() => channels.value.filter((channel) => channel.type === 'text'))
  const voiceChannels = computed(() => channels.value.filter((channel) => channel.type === 'voice'))
  const activeTextChannel = computed(() => textChannels.value.find((channel) => channel.id === activeTextChannelId.value) ?? null)
  const activeMessageState = computed(() => activeTextChannelId.value === null ? emptyMessageState() : ensureMessageState(activeTextChannelId.value))
  const messages = computed(() => activeMessageState.value.messages)
  const hasEarlierMessages = computed(() => activeMessageState.value.hasEarlier)
  const loadingEarlierMessages = computed(() => activeMessageState.value.loading)
  const activeUnreadCount = computed(() => activeTextChannelId.value === null ? 0 : channelReadStates.value[activeTextChannelId.value]?.unreadCount ?? 0)

  async function initialize() {
    installPageLifecycle()
    try {
      await bootstrap()
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error
    } finally {
      ready.value = true
    }
  }

  async function bootstrap() {
    const data = await request<BootstrapData>('/api/bootstrap')
    user.value = data.user
    servers.value = data.servers ?? []
    const joined = servers.value.filter((server) => server.joined)
    if (!activeServerId.value || !joined.some((server) => server.id === activeServerId.value)) activeServerId.value = joined[0]?.id ?? null
    if (activeServerId.value !== null) await loadServerBootstrap(activeServerId.value)
    else clearServerState()
    if (!socket) connectSocket()
  }

  async function loadServerBootstrap(serverId: number) {
    const version = ++serverBootstrapVersion
    activeServerId.value = serverId
    const data = await request<ServerBootstrapData>(`/api/servers/${serverId}/bootstrap`)
    if (version !== serverBootstrapVersion || activeServerId.value !== serverId) return
    activeTextChannelId.value = savedChannelID(serverId)
    localStorage.setItem('cws.activeServerId', String(serverId))
    const members: User[] = data.members.map((member) => ({ id: member.userId, username: member.username, displayName: member.displayName, role: member.role, voiceMuted: member.voiceMuted, textMuted: member.textMuted, permanentlyBanned: member.permanentlyBanned, createdAt: member.joinedAt }))
    const currentUser = { ...user.value!, voiceMuted: data.membership.voiceMuted, textMuted: data.membership.textMuted }
    applyBootstrap({ user: currentUser, users: members, channels: data.channels, channelReadStates: data.channelReadStates, onlineIds: data.onlineIds, voiceRooms: data.voiceRooms })
  }

  async function selectServer(serverId: number) {
    if (!servers.value.some((server) => server.id === serverId && server.joined)) return
    if (serverId === activeServerId.value) return
    activeServerId.value = serverId
    clearServerState()
    await loadServerBootstrap(serverId)
  }

  function applyBootstrap(data: BootstrapData, invalidateMessages = false) {
    const previousChannelIDs = new Set(channels.value.map((channel) => channel.id))
    user.value = data.user
    users.value = data.users ?? []
    channels.value = Array.isArray(data.channels) ? data.channels : []
    voiceRooms.value = Array.isArray(data.voiceRooms) ? data.voiceRooms : []
    channelReadStates.value = Object.fromEntries((data.channelReadStates ?? []).map((state) => [state.channelId, state]))
    onlineIds.value = data.onlineIds ?? []
    const currentChannelIDs = new Set(channels.value.map((channel) => channel.id))
    previousChannelIDs.forEach((channelID) => {
      if (!currentChannelIDs.has(channelID)) clearChannelState(channelID)
    })
    normalizeChannelState()
    textChannels.value.forEach((channel) => {
      const state = ensureMessageState(channel.id)
      if (invalidateMessages) state.loaded = false
      trimMessagesToRetention(channel.id)
    })
  }

  async function login(username: string, password: string) {
    const payload = await request<AuthPayload>('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    })
    user.value = payload.user
    await bootstrap()
  }

  async function register(inviteCode: string, username: string, displayName: string, password: string) {
    const payload = await request<AuthPayload>('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ inviteCode, username, displayName, password }),
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
      servers.value = []
      activeServerId.value = null
      channels.value = []
      channelReadStates.value = {}
      messageStates.value = {}
      voiceRooms.value = []
      onlineIds.value = []
      activeTextChannelId.value = null
    }
  }

  async function selectTextChannel(channelId: number) {
    if (!textChannels.value.some((channel) => channel.id === channelId)) return
    activeTextChannelId.value = channelId
    if (activeServerId.value !== null) localStorage.setItem(activeChannelKey(activeServerId.value), String(channelId))
  }

  async function loadChannelMessages(channelId: number, force = false) {
    const state = ensureMessageState(channelId)
    if ((state.loaded && !force) || (state.loading && !force)) return
    const loadVersion = (messageLoadVersions.get(channelId) ?? 0) + 1
    messageLoadVersions.set(channelId, loadVersion)
    state.loading = true
    try {
      if (activeServerId.value === null) return
      const payload = await request<{ messages: Message[]; hasMore: boolean }>(`/api/servers/${activeServerId.value}/channels/${channelId}/messages?limit=50`)
      if (messageLoadVersions.get(channelId) !== loadVersion) return
      state.messages = payload.messages
      state.hasEarlier = payload.hasMore
      state.loaded = true
      trimMessagesToRetention(channelId)
    } finally {
      if (messageLoadVersions.get(channelId) === loadVersion) state.loading = false
    }
  }

  async function sendMessage(content: string) {
    if (activeTextChannelId.value === null) return
    if (activeServerId.value === null) return
    await request<{ message: Message }>(`/api/servers/${activeServerId.value}/channels/${activeTextChannelId.value}/messages`, {
      method: 'POST', body: JSON.stringify({ content }),
    })
  }

  async function loadEarlier() {
    const channelId = activeTextChannelId.value
    if (channelId === null) return 0
    const state = ensureMessageState(channelId)
    if (!state.messages.length || !state.hasEarlier || state.loading) return 0
    state.loading = true
    const before = state.messages[0].id
    try {
      if (activeServerId.value === null) return 0
      const payload = await request<{ messages: Message[]; hasMore: boolean }>(`/api/servers/${activeServerId.value}/channels/${channelId}/messages?before=${before}&limit=50`)
      if (activeTextChannelId.value !== channelId) return 0
      const known = new Set(state.messages.map((message) => message.id))
      const additions = payload.messages.filter((message) => !known.has(message.id))
      state.messages = [...additions, ...state.messages]
      state.hasEarlier = payload.hasMore
      trimMessagesToRetention(channelId)
      return additions.length
    } finally {
      state.loading = false
    }
  }

  async function markActiveChannelRead() {
    const channelId = activeTextChannelId.value
    if (channelId === null) return
    if (activeServerId.value === null) return
    const result = await request<{ readState: ChannelReadState }>(`/api/servers/${activeServerId.value}/channels/${channelId}/read`, { method: 'POST' })
    if (activeTextChannelId.value === channelId) applyReadState(result.readState)
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
    applyAccountUpdate(result.user)
  }

  function getChannelDraft(channelId: number) {
    return localStorage.getItem(`cws.server.${activeServerId.value ?? 0}.channelDraft.${channelId}`) ?? ''
  }

  function setChannelDraft(channelId: number, value: string) {
    const key = `cws.server.${activeServerId.value ?? 0}.channelDraft.${channelId}`
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }

  function getChannelScroll(channelId: number) {
    const saved = localStorage.getItem(`cws.server.${activeServerId.value ?? 0}.channelScroll.${channelId}`)
    if (saved === null) return null
    const value = Number(saved)
    if (!Number.isFinite(value) || value < 0) return null
    return { top: value, atBottom: localStorage.getItem(`cws.server.${activeServerId.value ?? 0}.channelAtBottom.${channelId}`) === 'true' }
  }

  function setChannelScroll(channelId: number, value: number, atBottom: boolean) {
    localStorage.setItem(`cws.server.${activeServerId.value ?? 0}.channelScroll.${channelId}`, String(Math.max(0, value)))
    localStorage.setItem(`cws.server.${activeServerId.value ?? 0}.channelAtBottom.${channelId}`, String(atBottom))
  }

  function connectSocket() {
    stopSocket()
    if (!user.value) return
    socketStatus.value = 'connecting'
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(`${protocol}//${location.host}/api/ws`)
    socket = connection
    connection.onopen = () => {
      synchronizingSocket = connection
      socketActivityVersion = 0
      void synchronizeSocket(connection)
    }
    connection.onmessage = (messageEvent) => {
      const event = JSON.parse(messageEvent.data) as SocketEvent
      if (synchronizingSocket === connection) {
        socketActivityVersion += 1
        return
      }
      handleEvent(event.type, event.data, event.serverId)
    }
    connection.onclose = (event) => {
      if (socket !== connection) return
      socket = null
      if (synchronizingSocket === connection) synchronizingSocket = null
      socketStatus.value = 'offline'
      if (event.code === 1008) {
        user.value = null
        return
      }
      if (user.value) reconnectTimer = window.setTimeout(connectSocket, 2500)
    }
  }

  async function synchronizeSocket(connection: WebSocket) {
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const activityVersion = socketActivityVersion
        const data = await request<BootstrapData>('/api/bootstrap')
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion) continue
        user.value = data.user
        servers.value = data.servers ?? servers.value
        if (activeServerId.value === null || !servers.value.some((server) => server.id === activeServerId.value && server.joined)) {
          activeServerId.value = servers.value.find((server) => server.joined)?.id ?? null
        }
        if (activeServerId.value === null) { clearServerState(); synchronizingSocket = null; socketStatus.value = 'online'; return }
        const serverData = await request<ServerBootstrapData>(`/api/servers/${activeServerId.value}/bootstrap`)
        const members: User[] = serverData.members.map((member) => ({ id: member.userId, username: member.username, displayName: member.displayName, role: member.role, voiceMuted: member.voiceMuted, textMuted: member.textMuted, permanentlyBanned: member.permanentlyBanned, createdAt: member.joinedAt }))
        const currentUser = { ...data.user, voiceMuted: serverData.membership.voiceMuted, textMuted: serverData.membership.textMuted }
        applyBootstrap({ user: currentUser, users: members, channels: serverData.channels, channelReadStates: serverData.channelReadStates, onlineIds: serverData.onlineIds, voiceRooms: serverData.voiceRooms }, true)
        const channelId = activeTextChannelId.value
        if (channelId !== null) await loadChannelMessages(channelId, true)
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion) continue
        synchronizingSocket = null
        socketStatus.value = 'online'
        return
      }
      connection.close(1012, 'state synchronization busy')
    } catch (error) {
      synchronizingSocket = null
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        user.value = null
        connection.close(1008, 'session revoked')
        return
      }
      if (socket === connection) connection.close(1012, 'state synchronization failed')
    }
  }

  function stopSocket() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    if (voiceRoomsRefreshTimer) window.clearTimeout(voiceRoomsRefreshTimer)
    voiceRoomsRefreshTimer = undefined
    if (socket) {
      socket.onclose = null
      socket.close()
    }
    socket = null
    synchronizingSocket = null
    socketStatus.value = 'offline'
  }

  function installPageLifecycle() {
    if (pageLifecycleInstalled) return
    pageLifecycleInstalled = true
    window.addEventListener('pagehide', closeSocketForPageExit)
    window.addEventListener('pageshow', reconnectSocketAfterRestore)
  }

  function closeSocketForPageExit() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    if (socket) {
      socket.onclose = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'page closed')
      }
    }
    socket = null
    synchronizingSocket = null
    socketStatus.value = 'offline'
  }

  function reconnectSocketAfterRestore() {
    if (user.value && !socket) connectSocket()
  }

  function requestVoiceRoomsRefresh() {
    if (voiceRoomsRefreshTimer !== undefined) return
    voiceRoomsRefreshTimer = window.setTimeout(() => {
      voiceRoomsRefreshTimer = undefined
      if (socket?.readyState !== WebSocket.OPEN) return
      try {
        socket.send(JSON.stringify({ type: 'refresh_voice_rooms' }))
      } catch {
        // The periodic server reconciliation remains the fallback if the socket closes concurrently.
      }
    }, VOICE_ROOMS_REFRESH_DELAY_MS)
  }

  function handleEvent(type: string, data: unknown, serverId?: number) {
    if (serverId && type !== 'server_added' && type !== 'server_removed' && serverId !== activeServerId.value) return
    if (type === 'server_added') {
      void bootstrap()
    } else if (type === 'server_removed') {
      const removedServerId = serverId ?? (data as { serverId?: number }).serverId
      servers.value = servers.value.filter((server) => server.id !== removedServerId)
      if (removedServerId === activeServerId.value) { activeServerId.value = null; void bootstrap() }
    } else if (type === 'server_updated') {
      const server = data as ServerSummary
      const index = servers.value.findIndex((item) => item.id === server.id)
      if (index >= 0) servers.value[index] = { ...servers.value[index], ...server }
    } else if (type === 'member_added' || type === 'member_updated') {
      const member = data as { userId: number; username: string; displayName: string; role: string; voiceMuted: boolean; textMuted: boolean; permanentlyBanned: boolean; joinedAt: string }
      upsertUser({ id: member.userId, username: member.username, displayName: member.displayName, role: member.role === 'owner' || member.role === 'admin' ? member.role : 'member', voiceMuted: member.voiceMuted, textMuted: member.textMuted, permanentlyBanned: member.permanentlyBanned, createdAt: member.joinedAt } as User)
    } else if (type === 'member_removed') {
      removeUser((data as { userId: number }).userId)
    } else if (type === 'presence') {
      const memberIDs = new Set(users.value.map((item) => item.id))
      onlineIds.value = (data as number[]).filter((id) => memberIDs.has(id))
    } else if (type === 'message_created') {
      const message = data as Message
      const state = ensureMessageState(message.channelId)
      const readState = ensureReadState(message.channelId)
      if (message.id <= readState.latestMessageId) return
      if (state.loaded && !state.messages.some((item) => item.id === message.id)) {
        state.messages.push(message)
        trimMessagesToRetention(message.channelId)
      }
      if (message.id > readState.lastReadMessageId) {
        const retention = channels.value.find((channel) => channel.id === message.channelId)?.messageRetention ?? 500
        readState.unreadCount = Math.min(readState.unreadCount + 1, retention)
      }
      readState.latestMessageId = message.id
      if (message.channelId === activeTextChannelId.value && message.userId !== user.value?.id) useSoundStore().play('message')
    } else if (type === 'message_deleted') {
      const payload = data as { channelId?: number; id: number }
      const channelId = payload.channelId ?? activeTextChannelId.value
      if (channelId === null) return
      const state = ensureMessageState(channelId)
      state.messages = state.messages.filter((message) => message.id !== payload.id)
      const readState = ensureReadState(channelId)
      if (payload.id > readState.lastReadMessageId && readState.unreadCount > 0) readState.unreadCount -= 1
    } else if (type === 'channel_created') {
      upsertChannel(data as Channel)
    } else if (type === 'channel_updated') {
      upsertChannel(data as Channel)
    } else if (type === 'channel_deleted') {
      removeChannel((data as { id: number }).id)
    } else if (type === 'channel_read') {
      const payload = data as { userId: number; readState: ChannelReadState }
      if (payload.userId === user.value?.id) applyReadState(payload.readState)
    } else if (type === 'voice_rooms') {
      voiceRooms.value = data as VoiceRoom[]
    } else if (type === 'user_updated') {
      applyAccountUpdate(data as Partial<User> & { id: number })
    } else if (type === 'user_deleted') {
      removeUser((data as { id: number }).id)
    } else if (type === 'session_revoked') {
      stopSocket()
      user.value = null
    }
  }

  function clearServerState() {
    users.value = []
    channels.value = []
    channelReadStates.value = {}
    messageStates.value = {}
    voiceRooms.value = []
    onlineIds.value = []
    activeTextChannelId.value = null
  }

  function applyAccountUpdate(update: Partial<User> & { id: number }) {
    const member = users.value.find((item) => item.id === update.id)
    if (member) {
      const { role, voiceMuted, textMuted, permanentlyBanned, temporaryBanUntil, ...accountFields } = update
      Object.assign(member, accountFields)
    }
    if (user.value?.id === update.id) {
      const voiceMuted = user.value.voiceMuted
      const textMuted = user.value.textMuted
      user.value = { ...user.value, ...update, voiceMuted, textMuted }
    }
  }

  function upsertChannel(channel: Channel) {
    const index = channels.value.findIndex((item) => item.id === channel.id)
    if (index >= 0) channels.value[index] = channel
    else channels.value.push(channel)
    channels.value.sort((a, b) => a.id - b.id)
    if (channel.type === 'text') {
      ensureMessageState(channel.id)
      const readState = ensureReadState(channel.id)
      readState.unreadCount = Math.min(readState.unreadCount, channel.messageRetention ?? 500)
      trimMessagesToRetention(channel.id)
    }
    normalizeChannelState()
  }

  function removeChannel(channelId: number) {
    channels.value = channels.value.filter((channel) => channel.id !== channelId)
    clearChannelState(channelId)
    normalizeChannelState()
  }

  function clearChannelState(channelId: number) {
    delete messageStates.value[channelId]
    delete channelReadStates.value[channelId]
    messageLoadVersions.delete(channelId)
    voiceRooms.value = voiceRooms.value.filter((room) => room.channelId !== channelId)
    localStorage.removeItem(`cws.server.${activeServerId.value ?? 0}.channelDraft.${channelId}`)
    localStorage.removeItem(`cws.server.${activeServerId.value ?? 0}.channelScroll.${channelId}`)
    localStorage.removeItem(`cws.server.${activeServerId.value ?? 0}.channelAtBottom.${channelId}`)
  }

  function normalizeChannelState() {
    const currentExists = textChannels.value.some((channel) => channel.id === activeTextChannelId.value)
    if (!currentExists) activeTextChannelId.value = textChannels.value[0]?.id ?? null
    if (activeTextChannelId.value !== null && activeServerId.value !== null) {
      localStorage.setItem(activeChannelKey(activeServerId.value), String(activeTextChannelId.value))
    }
    channels.value.filter((channel) => channel.type === 'text').forEach((channel) => {
      ensureMessageState(channel.id)
      ensureReadState(channel.id)
    })
  }

  function ensureMessageState(channelId: number): MessageState {
    if (!messageStates.value[channelId]) messageStates.value[channelId] = emptyMessageState()
    return messageStates.value[channelId]
  }

  function ensureReadState(channelId: number): ChannelReadState {
    if (!channelReadStates.value[channelId]) {
      channelReadStates.value[channelId] = { channelId, lastReadMessageId: 0, latestMessageId: 0, unreadCount: 0 }
    }
    return channelReadStates.value[channelId]
  }

  function applyReadState(readState: ChannelReadState) {
    channelReadStates.value[readState.channelId] = readState
  }

  function trimMessagesToRetention(channelId: number) {
    const state = ensureMessageState(channelId)
    const retention = channels.value.find((channel) => channel.id === channelId)?.messageRetention ?? 500
    const excess = state.messages.length - retention
    if (excess > 0) state.messages.splice(0, excess)
  }

  function upsertUser(update: Partial<User> & { id: number }) {
    const index = users.value.findIndex((item) => item.id === update.id)
    if (index >= 0) users.value[index] = { ...users.value[index], ...update }
    else if (isCompleteUser(update)) users.value.push(update)
    if (user.value?.id === update.id) user.value = { ...user.value, ...update }
  }

  function removeUser(userId: number) {
    users.value = users.value.filter((item) => item.id !== userId)
    onlineIds.value = onlineIds.value.filter((id) => id !== userId)
    Object.values(messageStates.value).forEach((state) => {
      state.messages = state.messages.map((message) => message.userId === userId
        ? { ...message, username: '', displayName: '已删除用户', role: 'member' }
        : message)
    })
    if (user.value?.id === userId) {
      stopSocket()
      user.value = null
    }
  }

  return {
    ready, user, users, servers, activeServerId, activeServer, channels, textChannels, voiceChannels, activeTextChannelId, activeTextChannel,
    voiceRooms, messages, hasEarlierMessages, loadingEarlierMessages, activeUnreadCount,
    channelReadStates, onlineIds, socketStatus, isAdmin, isServerAdmin, isPlatformAdmin,
    initialize, bootstrap, loadServerBootstrap, selectServer, login, register, logout, selectTextChannel, loadChannelMessages, requestVoiceRoomsRefresh,
    sendMessage, loadEarlier, markActiveChannelRead, updateProfile, getChannelDraft, setChannelDraft,
    getChannelScroll, setChannelScroll, removeUser,
  }
})

function emptyMessageState(): MessageState {
  return { messages: [], hasEarlier: false, loading: false, loaded: false }
}

function savedChannelID(serverId: number | null) {
  if (serverId === null) return null
  const key = activeChannelKey(serverId)
  const value = Number(localStorage.getItem(key))
  if (Number.isFinite(value) && value > 0) return value
  const legacyValue = Number(localStorage.getItem('cws.activeTextChannelId'))
  if (Number.isFinite(legacyValue) && legacyValue > 0) {
    localStorage.setItem(key, String(legacyValue))
    localStorage.removeItem('cws.activeTextChannelId')
    return legacyValue
  }
  return null
}

function activeChannelKey(serverId: number) {
  return `cws.server.${serverId}.activeTextChannelId`
}

function savedServerID() {
  const value = Number(localStorage.getItem('cws.activeServerId'))
  return Number.isFinite(value) && value > 0 ? value : null
}

function isCompleteUser(value: Partial<User>): value is User {
  return typeof value.id === 'number' && typeof value.username === 'string' && typeof value.displayName === 'string'
}
