import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSlashSuggestions,
  submitSlashCommand,
  type SlashCommandActions,
  type SlashCommandContext,
} from '../src/slash-commands.ts'
import type { User, UserProfile, VoiceProgress } from '../src/types.ts'

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
    ...overrides,
  }
}

function progress(xp = 120): VoiceProgress {
  return { xp, level: 2, levelStartXp: 120, levelEndXp: 210 }
}

function profile(user: User, guildId: number): UserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: '',
    onlineSecondsTotal: 0,
    voiceSecondsTotal: 120,
    voiceXpTotal: 120,
    voiceProgress: progress(),
    createdAt: `guild-${guildId}`,
  }
}

function context(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const currentUser = member()
  return {
    guildId: 7,
    currentUser,
    guildRole: 'owner',
    isPlatformAdmin: false,
    members: [currentUser],
    ...overrides,
  }
}

function actions(overrides: Partial<SlashCommandActions> = {}): SlashCommandActions {
  return {
    getProfile: async (userId, guildId) => profile(member({ id: userId }), guildId),
    setVoiceXP: async (guildId, userId, xp) => ({
      target: { id: userId, username: 'alice' },
      before: progress(80),
      after: progress(xp),
    }),
    ...overrides,
  }
}

test('executes a query through the separated command action adapter', async () => {
  const result = await submitSlashCommand('/xp get', context(), actions())

  assert.equal(result.kind, 'feedback')
  if (result.kind === 'feedback') {
    assert.equal(result.feedback.tone, 'success')
    assert.match(result.feedback.body, /总 XP：120/)
  }
})

test('executes a mutation through the separated command action adapter', async () => {
  const calls: Array<[number, number, number]> = []
  const result = await submitSlashCommand('/xp set @alice 240', context(), actions({
    setVoiceXP: async (guildId, userId, xp) => {
      calls.push([guildId, userId, xp])
      return {
        target: { id: userId, username: 'alice' },
        before: progress(80),
        after: progress(xp),
      }
    },
  }))

  assert.deepEqual(calls, [[7, 1, 240]])
  assert.equal(result.kind, 'feedback')
  if (result.kind === 'feedback') assert.match(result.feedback.body, /修改后：240 XP/)
})

test('keeps command suggestions permission-aware', () => {
  const suggestions = getSlashSuggestions('/xp ', context({ guildRole: 'member' }))

  assert.deepEqual(suggestions.map((suggestion) => suggestion.label), ['/xp get'])
})

test('classifies ordinary and escaped input before command dispatch', async () => {
  const ordinary = await submitSlashCommand('hello', context(), actions())
  const escaped = await submitSlashCommand('//xp get', context(), actions())

  assert.deepEqual(ordinary, { kind: 'message', content: 'hello' })
  assert.deepEqual(escaped, { kind: 'message', content: '/xp get' })
})

test('keeps invalid command input for correction', async () => {
  const result = await submitSlashCommand('/xp set @alice 1.5', context(), actions())

  assert.equal(result.kind, 'feedback')
  if (result.kind === 'feedback') {
    assert.equal(result.clearInput, false)
    assert.equal(result.feedback.title, '参数错误')
  }
})

test('suggests only active member targets from the command definition', () => {
  const suggestions = getSlashSuggestions('/xp get @', context({
    members: [
      member({ id: 1, username: 'alice', displayName: 'Alice' }),
      member({ id: 2, username: 'bob', displayName: 'Bob' }),
      member({ id: 3, username: 'banned', permanentlyBanned: true }),
    ],
  }))

  assert.deepEqual(suggestions.map((suggestion) => suggestion.label), ['@alice', '@bob'])
})

test('unknown commands never fall back to public messages', async () => {
  const result = await submitSlashCommand('/unknown', context(), actions())

  assert.equal(result.kind, 'feedback')
  if (result.kind === 'feedback') {
    assert.equal(result.feedback.title, '未知指令')
    assert.match(result.feedback.body, /可用指令：/)
  }
})
