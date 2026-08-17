import { computed, ref } from 'vue'
import { request } from '../api.ts'
import type { CallBlock, CallBlockCandidate, CallBlockEntry, CallBlockKind } from '../types.ts'

// 呼叫屏蔽状态 module：服务端读取是权威，module 负责有效状态、列表/搜索/卡片
// 投影与异步读取的顺序。可被呼叫设置是账号偏好，不属于这个 module。
export interface CallPermissionsContext {
  listBlocks(): Promise<CallBlockEntry[]>
  getBlock(userId: number): Promise<CallBlock | null>
  searchCandidates(query: string): Promise<CallBlockCandidate[]>
  setBlock(userId: number, kind: CallBlockKind): Promise<CallBlock>
  deleteBlock(userId: number): Promise<void>
}

interface CardProjection {
  block: CallBlock | null
  active: boolean
}

function hasOwn<T extends object>(value: T, key: number): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function blockFromEntry(entry: CallBlockEntry): CallBlock {
  return entry.expiresAt === undefined
    ? { kind: entry.kind }
    : { kind: entry.kind, expiresAt: entry.expiresAt }
}

export function useCallPermissions(ctx: CallPermissionsContext) {
  const blocks = ref<CallBlockEntry[]>([])
  // knownBlocks is the normalized effective state. The list projection remains a
  // server snapshot; a card can invalidate its own projection without removing
  // an entry from that snapshot.
  const knownBlocks = ref<Record<number, CallBlock | null>>({})
  const cardProjections = ref<Record<number, CardProjection>>({})
  const loading = ref(false)
  const issue = ref<string | null>(null)

  const searchQuery = ref('')
  const searching = ref(false)
  const searchCandidates = ref<CallBlockCandidate[]>([])
  const searchIssue = ref<string | null>(null)

  let blockRevision = 0
  let listRequestVersion = 0
  let loadingRequestVersion = 0
  let searchRequestVersion = 0
  const mutationVersions = new Map<number, number>()
  const cardRequestVersions = new Map<number, number>()

  function currentMutationVersion(userId: number): number {
    return mutationVersions.get(userId) ?? 0
  }

  function bumpMutationVersion(userId: number): number {
    const version = currentMutationVersion(userId) + 1
    mutationVersions.set(userId, version)
    blockRevision += 1
    return version
  }

  function setKnownBlock(userId: number, block: CallBlock | null) {
    knownBlocks.value = { ...knownBlocks.value, [userId]: block }
    const card = cardProjections.value[userId]
    if (card?.active) {
      cardProjections.value = { ...cardProjections.value, [userId]: { ...card, block } }
    }
  }

  function updateListProjection(userId: number, block: CallBlock | null) {
    const index = blocks.value.findIndex((entry) => entry.userId === userId)
    if (block === null) {
      if (index >= 0) blocks.value = blocks.value.filter((entry) => entry.userId !== userId)
      return
    }
    if (index >= 0) {
      blocks.value = blocks.value.map((entry, entryIndex) => (
        entryIndex === index ? { ...entry, ...block } : entry
      ))
    }
  }

  function applyListSnapshot(loaded: CallBlockEntry[]) {
    blocks.value = loaded.map((entry) => ({ ...entry }))
    const next: Record<number, CallBlock | null> = {}
    for (const entry of loaded) next[entry.userId] = blockFromEntry(entry)
    const loadedUsers = new Set(loaded.map((entry) => entry.userId))
    for (const candidate of searchCandidates.value) {
      if (loadedUsers.has(candidate.userId)) continue
      if (hasOwn(knownBlocks.value, candidate.userId)) next[candidate.userId] = knownBlocks.value[candidate.userId]
      else next[candidate.userId] = candidate.block
    }
    knownBlocks.value = next
  }

  function blockState(userId: number): CallBlock | null {
    const card = cardProjections.value[userId]
    if (card) return card.block
    if (hasOwn(knownBlocks.value, userId)) return knownBlocks.value[userId]
    return null
  }

  const searchResults = computed<CallBlockCandidate[]>(() => searchCandidates.value.map((candidate) => ({
    ...candidate,
    block: hasOwn(knownBlocks.value, candidate.userId)
      ? knownBlocks.value[candidate.userId]
      : candidate.block,
  })))

  async function refreshBlocks(showLoading = false) {
    const requestVersion = ++listRequestVersion
    if (showLoading) {
      loading.value = true
      loadingRequestVersion = requestVersion
    }
    const revisionAtStart = blockRevision
    try {
      const loaded = await ctx.listBlocks()
      if (requestVersion !== listRequestVersion || revisionAtStart !== blockRevision) return
      applyListSnapshot(loaded)
    } finally {
      if (loadingRequestVersion === requestVersion) {
        loading.value = false
        loadingRequestVersion = 0
      }
    }
  }

  // 进入通话设置页时总是重新拉取，保证跨设备/跨标签页的新状态可见。
  async function initialize() {
    issue.value = null
    try {
      await refreshBlocks(true)
    } catch (error) {
      issue.value = error instanceof Error ? error.message : '加载呼叫屏蔽失败'
      throw error
    }
  }

  // 个人信息卡片每次打开都从服务端读取。卡片的 invalidated projection
  // 不会清除设置页列表；晚到的读取也不能重新激活已关闭的卡片。
  async function fetchBlock(userId: number) {
    const requestVersion = (cardRequestVersions.get(userId) ?? 0) + 1
    cardRequestVersions.set(userId, requestVersion)
    cardProjections.value = { ...cardProjections.value, [userId]: { block: null, active: true } }
    const mutationVersionAtStart = currentMutationVersion(userId)
    const block = await ctx.getBlock(userId)
    if (cardRequestVersions.get(userId) !== requestVersion || currentMutationVersion(userId) !== mutationVersionAtStart) return block
    setKnownBlock(userId, block)
    return block
  }

  // 暂时屏蔽到期或卡片关闭只使卡片 projection 失效，不发请求，也不修改
  // 设置页列表的最近一次服务端快照。
  function clearBlockLocally(userId: number) {
    cardRequestVersions.set(userId, (cardRequestVersions.get(userId) ?? 0) + 1)
    cardProjections.value = { ...cardProjections.value, [userId]: { block: null, active: false } }
  }

  async function persistBlock(userId: number, kind: CallBlockKind) {
    const block = await ctx.setBlock(userId, kind)
    bumpMutationVersion(userId)
    setKnownBlock(userId, block)
    updateListProjection(userId, block)
    return block
  }

  // 写操作后的列表刷新是尽力而为：本地状态已在写成功后就地更新，列表
  // GET 失败不否定已成功的写操作；下次进入设置页再拉取完整列表。
  async function refreshBlocksBestEffort() {
    try {
      await refreshBlocks()
    } catch {
      issue.value = '屏蔽已保存，但列表刷新失败，请重新进入页面查看'
    }
  }

  async function setBlock(userId: number, kind: CallBlockKind) {
    await persistBlock(userId, kind)
    await refreshBlocksBestEffort()
  }

  // 来电浮层专用：只写入并更新本地状态，不追加列表刷新请求。拒绝动作由
  // voice-call module 编排，避免此 module 依赖通话生命周期。
  async function setBlockForCall(userId: number, kind: CallBlockKind) {
    await persistBlock(userId, kind)
  }

  async function removeBlock(userId: number) {
    await ctx.deleteBlock(userId)
    bumpMutationVersion(userId)
    setKnownBlock(userId, null)
    updateListProjection(userId, null)
    await refreshBlocksBestEffort()
  }

  function clearSearch() {
    searchRequestVersion += 1
    searchQuery.value = ''
    searchCandidates.value = []
    searchIssue.value = null
    searching.value = false
  }

  async function search(query: string) {
    const trimmed = query.trim().replace(/^@/, '')
    const requestVersion = ++searchRequestVersion
    if (trimmed === '') {
      searchQuery.value = ''
      searchCandidates.value = []
      searchIssue.value = null
      searching.value = false
      return
    }
    searchQuery.value = query
    searching.value = true
    searchIssue.value = null
    const blockRevisionAtStart = blockRevision
    try {
      const candidates = await ctx.searchCandidates(trimmed)
      if (requestVersion !== searchRequestVersion || blockRevisionAtStart !== blockRevision) return
      searchCandidates.value = candidates
      for (const candidate of candidates) {
        knownBlocks.value = { ...knownBlocks.value, [candidate.userId]: candidate.block }
      }
    } catch (error) {
      if (requestVersion === searchRequestVersion) searchIssue.value = error instanceof Error ? error.message : '搜索失败'
      throw error
    } finally {
      if (requestVersion === searchRequestVersion) searching.value = false
    }
  }

  return {
    blocks,
    loading,
    issue,
    searchQuery,
    searching,
    searchResults,
    searchIssue,
    blockState,
    initialize,
    setBlockForCall,
    fetchBlock,
    clearBlockLocally,
    setBlock,
    removeBlock,
    search,
    clearSearch,
  }
}

export type CallPermissions = ReturnType<typeof useCallPermissions>

const callPermissions = useCallPermissions({
  listBlocks: async () => {
    const result = await request<{ blocks: CallBlockEntry[] }>('/api/call-blocks')
    return result.blocks
  },
  getBlock: async (userId) => {
    const result = await request<{ block: CallBlock | null }>(`/api/call-blocks/${userId}`)
    return result.block
  },
  searchCandidates: async (query) => {
    const result = await request<{ users: CallBlockCandidate[] }>(
      `/api/call-blocks/candidates?q=${encodeURIComponent(query)}`,
    )
    return result.users
  },
  setBlock: async (userId, kind) => {
    const result = await request<{ block: CallBlock }>(`/api/call-blocks/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ kind }),
    })
    return result.block
  },
  deleteBlock: async (userId) => {
    await request<void>(`/api/call-blocks/${userId}`, { method: 'DELETE' })
  },
})

export function useCallPermissionsStore() {
  return callPermissions
}
