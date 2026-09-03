import assert from 'node:assert/strict'
import test from 'node:test'
import { upsertPokePrompt, type PokePromptItem } from '../src/stores/poke-prompt.ts'

function item(id: number, actorUserId: number, displayName: string): PokePromptItem {
  return { id, actorUserId, displayName }
}

test('upsertPokePrompt puts the newest actor on top', () => {
  const next = upsertPokePrompt(
    [item(1, 10, '甲')],
    { actorUserId: 20, displayName: '乙' },
    2,
  )
  assert.deepEqual(next, [
    item(2, 20, '乙'),
    item(1, 10, '甲'),
  ])
})

test('upsertPokePrompt refreshes the same actor and moves that row to the top', () => {
  const next = upsertPokePrompt(
    [item(2, 20, '乙'), item(1, 10, '旧名')],
    { actorUserId: 10, displayName: '新名' },
    3,
  )
  assert.deepEqual(next, [
    item(3, 10, '新名'),
    item(2, 20, '乙'),
  ])
})

test('upsertPokePrompt keeps at most three prompts and drops the oldest', () => {
  const next = upsertPokePrompt(
    [item(3, 30, '丙'), item(2, 20, '乙'), item(1, 10, '甲')],
    { actorUserId: 40, displayName: '丁' },
    4,
  )
  assert.deepEqual(next, [
    item(4, 40, '丁'),
    item(3, 30, '丙'),
    item(2, 20, '乙'),
  ])
})
