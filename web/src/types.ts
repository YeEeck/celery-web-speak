export type Role = 'member' | 'channel_admin' | 'server_admin'

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
}

export interface Message {
  id: number
  userId: number
  username: string
  displayName: string
  role: Role
  content: string
  createdAt: string
}

export interface ChannelSettings {
  audioBitrateKbps: number
  messageRetention: number
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
  users: User[]
  settings: ChannelSettings
  messages: Message[]
  onlineIds: number[]
}

export interface VoiceCredentials {
  url: string
  token: string
  roomName: string
}
