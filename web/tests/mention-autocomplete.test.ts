import assert from 'node:assert/strict'
import test from 'node:test'
import {
  channelDraftMentionsKey,
  findMentionTrigger,
  insertMention,
  listMentionCandidates,
  parseDraftMentions,
  realignPendingMentions,
  retainDismissedMentionTrigger,
  serializeDraftMentions,
} from '../src/mention-autocomplete.ts'
import type { User } from '../src/types.ts'

function member(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    username: 'alice',
    displayName: 'Alice',
    role: 'member',
    voiceMuted: false,
    textMuted: false,
    permanentlyBanned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    avatarVersion: 0,
    hasAvatar: false,
    callReceiving: true,
    ...overrides,
  }
}

test('opens mention autocomplete on ASCII @ at the start of the line', () => {
  assert.deepEqual(findMentionTrigger('@', 1), { atIndex: 0, query: '' })
})

test('opens after a non-username character and keeps the typed query', () => {
  assert.deepEqual(findMentionTrigger('找@al', 4), { atIndex: 1, query: 'al' })
})

test('does not open when the character before @ is a username-legal character', () => {
  assert.equal(findMentionTrigger('hello@al', 8), null)
})

test('keeps the query casing after @', () => {
  assert.deepEqual(findMentionTrigger('@AL', 3), { atIndex: 0, query: 'AL' })
})

test('does not open mention autocomplete on a slash-command line', () => {
  assert.equal(findMentionTrigger('/xp get @al', 11), null)
  assert.equal(findMentionTrigger('  /xp @al', 9), null)
})

test('treats fullwidth ＠ as ordinary text', () => {
  assert.equal(findMentionTrigger('＠alice', 6), null)
})

test('follows the caret: query is the username-legal run after @ before the caret', () => {
  assert.deepEqual(findMentionTrigger('@al ice', 3), { atIndex: 0, query: 'al' })
})

test('closes when an empty query is followed by a space', () => {
  assert.equal(findMentionTrigger('@ alice', 2), null)
})

test('empty query lists pokeable people excluding self, already pending, and banned members', () => {
  const self = member({ id: 1, username: 'me', displayName: 'Me', role: 'owner' })
  const bob = member({ id: 2, username: 'bob', displayName: 'Bob', role: 'admin' })
  const already = member({ id: 3, username: 'cara', displayName: 'Cara' })
  const banned = member({ id: 4, username: 'dan', displayName: 'Dan', permanentlyBanned: true })
  const tempBanned = member({
    id: 5,
    username: 'eve',
    displayName: 'Eve',
    temporaryBanUntil: '2099-01-01T00:00:00.000Z',
  })
  const away = member({ id: 6, username: 'finn', displayName: 'Finn' })
  const expiredBan = member({
    id: 7,
    username: 'gina',
    displayName: 'Gina',
    temporaryBanUntil: '2020-01-01T00:00:00.000Z',
  })
  const result = listMentionCandidates({
    query: '',
    members: [self, bob, already, banned, tempBanned, away, expiredBan],
    selfId: self.id,
    pendingUserIds: [already.id],
    now: Date.parse('2026-09-03T00:00:00.000Z'),
  })
  assert.equal(result.kind, 'candidates')
  if (result.kind === 'candidates') {
    assert.deepEqual(result.members.map((item) => item.username), ['bob', 'finn', 'gina'])
  }
})

test('sorts empty-query candidates by role then displayName like the member list', () => {
  const result = listMentionCandidates({
    query: '',
    members: [
      member({ id: 2, username: 'member_b', displayName: '张三', role: 'member' }),
      member({ id: 3, username: 'member_a', displayName: '李四', role: 'member' }),
      member({ id: 4, username: 'admin_a', displayName: '管理员乙', role: 'admin' }),
      member({ id: 5, username: 'owner_a', displayName: '服主', role: 'owner' }),
      member({ id: 6, username: 'admin_b', displayName: '管理员甲', role: 'admin' }),
    ],
    selfId: 1,
    pendingUserIds: [],
  })
  assert.equal(result.kind, 'candidates')
  if (result.kind === 'candidates') {
    assert.deepEqual(result.members.map((item) => item.username), [
      'owner_a',
      'admin_b',
      'admin_a',
      'member_a',
      'member_b',
    ])
  }
})

test('prefix-filters from the first character against username or displayName, case-insensitively', () => {
  const result = listMentionCandidates({
    query: 'AL',
    members: [
      member({ id: 2, username: 'alice', displayName: '小艾' }),
      member({ id: 3, username: 'bob', displayName: 'Albert' }),
      member({ id: 4, username: 'carol', displayName: 'Carol' }),
    ],
    selfId: 1,
    pendingUserIds: [],
  })
  assert.equal(result.kind, 'candidates')
  if (result.kind === 'candidates') {
    assert.deepEqual(result.members.map((item) => item.username), ['alice', 'bob'])
  }
})

test('returns an empty candidate list when nobody is pokeable', () => {
  const result = listMentionCandidates({
    query: '',
    members: [member({ id: 1, username: 'me', displayName: 'Me' })],
    selfId: 1,
    pendingUserIds: [],
  })
  assert.deepEqual(result, { kind: 'candidates', members: [] })
})

