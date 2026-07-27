import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError, request } from '../api'
import type { BootstrapData, Channel, ChannelReadState, ClientType, GuildBootstrapData, GuildMemberPayload, GuildSummary, Message, OnlineClient, User, VoiceRoom } from '../types'
import { useSoundStore } from './sounds'
import { activeChannelKey, emptyMessageState, isCompleteUser, mapGuildMember, savedChannelID, savedGuildID, type MessageState } from './app-utils'
import { useSocket } from './app-socket'

type AuthPayload = { user: User }

export const useAppStore = defineStore('app', () => {
  const ready = ref(false)
  const user = ref<User | null>(null)
  const users = ref<User[]>([])
  const guilds = ref<GuildSummary[]>([])
  const activeGuildId = ref<number | null>(savedGuildID())
  const channels = ref<Channel[]>([])
  const channelReadStates = ref<Record<number, ChannelReadState>>({})
  const messageStates = ref<Record<number, MessageState>>({})
  const activeTextChannelId = ref<number | null>(savedChannelID(activeGuildId.value))
  const voiceRooms = ref<VoiceRoom[]>([])
  const onlineIds = ref<number[]>([])
  const onlineClients = ref<Record<number, ClientType>>({})
  const socketStatus = ref<'offline' | 'connecting' | 'online'>('offline')
  let guildBootstrapVersion = 0
  const messageLoadVersions = new Map<number, number>()

  const socket = useSocket({
    user,
    guilds,
    activeGuildId,
    activeTextChannelId,
    socketStatus,
    handleEvent,
    clearGuildState,
    applyBootstrap,
    loadChannelMessages,
    nextGuildBootstrapVersion: () => ++guildBootstrapVersion,
    isGuildBootstrapVersionCurrent: (version) => version === guildBootstrapVersion,
  })

  const isAdmin = computed(() => activeGuild.value?.role === 'owner' || activeGuild.value?.role === 'admin')
  const isGuildAdmin = computed(() => activeGuild.value?.role === 'owner' || activeGuild.value?.role === 'admin')
  const isPlatformAdmin = computed(() => user.value?.isPlatformAdmin === true)
  const activeGuild = computed(() => guilds.value.find((guild) => guild.id === activeGuildId.value && guild.joined) ?? null)
  const textChannels = computed(() => channels.value.filter((channel) => channel.type === 'text'))
  const voiceChannels = computed(() => channels.value.filter((channel) => channel.type === 'voice'))
  const activeTextChannel = computed(() => textChannels.value.find((channel) => channel.id === activeTextChannelId.value) ?? null)
  const activeMessageState = computed(() => activeTextChannelId.value === null ? emptyMessageState() : ensureMessageState(activeTextChannelId.value))
  const messages = computed(() => activeMessageState.value.messages)
  const hasEarlierMessages = computed(() => activeMessageState.value.hasEarlier)
  const loadingEarlierMessages = computed(() => activeMessageState.value.loading)
  const activeUnreadCount = computed(() => activeTextChannelId.value === null ? 0 : channelReadStates.value[activeTextChannelId.value]?.unreadCount ?? 0)

  async function initialize() {
    socket.installPageLifecycle()
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
    guilds.value = data.guilds ?? []
    const joined = guilds.value.filter((guild) => guild.joined)
    if (!activeGuildId.value || !joined.some((guild) => guild.id === activeGuildId.value)) activeGuildId.value = joined[0]?.id ?? null
    if (activeGuildId.value !== null) await loadGuildBootstrap(activeGuildId.value)
    else clearGuildState()
    if (!socket.isConnected()) socket.connectSocket()
  }

  async function loadGuildBootstrap(guildId: number) {
    const version = ++guildBootstrapVersion
    activeGuildId.value = guildId
    const data = await request<GuildBootstrapData>(`/api/guilds/${guildId}/bootstrap`)
    if (version !== guildBootstrapVersion || activeGuildId.value !== guildId) return
    updateGuildMembershipRole(guildId, data.membership.role)
    activeTextChannelId.value = savedChannelID(guildId)
    localStorage.setItem('cws.activeGuildId', String(guildId))
    const members = data.members.map(mapGuildMember)
    const currentUser = { ...user.value!, voiceMuted: data.membership.voiceMuted, textMuted: data.membership.textMuted, permanentlyBanned: data.membership.permanentlyBanned, temporaryBanUntil: data.membership.temporaryBanUntil }
    applyBootstrap({ user: currentUser, users: members, channels: data.channels, channelReadStates: data.channelReadStates, online: data.online, voiceRooms: data.voiceRooms })
  }

  async function selectGuild(guildId: number) {
    if (!guilds.value.some((guild) => guild.id === guildId && guild.joined)) return
    if (guildId === activeGuildId.value) return
    activeGuildId.value = guildId
    clearGuildState()
    await loadGuildBootstrap(guildId)
  }

  function applyBootstrap(data: BootstrapData, invalidateMessages = false) {
    const previousChannelIDs = new Set(channels.value.map((channel) => channel.id))
    user.value = data.user
    users.value = data.users ?? []
    channels.value = Array.isArray(data.channels) ? data.channels : []
    voiceRooms.value = Array.isArray(data.voiceRooms) ? data.voiceRooms : []
    channelReadStates.value = Object.fromEntries((data.channelReadStates ?? []).map((state) => [state.channelId, state]))
    const online = data.online ?? []
    onlineIds.value = online.map((entry) => entry.userId)
    onlineClients.value = Object.fromEntries(online.map((entry) => [entry.userId, entry.client] as const))
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
      socket.stopSocket()
      user.value = null
      users.value = []
      guilds.value = []
      activeGuildId.value = null
      channels.value = []
      channelReadStates.value = {}
      messageStates.value = {}
      voiceRooms.value = []
      onlineIds.value = []
      onlineClients.value = {}
      activeTextChannelId.value = null
    }
  }

  async function selectTextChannel(channelId: number) {
    if (!textChannels.value.some((channel) => channel.id === channelId)) return
    activeTextChannelId.value = channelId
    if (activeGuildId.value !== null) localStorage.setItem(activeChannelKey(activeGuildId.value), String(channelId))
  }

  async function loadChannelMessages(channelId: number, force = false) {
    const state = ensureMessageState(channelId)
    if ((state.loaded && !force) || (state.loading && !force)) return
    const loadVersion = (messageLoadVersions.get(channelId) ?? 0) + 1
    messageLoadVersions.set(channelId, loadVersion)
    state.loading = true
    try {
      const guildId = activeGuildId.value
      if (guildId === null) return
      const payload = await request<{ messages: Message[]; hasMore: boolean }>(`/api/guilds/${guildId}/channels/${channelId}/messages?limit=50`)
      if (messageLoadVersions.get(channelId) !== loadVersion || activeGuildId.value !== guildId || !channels.value.some((channel) => channel.id === channelId)) return
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
    if (activeGuildId.value === null) return
    await request<{ message: Message }>(`/api/guilds/${activeGuildId.value}/channels/${activeTextChannelId.value}/messages`, {
      method: 'POST', body: JSON.stringify({ content }),
    })
  }

  async function loadEarlier() {
    const channelId = activeTextChannelId.value
    const guildId = activeGuildId.value
    if (channelId === null || guildId === null) return 0
    const state = ensureMessageState(channelId)
    if (!state.messages.length || !state.hasEarlier || state.loading) return 0
    state.loading = true
    const before = state.messages[0].id
    try {
      const payload = await request<{ messages: Message[]; hasMore: boolean }>(`/api/guilds/${guildId}/channels/${channelId}/messages?before=${before}&limit=50`)
      if (activeGuildId.value !== guildId || activeTextChannelId.value !== channelId) return 0
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

  async function markChannelRead(channelId: number) {
    const guildId = activeGuildId.value
    if (guildId === null || !textChannels.value.some((channel) => channel.id === channelId)) return
    const result = await request<{ readState: ChannelReadState }>(`/api/guilds/${guildId}/channels/${channelId}/read`, { method: 'POST' })
    if (activeGuildId.value === guildId && textChannels.value.some((channel) => channel.id === channelId)) applyReadState(result.readState)
  }

  async function markActiveChannelRead() {
    if (activeTextChannelId.value === null) return
    await markChannelRead(activeTextChannelId.value)
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
    return localStorage.getItem(`cws.guild.${activeGuildId.value ?? 0}.channelDraft.${channelId}`) ?? ''
  }

  function setChannelDraft(channelId: number, value: string) {
    const key = `cws.guild.${activeGuildId.value ?? 0}.channelDraft.${channelId}`
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }

  function getChannelScroll(channelId: number) {
    const saved = localStorage.getItem(`cws.guild.${activeGuildId.value ?? 0}.channelScroll.${channelId}`)
    if (saved === null) return null
    const value = Number(saved)
    if (!Number.isFinite(value) || value < 0) return null
    return { top: value, atBottom: localStorage.getItem(`cws.guild.${activeGuildId.value ?? 0}.channelAtBottom.${channelId}`) === 'true' }
  }

  function setChannelScroll(channelId: number, value: number, atBottom: boolean) {
    localStorage.setItem(`cws.guild.${activeGuildId.value ?? 0}.channelScroll.${channelId}`, String(Math.max(0, value)))
    localStorage.setItem(`cws.guild.${activeGuildId.value ?? 0}.channelAtBottom.${channelId}`, String(atBottom))
  }

  function handleEvent(type: string, data: unknown, guildId?: number) {
    if (guildId && (type === 'member_added' || type === 'member_updated')) {
      const member = data as GuildMemberPayload
      if (member.userId === user.value?.id) updateGuildMembershipRole(guildId, member.role)
      if (guildId !== activeGuildId.value) return
    }
    if (guildId && type !== 'guild_added' && type !== 'guild_removed' && type !== 'guild_updated' && guildId !== activeGuildId.value) return
    if (type === 'guild_added') {
      void bootstrap()
    } else if (type === 'guild_removed') {
      const removedGuildId = guildId ?? (data as { guildId?: number }).guildId
      guilds.value = guilds.value.filter((guild) => guild.id !== removedGuildId)
      if (removedGuildId === activeGuildId.value) { activeGuildId.value = null; void bootstrap() }
    } else if (type === 'guild_updated') {
      const guild = data as GuildSummary
      const index = guilds.value.findIndex((item) => item.id === guild.id)
      if (index >= 0) guilds.value[index] = { ...guilds.value[index], ...guild }
    } else if (type === 'member_added' || type === 'member_updated') {
      const member = data as GuildMemberPayload
      upsertUser(mapGuildMember(member))
    } else if (type === 'member_removed') {
      removeUser((data as { userId: number }).userId)
    } else if (type === 'presence') {
      const memberIDs = new Set(users.value.map((item) => item.id))
      const online = (data as OnlineClient[]).filter((entry) => memberIDs.has(entry.userId))
      onlineIds.value = online.map((entry) => entry.userId)
      onlineClients.value = Object.fromEntries(online.map((entry) => [entry.userId, entry.client] as const))
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
      socket.stopSocket()
      user.value = null
    }
  }

  function clearGuildState() {
    users.value = []
    channels.value = []
    channelReadStates.value = {}
    messageStates.value = {}
    voiceRooms.value = []
    onlineIds.value = []
    onlineClients.value = {}
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
    localStorage.removeItem(`cws.guild.${activeGuildId.value ?? 0}.channelDraft.${channelId}`)
    localStorage.removeItem(`cws.guild.${activeGuildId.value ?? 0}.channelScroll.${channelId}`)
    localStorage.removeItem(`cws.guild.${activeGuildId.value ?? 0}.channelAtBottom.${channelId}`)
  }

  function normalizeChannelState() {
    const currentExists = textChannels.value.some((channel) => channel.id === activeTextChannelId.value)
    if (!currentExists) activeTextChannelId.value = textChannels.value[0]?.id ?? null
    if (activeTextChannelId.value !== null && activeGuildId.value !== null) {
      localStorage.setItem(activeChannelKey(activeGuildId.value), String(activeTextChannelId.value))
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

  function updateGuildMembershipRole(guildId: number, role: GuildMemberPayload['role']) {
    const guildIndex = guilds.value.findIndex((guild) => guild.id === guildId)
    if (guildIndex >= 0) guilds.value[guildIndex] = { ...guilds.value[guildIndex], role }
  }

  function removeUser(userId: number) {
    users.value = users.value.filter((item) => item.id !== userId)
    onlineIds.value = onlineIds.value.filter((id) => id !== userId)
    delete onlineClients.value[userId]
    Object.values(messageStates.value).forEach((state) => {
      state.messages = state.messages.map((message) => message.userId === userId
        ? { ...message, username: '', displayName: '已删除用户', role: 'member' }
        : message)
    })
    if (user.value?.id === userId) {
      socket.stopSocket()
      user.value = null
    }
  }

  return {
    ready, user, users, guilds, activeGuildId, activeGuild, channels, textChannels, voiceChannels, activeTextChannelId, activeTextChannel,
    voiceRooms, messages, hasEarlierMessages, loadingEarlierMessages, activeUnreadCount,
    channelReadStates, onlineIds, onlineClients, socketStatus, isAdmin, isGuildAdmin, isPlatformAdmin,
    initialize, bootstrap, loadGuildBootstrap, selectGuild, login, register, logout, selectTextChannel, loadChannelMessages, requestVoiceRoomsRefresh: socket.requestVoiceRoomsRefresh,
    sendMessage, loadEarlier, markChannelRead, markActiveChannelRead, updateProfile, getChannelDraft, setChannelDraft,
    getChannelScroll, setChannelScroll, removeUser,
  }
})
