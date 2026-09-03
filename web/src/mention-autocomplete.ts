import { isSlashInput } from './slash-commands.ts'
import type { User } from './types.ts'

export interface MentionTrigger {
  atIndex: number
  query: string
}

export interface PendingMention {
  userId: number
  username: string
  start: number
  end: number
}

export interface FindMentionTriggerOptions {
  selectionEnd?: number
  pending?: readonly PendingMention[]
  dismissed?: MentionTrigger | null
}

const USERNAME_LEGAL = /[A-Za-z0-9_-]/

export function isUsernameLegalChar(char: string): boolean {
  return USERNAME_LEGAL.test(char)
}

export function findMentionTrigger(
  text: string,
  caret: number,
  options: FindMentionTriggerOptions = {},
): MentionTrigger | null {
  const selectionEnd = options.selectionEnd ?? caret
  if (selectionEnd !== caret || caret < 1 || isSlashInput(text)) return null
  if (options.pending?.some((mention) => caret > mention.start && caret <= mention.end)) return null
  const before = text.slice(0, caret)
  const atIndex = before.lastIndexOf('@')
  if (atIndex < 0) return null
  if (atIndex > 0 && isUsernameLegalChar(before[atIndex - 1]!)) return null
  const query = before.slice(atIndex + 1)
  if (![...query].every(isUsernameLegalChar)) return null
  const trigger = { atIndex, query }
  if (options.dismissed && sameMentionTrigger(options.dismissed, trigger)) return null
  return trigger
}

export function retainDismissedMentionTrigger(
  current: MentionTrigger | null,
  dismissed: MentionTrigger | null,
): MentionTrigger | null {
  if (!dismissed || !current) return null
  return sameMentionTrigger(dismissed, current) ? dismissed : null
}

function sameMentionTrigger(left: MentionTrigger, right: MentionTrigger): boolean {
  return left.atIndex === right.atIndex && left.query === right.query
}

export const MAX_PENDING_MENTIONS = 10

export type MentionCandidateList =
  | { kind: 'candidates'; members: User[] }
  | { kind: 'capped' }

export interface ListMentionCandidatesInput {
  query: string
  members: readonly User[]
  selfId: number | null
  pendingUserIds: readonly number[]
  now?: number
}

function isActiveMember(member: User, now: number): boolean {
  if (member.permanentlyBanned) return false
  return !member.temporaryBanUntil || new Date(member.temporaryBanUntil).getTime() <= now
}

function roleRank(role: string): number {
  if (role === 'owner') return 2
  if (role === 'admin') return 1
  return 0
}

function matchesQuery(member: User, query: string): boolean {
  if (!query) return true
  const prefix = query.toLocaleLowerCase()
  return member.username.toLocaleLowerCase().startsWith(prefix)
    || member.displayName.toLocaleLowerCase().startsWith(prefix)
}

export function listMentionCandidates(input: ListMentionCandidatesInput): MentionCandidateList {
  const now = input.now ?? Date.now()
  const pending = new Set(input.pendingUserIds)
  if (pending.size >= MAX_PENDING_MENTIONS) return { kind: 'capped' }
  const members = input.members
    .filter((member) => member.id !== input.selfId)
    .filter((member) => !pending.has(member.id))
    .filter((member) => isActiveMember(member, now))
    .filter((member) => matchesQuery(member, input.query))
    .sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.displayName.localeCompare(b.displayName, 'zh-CN'))
  return { kind: 'candidates', members }
}

export interface InsertMentionResult {
  text: string
  caret: number
  pending: PendingMention[]
}

export function insertMention(
  text: string,
  trigger: MentionTrigger,
  member: Pick<User, 'id' | 'username'>,
  pending: readonly PendingMention[],
): InsertMentionResult {
  const token = `@${member.username}`
  const replacement = `${token} `
  const rangeEnd = trigger.atIndex + 1 + trigger.query.length
  const nextText = `${text.slice(0, trigger.atIndex)}${replacement}${text.slice(rangeEnd)}`
  const delta = replacement.length - (rangeEnd - trigger.atIndex)
  const nextPending = pending
    .filter((mention) => mention.end <= trigger.atIndex || mention.start >= rangeEnd)
    .map((mention) => mention.start >= rangeEnd
      ? { ...mention, start: mention.start + delta, end: mention.end + delta }
      : mention)
  if (!nextPending.some((mention) => mention.userId === member.id) && nextPending.length < MAX_PENDING_MENTIONS) {
    nextPending.push({
      userId: member.id,
      username: member.username,
      start: trigger.atIndex,
      end: trigger.atIndex + token.length,
    })
  }
  return { text: nextText, caret: trigger.atIndex + replacement.length, pending: nextPending }
}

export function realignPendingMentions(
  nextText: string,
  previousText: string,
  pending: readonly PendingMention[],
): PendingMention[] {
  const edit = editRange(previousText, nextText)
  const delta = (edit.nextEnd - edit.start) - (edit.previousEnd - edit.start)
  return pending.flatMap((mention) => {
    if (boundSpanMatches(nextText, mention)) return [mention]
    let next = mention
    if (mention.end <= edit.start) {
      next = mention
    } else if (mention.start >= edit.previousEnd) {
      next = { ...mention, start: mention.start + delta, end: mention.end + delta }
    } else {
      return []
    }
    return boundSpanMatches(nextText, next) ? [next] : []
  })
}

function editRange(previousText: string, nextText: string) {
  let start = 0
  const maxStart = Math.min(previousText.length, nextText.length)
  while (start < maxStart && previousText[start] === nextText[start]) start++
  let previousEnd = previousText.length
  let nextEnd = nextText.length
  while (previousEnd > start && nextEnd > start && previousText[previousEnd - 1] === nextText[nextEnd - 1]) {
    previousEnd--
    nextEnd--
  }
  return { start, previousEnd, nextEnd }
}

function boundSpanMatches(text: string, mention: PendingMention): boolean {
  if (mention.start < 0 || mention.end > text.length || mention.end <= mention.start) return false
  const token = text.slice(mention.start, mention.end)
  if (token[0] !== '@') return false
  if (token.slice(1).toLocaleLowerCase() !== mention.username.toLocaleLowerCase()) return false
  if (mention.start > 0 && isUsernameLegalChar(text[mention.start - 1]!)) return false
  if (mention.end < text.length && isUsernameLegalChar(text[mention.end]!)) return false
  return true
}

export function channelDraftMentionsKey(guildId: number, channelId: number): string {
  return `cws.guild.${guildId}.channelDraftMentions.${channelId}`
}

export function serializeDraftMentions(pending: readonly PendingMention[]): string {
  return JSON.stringify(pending.map((mention) => ({
    userId: mention.userId,
    username: mention.username,
    start: mention.start,
    end: mention.end,
  })))
}

export function parseDraftMentions(stored: string | null, text: string): PendingMention[] {
  if (!stored) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const pending: PendingMention[] = []
  for (const item of parsed) {
    if (!isPendingMentionRecord(item)) continue
    if (boundSpanMatches(text, item)) pending.push(item)
  }
  return pending
}

function isPendingMentionRecord(value: unknown): value is PendingMention {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.userId === 'number'
    && typeof record.username === 'string'
    && typeof record.start === 'number'
    && typeof record.end === 'number'
}
