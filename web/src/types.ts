export type Role = 'member' | 'channel_admin' | 'server_admin' | 'platform_admin'
export type ChannelType = 'text' | 'voice'
export type GuildRole = 'owner' | 'admin' | 'member'

export interface ServerSummary {
  id: number
  name: string
  ownerUserId: number
  createdBy: number
  createdAt: string
  updatedAt: string
  joined: boolean
  role?: GuildRole
  memberCount?: number
  unreadCount?: number
}

export interface User {
  id: number
  username: string
  displayName: string
  role: Role
  voiceMuted: boolean
  textMuted: boolean
  permanentlyBanned: boolean
  temporaryBanUntil?: string
  createdAt: string
  isPlatformAdmin?: boolean
}

export interface Message {
	id: number
	channelId: number
  userId: number
  username: string
  displayName: string
  role: GuildRole
  content: string
  createdAt: string
}

export interface Channel {
	id: number
	serverId?: number
	type: ChannelType
	name: string
	audioBitrateKbps?: number
	backgroundAudioBitrateKbps?: number
	audioRedEnabled?: boolean
	backgroundAudioRedEnabled?: boolean
	messageRetention?: number
	createdAt: string
	updatedAt: string
}

export interface ChannelReadState {
	channelId: number
	lastReadMessageId: number
	latestMessageId: number
	unreadCount: number
}

export interface VoiceRoomParticipant {
	userId: number
	identity: string
	name: string
	joinedAt: number
}

export interface VoiceRoom {
	channelId: number
	participants: VoiceRoomParticipant[]
}

export interface Invite {
  id: number
  code?: string
  maxUses: number
  useCount: number
  expiresAt: string
  revokedAt?: string
  createdAt: string
  createdBy: number
}

export interface BootstrapData {
  user: User
	servers?: ServerSummary[]
	users?: User[]
	messages?: Message[]
	messagesHasMore?: boolean
	onlineIds: number[]
	channels?: Channel[]
	channelReadStates?: ChannelReadState[]
	voiceRooms?: VoiceRoom[]
}

export interface ServerBootstrapData {
  server: ServerSummary
  membership: { guildId: number; userId: number; username: string; displayName: string; role: GuildRole; voiceMuted: boolean; textMuted: boolean }
  members: Array<{ guildId: number; userId: number; username: string; displayName: string; role: GuildRole; voiceMuted: boolean; textMuted: boolean; permanentlyBanned: boolean; joinedAt: string }>
  channels: Channel[]
  channelReadStates: ChannelReadState[]
  onlineIds: number[]
  voiceRooms: VoiceRoom[]
}

export interface VoiceCredentials {
  url: string
  token: string
	roomName: string
	channelId: number
}

export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export interface ChangelogResponse {
  entries: ChangelogEntry[]
  total: number
  page: number
  size: number
}

export interface VersionResponse {
  version: string
}
