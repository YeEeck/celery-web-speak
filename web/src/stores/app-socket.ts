import type { Ref } from 'vue'
import { ApiError, request } from '../api'
import type { BootstrapData, ClientType, GuildBootstrapData, GuildSummary, User } from '../types'
import { mapGuildMember } from './app-utils'

type SocketEvent = { type: string; guildId?: number; data: unknown }

const VOICE_ROOMS_REFRESH_DELAY_MS = 350

export interface SocketContext {
  user: Ref<User | null>
  guilds: Ref<GuildSummary[]>
  activeGuildId: Ref<number | null>
  activeTextChannelId: Ref<number | null>
  socketStatus: Ref<'offline' | 'connecting' | 'online'>
  handleEvent: (type: string, data: unknown, guildId?: number) => void
  clearGuildState: () => void
  applyBootstrap: (data: BootstrapData, invalidateMessages?: boolean) => void
  loadChannelMessages: (channelId: number, force?: boolean) => Promise<void>
  nextGuildBootstrapVersion: () => number
  isGuildBootstrapVersionCurrent: (version: number) => boolean
}

export function useSocket(ctx: SocketContext) {
  let socket: WebSocket | null = null
  let reconnectTimer: number | undefined
  let pageLifecycleInstalled = false
  let synchronizingSocket: WebSocket | null = null
  let socketActivityVersion = 0
  let voiceRoomsRefreshTimer: number | undefined

  function detectClientType(): ClientType {
    if (window.desktopApplicationAudio !== undefined) return 'electron'
    if (window.celeryShell !== undefined) return 'android'
    return 'web'
  }

  function connectSocket() {
    stopSocket()
    if (!ctx.user.value) return
    ctx.socketStatus.value = 'connecting'
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(`${protocol}//${location.host}/api/ws?client=${detectClientType()}`)
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
      ctx.handleEvent(event.type, event.data, event.guildId)
    }
    connection.onclose = (event) => {
      if (socket !== connection) return
      socket = null
      if (synchronizingSocket === connection) synchronizingSocket = null
      ctx.socketStatus.value = 'offline'
      if (event.code === 1008) {
        ctx.user.value = null
        return
      }
      if (ctx.user.value) reconnectTimer = window.setTimeout(connectSocket, 2500)
    }
  }

  async function synchronizeSocket(connection: WebSocket) {
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const activityVersion = socketActivityVersion
        const data = await request<BootstrapData>('/api/bootstrap')
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion) continue
        ctx.user.value = data.user
        ctx.guilds.value = data.guilds ?? ctx.guilds.value
        if (ctx.activeGuildId.value === null || !ctx.guilds.value.some((guild) => guild.id === ctx.activeGuildId.value && guild.joined)) {
          ctx.activeGuildId.value = ctx.guilds.value.find((guild) => guild.joined)?.id ?? null
        }
        if (ctx.activeGuildId.value === null) { ctx.clearGuildState(); synchronizingSocket = null; ctx.socketStatus.value = 'online'; return }
        const guildId = ctx.activeGuildId.value
        const bootstrapVersion = ctx.nextGuildBootstrapVersion()
        let guildData: GuildBootstrapData
        try {
          guildData = await request<GuildBootstrapData>(`/api/guilds/${guildId}/bootstrap`)
        } catch (error) {
          if (socket !== connection) return
          if (socketActivityVersion !== activityVersion || !ctx.isGuildBootstrapVersionCurrent(bootstrapVersion) || ctx.activeGuildId.value !== guildId) continue
          throw error
        }
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion || !ctx.isGuildBootstrapVersionCurrent(bootstrapVersion) || ctx.activeGuildId.value !== guildId) continue
        const members = guildData.members.map(mapGuildMember)
        const currentUser = { ...data.user, voiceMuted: guildData.membership.voiceMuted, textMuted: guildData.membership.textMuted, permanentlyBanned: guildData.membership.permanentlyBanned, temporaryBanUntil: guildData.membership.temporaryBanUntil }
        ctx.applyBootstrap({ user: currentUser, users: members, channels: guildData.channels, channelReadStates: guildData.channelReadStates, online: guildData.online, voiceRooms: guildData.voiceRooms }, true)
        const channelId = ctx.activeTextChannelId.value
        if (channelId !== null) await ctx.loadChannelMessages(channelId, true)
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion || !ctx.isGuildBootstrapVersionCurrent(bootstrapVersion) || ctx.activeGuildId.value !== guildId) continue
        synchronizingSocket = null
        ctx.socketStatus.value = 'online'
        return
      }
      connection.close(1012, 'state synchronization busy')
    } catch (error) {
      synchronizingSocket = null
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        ctx.user.value = null
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
    ctx.socketStatus.value = 'offline'
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
    ctx.socketStatus.value = 'offline'
  }

  function reconnectSocketAfterRestore() {
    if (ctx.user.value && !socket) connectSocket()
  }

  function requestVoiceRoomsRefresh() {
    if (voiceRoomsRefreshTimer !== undefined) return
    voiceRoomsRefreshTimer = window.setTimeout(() => {
      voiceRoomsRefreshTimer = undefined
      if (socket?.readyState !== WebSocket.OPEN) return
      try {
        socket.send(JSON.stringify({ type: 'refresh_voice_rooms' }))
      } catch {
        // The periodic guild reconciliation remains the fallback if the socket closes concurrently.
      }
    }, VOICE_ROOMS_REFRESH_DELAY_MS)
  }

  function isConnected() {
    return socket !== null
  }

  return {
    connectSocket,
    stopSocket,
    installPageLifecycle,
    requestVoiceRoomsRefresh,
    isConnected,
  }
}
