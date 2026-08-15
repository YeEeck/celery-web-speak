import assert from 'node:assert/strict'
import test from 'node:test'
import { useCallPermissions, type CallPermissionsContext } from '../src/stores/call-permissions.ts'
import type { CallBlock, CallBlockCandidate, CallBlockEntry } from '../src/types.ts'

interface Harness {
  ctx: CallPermissionsContext
  patchedReceiving: boolean[]
  patchError: Error | null
  listBlocks: CallBlockEntry[]
  listCalls: number
  blockByUser: Map<number, CallBlock | null>
  getBlockCalls: number[]
  candidates: CallBlockCandidate[]
  setCalls: Array<{ userId: number; kind: string }>
  deleteCalls: number[]
}

function makeHarness(): Harness {
  const harness: Harness = {
    ctx: {} as CallPermissionsContext,
    patchedReceiving: [],
    patchError: null,
    listBlocks: [],
    listCalls: 0,
    blockByUser: new Map(),
    getBlockCalls: [],
    candidates: [],
    setCalls: [],
    deleteCalls: [],
  }
  harness.ctx = {
    patchCallReceiving: async (enabled) => {
      harness.patchedReceiving.push(enabled)
      if (harness.patchError) throw harness.patchError
    },
    listBlocks: async () => {
      harness.listCalls += 1
      return harness.listBlocks
    },
    getBlock: async (userId) => {
      harness.getBlockCalls.push(userId)
      return harness.blockByUser.get(userId) ?? null
    },
    searchCandidates: async () => harness.candidates,
    setBlock: async (userId, kind) => {
      harness.setCalls.push({ userId, kind })
      const block: CallBlock = kind === 'permanent' ? { kind } : { kind, expiresAt: '2026-08-02T12:00:00Z' }
      harness.blockByUser.set(userId, block)
      const existing = harness.listBlocks.find((item) => item.userId === userId)
      if (existing) {
        existing.kind = kind
        existing.expiresAt = block.expiresAt
      } else {
        harness.listBlocks.push({ userId, username: `user${userId}`, displayName: `用户${userId}`, avatarVersion: 0, hasAvatar: false, ...block })
      }
      return block
    },
    deleteBlock: async (userId) => {
      harness.deleteCalls.push(userId)
      harness.listBlocks = harness.listBlocks.filter((item) => item.userId !== userId)
    },
  }
  return harness
}

const entry = (userId: number, kind: 'temporary' | 'permanent' = 'permanent'): CallBlockEntry => ({
  userId,
  username: `user${userId}`,
  displayName: `用户${userId}`,
  avatarVersion: 0,
  hasAvatar: false,
  kind,
})

test('setCallReceiving updates optimistically and reverts on failure', async () => {
  const h = makeHarness()
  const permissions = useCallPermissions(h.ctx)
  permissions.callReceiving.value = true

  await permissions.setCallReceiving(false)
  assert.equal(permissions.callReceiving.value, false)
  assert.deepEqual(h.patchedReceiving, [false])

  h.patchError = new Error('network')
  await assert.rejects(() => permissions.setCallReceiving(true))
  assert.equal(permissions.callReceiving.value, false, '失败后应回滚到旧值')
})

test('initialize always refreshes the block list on settings entry', async () => {
  const h = makeHarness()
  h.listBlocks = [entry(2), entry(3, 'temporary')]
  const permissions = useCallPermissions(h.ctx)
  await permissions.initialize()
  await permissions.initialize()
  assert.equal(h.listCalls, 2, '每次进入通话设置页都应重新拉取')
  assert.equal(permissions.loading.value, false)
  assert.deepEqual(permissions.blocks.value, h.listBlocks)
  assert.equal(permissions.blockState(2)?.kind, 'permanent')
  assert.equal(permissions.blockState(3)?.kind, 'temporary')
})

test('ensureBlock caches while fetchBlock always reads the server', async () => {
  const h = makeHarness()
  const permissions = useCallPermissions(h.ctx)
  h.blockByUser.set(7, { kind: 'temporary', expiresAt: '2026-08-02T12:00:00Z' })
  await permissions.ensureBlock(7)
  assert.equal(permissions.blockState(7)?.kind, 'temporary')
  assert.equal(permissions.blockState(8), null)

  h.blockByUser.delete(7)
  await permissions.ensureBlock(7)
  assert.equal(permissions.blockState(7)?.kind, 'temporary', '已缓存后不重新请求')

  h.blockByUser.set(7, { kind: 'permanent' })
  await permissions.fetchBlock(7)
  assert.deepEqual(h.getBlockCalls, [7, 7])
  assert.equal(permissions.blockState(7)?.kind, 'permanent')
})

test('setBlockForCall persists the block without refreshing the list', async () => {
  const h = makeHarness()
  const permissions = useCallPermissions(h.ctx)
  await permissions.setBlockForCall(9, 'temporary')
  assert.deepEqual(h.setCalls, [{ userId: 9, kind: 'temporary' }])
  assert.equal(h.listCalls, 0)
  assert.equal(permissions.blockState(9)?.kind, 'temporary')
})

test('setBlock updates the index, list and search results', async () => {
  const h = makeHarness()
  h.listBlocks = [entry(2)]
  h.candidates = [{ userId: 2, username: 'user2', displayName: '用户2', avatarVersion: 0, hasAvatar: false, block: null }]
  const permissions = useCallPermissions(h.ctx)
  await permissions.initialize()
  await permissions.search('user')
  assert.equal(permissions.searchResults.value[0]?.block, null)

  await permissions.setBlock(2, 'temporary')
  assert.equal(permissions.blockState(2)?.kind, 'temporary')
  assert.equal(permissions.blocks.value.some((block) => block.userId === 2), true)
  assert.equal(permissions.searchResults.value[0]?.block?.kind, 'temporary')
})

test('removeBlock removes from index, list and search results', async () => {
  const h = makeHarness()
  h.listBlocks = [entry(2)]
  h.candidates = [{ userId: 2, username: 'user2', displayName: '用户2', avatarVersion: 0, hasAvatar: false, block: { kind: 'permanent' } }]
  const permissions = useCallPermissions(h.ctx)
  await permissions.initialize()
  await permissions.search('user')

  await permissions.removeBlock(2)
  assert.deepEqual(h.deleteCalls, [2])
  assert.equal(permissions.blockState(2), null)
  assert.equal(permissions.blocks.value.some((block) => block.userId === 2), false)
  assert.equal(permissions.searchResults.value[0]?.block, null)
})