test('returns a cap state instead of candidates when 10 people are already pending', () => {
  const pendingUserIds = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const result = listMentionCandidates({
    query: 'a',
    members: [member({ id: 12, username: 'amy', displayName: 'Amy' })],
    selfId: 1,
    pendingUserIds,
  })
  assert.deepEqual(result, { kind: 'capped' })
})

test('does not open when the caret is inside an already-bound mention span', () => {
  const pending = [{ userId: 2, username: 'alice', start: 0, end: 6 }]
  assert.equal(findMentionTrigger('@alice hi', 3, { pending }), null)
  assert.equal(findMentionTrigger('@alice hi', 6, { pending }), null)
})

test('does not open or update mention autocomplete when the selection is non-empty', () => {
  assert.equal(findMentionTrigger('@al', 1, { selectionEnd: 3 }), null)
})

test('inserting a mention replaces only this @ and query with the stored username plus a trailing space', () => {
  const alice = member({ id: 2, username: 'Alice_1', displayName: '小艾' })
  const result = insertMention('找@al', { atIndex: 1, query: 'al' }, alice, [])
  assert.equal(result.text, '找@Alice_1 ')
  assert.equal(result.caret, 10)
  assert.deepEqual(result.pending, [{ userId: 2, username: 'Alice_1', start: 1, end: 9 }])
})

test('realign after insert keeps the newly bound mention at its new span', () => {
  const alice = member({ id: 2, username: 'alice', displayName: 'Alice' })
  const inserted = insertMention('@al', { atIndex: 0, query: 'al' }, alice, [])
  assert.deepEqual(realignPendingMentions(inserted.text, '@al', inserted.pending), inserted.pending)
})

test('the trailing space after an inserted mention is not part of the bound span', () => {
  const alice = member({ id: 2, username: 'alice', displayName: 'Alice' })
  const inserted = insertMention('@', { atIndex: 0, query: '' }, alice, [])
  const afterDeletingSpace = realignPendingMentions('@alice', inserted.text, inserted.pending)
  assert.deepEqual(afterDeletingSpace, [{ userId: 2, username: 'alice', start: 0, end: 6 }])
})

test('editing one letter of a bound mention drops it from the pending list', () => {
  const pending = [{ userId: 2, username: 'alice', start: 0, end: 6 }]
  assert.deepEqual(realignPendingMentions('@alixe', '@alice', pending), [])
})

test('typing the same @username back after a drop does not resurrect the pending mention', () => {
  const dropped = realignPendingMentions('@alixe', '@alice', [{ userId: 2, username: 'alice', start: 0, end: 6 }])
  assert.deepEqual(realignPendingMentions('@alice', '@alixe', dropped), [])
})

test('undo-style realign from restored text plus old pending drops mismatches', () => {
  const pending = [
    { userId: 2, username: 'alice', start: 0, end: 6 },
    { userId: 3, username: 'bob', start: 7, end: 11 },
  ]
  assert.deepEqual(realignPendingMentions('@alice @box', '@alice @bob', pending), [
    { userId: 2, username: 'alice', start: 0, end: 6 },
  ])
})

test('draft mention key is a sibling of the channel draft keyed by guild and channel', () => {
  assert.equal(channelDraftMentionsKey(7, 3), 'cws.guild.7.channelDraftMentions.3')
})

test('draft serialize and restore round-trips text-aligned pending mentions', () => {
  const pending = [{ userId: 2, username: 'alice', start: 3, end: 9 }]
  const stored = serializeDraftMentions(pending)
  assert.deepEqual(parseDraftMentions(stored, 'hi @alice '), pending)
})

test('restoring a draft after the stored text changed drops mismatched spans', () => {
  const stored = serializeDraftMentions([{ userId: 2, username: 'alice', start: 0, end: 6 }])
  assert.deepEqual(parseDraftMentions(stored, '@alixe'), [])
})

test('Esc keeps the same trigger closed until that @ segment is edited', () => {
  const trigger = findMentionTrigger('@al', 3)
  assert.deepEqual(trigger, { atIndex: 0, query: 'al' })
  assert.equal(findMentionTrigger('@al', 3, { dismissed: trigger }), null)
  assert.equal(retainDismissedMentionTrigger(findMentionTrigger('@al', 3), trigger), trigger)
  const edited = findMentionTrigger('@ali', 4)
  assert.deepEqual(edited, { atIndex: 0, query: 'ali' })
  assert.equal(retainDismissedMentionTrigger(edited, trigger), null)
})

test('Esc stays closed until the caret leaves the trigger and returns', () => {
  const trigger = findMentionTrigger('@al more', 3)
  assert.deepEqual(trigger, { atIndex: 0, query: 'al' })
  const left = findMentionTrigger('@al more', 8)
  assert.equal(left, null)
  assert.equal(retainDismissedMentionTrigger(left, trigger), null)
  assert.deepEqual(findMentionTrigger('@al more', 3, { dismissed: null }), { atIndex: 0, query: 'al' })
})
