import { isUsernameLegalChar } from './mention-autocomplete.ts'
import type { MessageMention } from './types.ts'

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: number; self: boolean }

export interface MentionViewContext {
  currentUserId: number | null
  authorUserId: number
}

export function mentionSegments(
  content: string,
  mentions: readonly MessageMention[] | undefined | null,
  context: MentionViewContext,
): MentionSegment[] {
  if (!mentions?.length) return [{ kind: 'text', text: content }]
  const hits: { start: number; end: number; userId: number }[] = []
  for (const mention of mentions) {
    const range = findNextCompleteMentionToken(content, mention.username, hits)
    if (!range) continue
    hits.push({ ...range, userId: mention.userId })
  }
  if (!hits.length) return [{ kind: 'text', text: content }]
  hits.sort((a, b) => a.start - b.start)
  const segments: MentionSegment[] = []
  let cursor = 0
  const markSelf = context.currentUserId !== null && context.authorUserId !== context.currentUserId
  for (const hit of hits) {
    if (hit.start > cursor) segments.push({ kind: 'text', text: content.slice(cursor, hit.start) })
    segments.push({
      kind: 'mention',
      text: content.slice(hit.start, hit.end),
      userId: hit.userId,
      self: markSelf && hit.userId === context.currentUserId,
    })
    cursor = hit.end
  }
  if (cursor < content.length) segments.push({ kind: 'text', text: content.slice(cursor) })
  return segments
}

function findNextCompleteMentionToken(
  content: string,
  username: string,
  occupied: readonly { start: number; end: number }[],
): { start: number; end: number } | null {
  const needle = username.toLocaleLowerCase()
  let index = 0
  while (index < content.length) {
    const at = content.indexOf('@', index)
    if (at < 0) return null
    if (occupied.some((range) => at >= range.start && at < range.end)) {
      index = at + 1
      continue
    }
    if (at > 0 && isUsernameLegalChar(content[at - 1]!)) {
      index = at + 1
      continue
    }
    let end = at + 1
    while (end < content.length && isUsernameLegalChar(content[end]!)) end++
    const token = content.slice(at + 1, end)
    if (token.toLocaleLowerCase() === needle) return { start: at, end }
    index = at + 1
  }
  return null
}
