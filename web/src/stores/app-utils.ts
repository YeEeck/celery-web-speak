import type { GuildMemberPayload, User } from '../types'

export interface MessageState {
  messages: import('../types').Message[]
  hasEarlier: boolean
  loading: boolean
  loaded: boolean
}

export function emptyMessageState(): MessageState {
  return { messages: [], hasEarlier: false, loading: false, loaded: false }
}

export function savedChannelID(guildId: number | null) {
  if (guildId === null) return null
  const key = activeChannelKey(guildId)
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

export function activeChannelKey(guildId: number) {
  return `cws.guild.${guildId}.activeTextChannelId`
}

export function savedGuildID() {
  const value = Number(localStorage.getItem('cws.activeGuildId'))
  return Number.isFinite(value) && value > 0 ? value : null
}

export function isCompleteUser(value: Partial<User>): value is User {
  return typeof value.id === 'number' && typeof value.username === 'string' && typeof value.displayName === 'string'
}

export function mapGuildMember(member: GuildMemberPayload): User {
  return {
    id: member.userId,
    username: member.username,
    displayName: member.displayName,
    role: member.role,
    voiceMuted: member.voiceMuted,
    textMuted: member.textMuted,
    permanentlyBanned: member.permanentlyBanned,
    temporaryBanUntil: member.temporaryBanUntil,
    createdAt: member.joinedAt,
    avatarVersion: member.avatarVersion,
    hasAvatar: member.hasAvatar,
  }
}
