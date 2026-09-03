import assert from 'node:assert/strict'
import test from 'node:test'
import { mentionSegments } from '../src/message-mentions.ts'

test('no mentions yields one plain segment of the whole content', () => {
  assert.deepEqual(
    mentionSegments('hello @alice', undefined, { currentUserId: 1, authorUserId: 2 }),
    [{ kind: 'text', text: 'hello @alice' }],
  )
})

test('one mention matches the first @alice even if the body has @ALICE', () => {
  assert.deepEqual(
    mentionSegments('hi @ALICE there', [{ userId: 2, username: 'alice' }], { currentUserId: 1, authorUserId: 3 }),
    [
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@ALICE', userId: 2, self: false },
      { kind: 'text', text: ' there' },
    ],
  )
})

test('two mentions of the same username highlight the first two tokens; a leftover is plain', () => {
  assert.deepEqual(
    mentionSegments(
      '@alice @alice @alice',
      [
        { userId: 2, username: 'alice' },
        { userId: 3, username: 'alice' },
      ],
      { currentUserId: 1, authorUserId: 4 },
    ),
    [
      { kind: 'mention', text: '@alice', userId: 2, self: false },
      { kind: 'text', text: ' ' },
      { kind: 'mention', text: '@alice', userId: 3, self: false },
      { kind: 'text', text: ' @alice' },
    ],
  )
})

test('hello@alice does not match; 找@alice does', () => {
  const mentions = [{ userId: 2, username: 'alice' }]
  const context = { currentUserId: 1, authorUserId: 3 }
  assert.deepEqual(mentionSegments('hello@alice', mentions, context), [
    { kind: 'text', text: 'hello@alice' },
  ])
  assert.deepEqual(mentionSegments('找@alice', mentions, context), [
    { kind: 'text', text: '找' },
    { kind: 'mention', text: '@alice', userId: 2, self: false },
  ])
})

test('incomplete @alic does not match username alice', () => {
  assert.deepEqual(
    mentionSegments('@alic', [{ userId: 2, username: 'alice' }], { currentUserId: 1, authorUserId: 3 }),
    [{ kind: 'text', text: '@alic' }],
  )
})

test('self mention is marked only when the viewer is not the author', () => {
  const mentions = [{ userId: 1, username: 'me' }]
  assert.deepEqual(
    mentionSegments('@me hi', mentions, { currentUserId: 1, authorUserId: 2 }),
    [
      { kind: 'mention', text: '@me', userId: 1, self: true },
      { kind: 'text', text: ' hi' },
    ],
  )
  assert.deepEqual(
    mentionSegments('@me hi', mentions, { currentUserId: 1, authorUserId: 1 }),
    [
      { kind: 'mention', text: '@me', userId: 1, self: false },
      { kind: 'text', text: ' hi' },
    ],
  )
})

test('an empty mention list highlights nothing even when the body has @username', () => {
  assert.deepEqual(
    mentionSegments('@alice', [], { currentUserId: 1, authorUserId: 2 }),
    [{ kind: 'text', text: '@alice' }],
  )
})

test('each mention claims the next unused matching token even if it appears before a previous list entry', () => {
  assert.deepEqual(
    mentionSegments(
      '@bob @alice',
      [
        { userId: 2, username: 'alice' },
        { userId: 3, username: 'bob' },
      ],
      { currentUserId: 1, authorUserId: 4 },
    ),
    [
      { kind: 'mention', text: '@bob', userId: 3, self: false },
      { kind: 'text', text: ' ' },
      { kind: 'mention', text: '@alice', userId: 2, self: false },
    ],
  )
})
