import type { Ref } from 'vue'
import { ApiError, request } from '../api'
import type { BootstrapData, ClientType, ServerBootstrapData, ServerSummary, User } from '../types'
import { mapGuildMember } from './app-utils'

type SocketEvent = { type: string; serverId?: number; data: unknown }

const VOICE_ROOMS_REFRESH_DELAY_MS = 350

export interface SocketContext {
  user: Ref<User | null>
  servers: Ref<ServerSummary[]>
  activeServerId: Ref<number | null>
  activeTextChannelId: Ref<number | null>
  socketStatus: Ref<'offline' | 'connecting' | 'online'>
  handleEvent: (type: string, data: unknown, serverId?: number) => void
  clearServerState: () => void
  applyBootstrap: (data: BootstrapData, invalidateMessages?: boolean) => void
  loadChannelMessages: (channelId: number, force?: boolean) => Promise<void>
  nextServerBootstrapVersion: () => number
  isServerBootstrapVersionCurrent: (version: number) => boolean
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
      ctx.handleEvent(event.type, event.data, event.serverId)
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
        ctx.servers.value = data.servers ?? ctx.servers.value
        if (ctx.activeServerId.value === null || !ctx.servers.value.some((server) => server.id === ctx.activeServerId.value && server.joined)) {
          ctx.activeServerId.value = ctx.servers.value.find((server) => server.joined)?.id ?? null
        }
        if (ctx.activeServerId.value === null) { ctx.clearServerState(); synchronizingSocket = null; ctx.socketStatus.value = 'online'; return }
        const serverId = ctx.activeServerId.value
        const bootstrapVersion = ctx.nextServerBootstrapVersion()
        let serverData: ServerBootstrapData
        try {
          serverData = await request<ServerBootstrapData>(`/api/servers/${serverId}/bootstrap`)
        } catch (error) {
          if (socket !== connection) return
          if (socketActivityVersion !== activityVersion || !ctx.isServerBootstrapVersionCurrent(bootstrapVersion) || ctx.activeServerId.value !== serverId) continue
          throw error
        }
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion || !ctx.isServerBootstrapVersionCurrent(bootstrapVersion) || ctx.activeServerId.value !== serverId) continue
        const members = serverData.members.map(mapGuildMember)
        const currentUser = { ...data.user, voiceMuted: serverData.membership.voiceMuted, textMuted: serverData.membership.textMuted, permanentlyBanned: serverData.membership.permanentlyBanned, temporaryBanUntil: serverData.membership.temporaryBanUntil }
        ctx.applyBootstrap({ user: currentUser, users: members, channels: serverData.channels, channelReadStates: serverData.channelReadStates, online: serverData.online, voiceRooms: serverData.voiceRooms }, true)
        const channelId = ctx.activeTextChannelId.value
        if (channelId !== null) await ctx.loadChannelMessages(channelId, true)
        if (socket !== connection) return
        if (socketActivityVersion !== activityVersion || !ctx.isServerBootstrapVersionCurrent(bootstrapVersion) || ctx.activeServerId.value !== serverId) continue
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
        // The periodic server reconciliation remains the fallback if the socket closes concurrently.
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
