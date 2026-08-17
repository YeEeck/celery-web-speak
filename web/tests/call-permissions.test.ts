import assert from 'node:assert/strict'
import test from 'node:test'
import { useCallPermissions, type CallPermissionsContext } from '../src/stores/call-permissions.ts'
import type { CallBlock, CallBlockCandidate, CallBlockEntry } from '../src/types.ts'

interface Harness {
  ctx: CallPermissionsContext
  listBlocks: CallBlockEntry[]
  listCalls: number
  listError: Error | null
  blockByUser: Map<number, CallBlock | null>
  getBlockCalls: number[]
  candidates: CallBlockCandidate[]
  searches: string[]
  setCalls: Array<{ userId: number; kind: string }>
  deleteCalls: number[]
}

function makeHarness(): Harness {
  const harness: Harness = {
    ctx: {} as CallPermissionsContext,
    listBlocks: [],
    listCalls: 0,
    listError: null,
    blockByUser: new Map(),
    getBlockCalls: [],
    candidates: [],
    searches: [],
    setCalls: [],
    deleteCalls: [],
  }
  harness.ctx = {
    listBlocks: async () => {
      harness.listCalls += 1
      if (harness.listError) throw harness.listError
      return harness.listBlocks
    },
    getBlock: async (userId) => {
      harness.getBlockCalls.push(userId)
      return harness.blockByUser.get(userId) ?? null
    },
    searchCandidates: async (query) => {
      harness.searches.push(query)
      return harness.candidates
    },
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

test('initialize always refreshes the block list on settings entry', async () => {
  const h = makeHarness()
  h.listBlocks = [entry(2), entry(3, 'temporary')]
  const permissions = useCallPermissions(h.ctx)
  await permissions.initialize()
  await permissions.initialize()
  assert.equal(h.listCalls, 2, '每次进入通话设置页都应重新拉取')
  assert.equal(permissions.loading.value, false)
  assert.deepEqual(permissions.blocks.value.map((block) => block.userId), [3, 2], '列表按暂时屏蔽优先排序')
  assert.equal(permissions.blockState(2)?.kind, 'permanent')
  assert.equal(permissions.blockState(3)?.kind, 'temporary')
})

test('fetchBlock always reads the server and updates the index', async () => {
  const h = makeHarness()
  const permissions = useCallPermissions(h.ctx)
  h.blockByUser.set(7, { kind: 'temporary', expiresAt: '2026-08-02T12:00:00Z' })
  await permissions.fetchBlock(7)
  assert.equal(permissions.blockState(7)?.kind, 'temporary')
  assert.equal(permissions.cardStatus(7), 'ready')
  assert.deepEqual(h.getBlockCalls, [7])

  h.blockByUser.delete(7)
  await permissions.fetchBlock(7)
  assert.equal(permissions.blockState(7), null, '每次调用都请求服务端，不缓存')
  assert.deepEqual(h.getBlockCalls, [7, 7])
})

test('首次卡片读取失败保持未知状态，不伪装成未屏蔽', async () => {
  const h = makeHarness()
  h.ctx.getBlock = async () => { throw new Error('network') }
  const permissions = useCallPermissions(h.ctx)

  await assert.rejects(() => permissions.fetchBlock(7))
  assert.equal(permissions.blockState(7), null)
  assert.equal(permissions.cardStatus(7), 'error')
})

test('fetchBlock keeps the known card state while a refresh is pending or fails', async () => {
  const h = makeHarness()
  h.blockByUser.set(7, { kind: 'permanent' })
  const permissions = useCallPermissions(h.ctx)
  await permissions.fetchBlock(7)

  const pending = deferred<CallBlock | null>()
  h.ctx.getBlock = async () => pending.promise
  const read = permissions.fetchBlock(7)
  assert.equal(permissions.blockState(7)?.kind, 'permanent', '读取期间保留已知卡片状态')

  pending.reject(new Error('network'))
  await assert.rejects(read)
  assert.equal(permissions.blockState(7)?.kind, 'permanent', '读取失败不得把卡片状态伪装成未屏蔽')
})

test('clearBlockLocally 只清除本地卡片状态，不发请求', async () => {
  const h = makeHarness()
  h.listBlocks = [entry(7, 'temporary')]
  const permissions = useCallPermissions(h.ctx)
  await permissions.initialize()
  assert.equal(permissions.blockState(7)?.kind, 'temporary')

  permissions.clearBlockLocally(7)
  assert.equal(permissions.blockState(7), null, '到期后本地视为不存在')
  assert.deepEqual(h.deleteCalls, [], '不调删除接口')
  assert.deepEqual(h.getBlockCalls, [], '不重新拉取')
  assert.equal(permissions.blocks.value.some((block) => block.userId === 7), true, '设置页列表不受影响，下次进入重新拉取')
})

test('过期的打开卡片仍能就地显示后续屏蔽操作', async () => {
  const h = makeHarness()
  h.blockByUser.set(7, { kind: 'temporary', expiresAt: '2026-08-02T12:00:00Z' })
  const permissions = useCallPermissions(h.ctx)
  await permissions.fetchBlock(7)

  permissions.expireBlockLocally(7)
  assert.equal(permissions.blockState(7), null)

  await permissions.setBlock(7, 'permanent')
  assert.equal(permissions.blockState(7)?.kind, 'permanent', '卡片仍打开时成功写入应更新卡片投影')
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

test('a list snapshot without a searched candidate clears its stale block state', async () => {
  const h = makeHarness()
  h.candidates = [{ userId: 2, username: 'user2', displayName: '用户2', avatarVersion: 0, hasAvatar: false, block: { kind: 'permanent' } }]
  const permissions = useCallPermissions(h.ctx)
  await permissions.search('user')
  assert.equal(permissions.searchResults.value[0]?.block?.kind, 'permanent')

  h.listBlocks = []
  await permissions.initialize()
  assert.equal(permissions.searchResults.value[0]?.block, null, '最新列表不含该用户时搜索投影应解除屏蔽')
})

test('local list projection keeps expiry and ordering consistent after a kind change', async () => {
  const h = makeHarness()
  h.listBlocks = [
    { ...entry(1), expiresAt: '2026-08-03T12:00:00Z' },
    { ...entry(2), kind: 'temporary', expiresAt: '2026-08-02T12:00:00Z' },
  ]
  const permissions = useCallPermissions(h.ctx)
  await permissions.initialize()
  assert.deepEqual(permissions.blocks.value.map((block) => block.userId), [2, 1])

  await permissions.setBlock(2, 'permanent')
  assert.deepEqual(permissions.blocks.value.map((block) => block.userId), [1, 2])
  assert.equal(permissions.blocks.value.find((block) => block.userId === 2)?.expiresAt, undefined)
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

test('setBlock succeeds and records a list refresh failure without failing the write', async () => {
  const h = makeHarness()
  h.listError = new Error('network')
  const permissions = useCallPermissions(h.ctx)

  await permissions.setBlock(2, 'permanent')
  assert.deepEqual(h.setCalls, [{ userId: 2, kind: 'permanent' }])
  assert.equal(permissions.blockState(2)?.kind, 'permanent', '写成功即就地更新状态')
  assert.match(permissions.issue.value ?? '', /列表刷新失败/)
})

test('removeBlock succeeds and records a list refresh failure without failing the write', async () => {
  const h = makeHarness()
  h.listError = new Error('network')
  const permissions = useCallPermissions(h.ctx)

  await permissions.removeBlock(2)
  assert.deepEqual(h.deleteCalls, [2])
  assert.equal(permissions.blockState(2), null, '写成功即就地更新状态')
  assert.match(permissions.issue.value ?? '', /列表刷新失败/)
})

test('search strips a leading @ and treats a bare @ as empty', async () => {
  const h = makeHarness()
  h.candidates = [{ userId: 2, username: 'user2', displayName: '用户2', avatarVersion: 0, hasAvatar: false, block: null }]
  const permissions = useCallPermissions(h.ctx)

  await permissions.search('@user')
  assert.deepEqual(h.searches, ['user'], '前导 @ 归一化后按用户名前缀匹配')
  assert.equal(permissions.searchQuery.value, '@user')

  await permissions.search('@')
  assert.equal(h.searches.length, 1, '仅 @ 视为空查询，不发起请求')
  assert.deepEqual(permissions.searchResults.value, [])
  assert.equal(permissions.searchQuery.value, '')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('late card reads cannot restore an invalidated card projection', async () => {
  const h = makeHarness()
  const pending = deferred<CallBlock | null>()
  h.ctx.getBlock = async () => pending.promise
  const permissions = useCallPermissions(h.ctx)

  const read = permissions.fetchBlock(7)
  permissions.clearBlockLocally(7)
  pending.resolve({ kind: 'permanent' })
  await read

  assert.equal(permissions.blockState(7), null, '卡片关闭后晚到响应不得恢复状态')
  assert.equal(permissions.blocks.value.length, 0, '卡片读取不应创建设置页列表项')
})

test('late search results cannot replace the newest query', async () => {
  const h = makeHarness()
  const first = deferred<CallBlockCandidate[]>()
  const second = deferred<CallBlockCandidate[]>()
  h.ctx.searchCandidates = async (query) => query === 'a' ? first.promise : second.promise
  const permissions = useCallPermissions(h.ctx)

  const oldSearch = permissions.search('a')
  const newSearch = permissions.search('ab')
  second.resolve([{ userId: 2, username: 'user2', displayName: '用户2', avatarVersion: 0, hasAvatar: false, block: null }])
  await newSearch
  first.resolve([{ userId: 3, username: 'user3', displayName: '用户3', avatarVersion: 0, hasAvatar: false, block: null }])
  await oldSearch

  assert.equal(permissions.searchQuery.value, 'ab')
  assert.deepEqual(permissions.searchResults.value.map((candidate) => candidate.userId), [2])
  assert.equal(permissions.searching.value, false)
})

test('a list response started before a write cannot overwrite the write', async () => {
  const h = makeHarness()
  const stale = deferred<CallBlockEntry[]>()
  const fresh = deferred<CallBlockEntry[]>()
  const responses = [stale, fresh]
  h.ctx.listBlocks = async () => responses.shift()!.promise
  const permissions = useCallPermissions(h.ctx)

  const initialLoad = permissions.initialize()
  await Promise.resolve()
  const write = permissions.setBlock(2, 'permanent')
  await Promise.resolve()
  stale.resolve([])
  await initialLoad
  fresh.resolve([entry(2)])
  await write

  assert.equal(permissions.blockState(2)?.kind, 'permanent')
  assert.deepEqual(permissions.blocks.value.map((block) => block.userId), [2])
})
