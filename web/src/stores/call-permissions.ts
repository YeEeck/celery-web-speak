import { ref } from 'vue'
import { request } from '../api.ts'
import type { CallBlock, CallBlockCandidate, CallBlockEntry, CallBlockKind } from '../types.ts'

// 语音通话权限设置的前端状态：可被呼叫设置 + 呼叫屏蔽列表。所有写操作以
// 后端响应为准；本模块不做「能否呼叫」的预判（spec：只展示与更新权限）。
export interface CallPermissionsContext {
  patchCallReceiving(enabled: boolean): Promise<void>
  listBlocks(): Promise<CallBlockEntry[]>
  getBlock(userId: number): Promise<CallBlock | null>
  searchCandidates(query: string): Promise<CallBlockCandidate[]>
  setBlock(userId: number, kind: CallBlockKind): Promise<CallBlock>
  deleteBlock(userId: number): Promise<void>
}

export function useCallPermissions(ctx: CallPermissionsContext) {
  const callReceiving = ref(true)
  const blocks = ref<CallBlockEntry[]>([])
  const blockStates = ref<Record<number, CallBlock | null>>({})
  const loading = ref(false)
  const issue = ref<string | null>(null)

  const searchQuery = ref('')
  const searching = ref(false)
  const searchResults = ref<CallBlockCandidate[]>([])
  const searchIssue = ref<string | null>(null)

  function blockState(userId: number): CallBlock | null {
    return blockStates.value[userId] ?? null
  }

  function applyBlockState(userId: number, block: CallBlock | null) {
    blockStates.value = { ...blockStates.value, [userId]: block }
  }

  function applyBlockToSearch(userId: number, block: CallBlock | null) {
    searchResults.value = searchResults.value.map((candidate) => (
      candidate.userId === userId ? { ...candidate, block } : candidate
    ))
  }

  async function refreshBlocks() {
    const loaded = await ctx.listBlocks()
    blocks.value = loaded
    const next: Record<number, CallBlock | null> = {}
    for (const entry of loaded) {
      next[entry.userId] = { kind: entry.kind, expiresAt: entry.expiresAt }
    }
    blockStates.value = next
  }

  function syncCallReceiving(enabled?: boolean) {
    if (enabled != null) callReceiving.value = enabled
  }

  // 进入通话设置页时总是重新拉取，保证跨设备/跨标签页的新状态可见。
  async function initialize(accountCallReceiving?: boolean) {
    syncCallReceiving(accountCallReceiving)
    loading.value = true
    issue.value = null
    try {
      await refreshBlocks()
    } catch (error) {
      issue.value = error instanceof Error ? error.message : '加载呼叫屏蔽失败'
      throw error
    } finally {
      loading.value = false
    }
  }

  async function setCallReceiving(enabled: boolean) {
    const previous = callReceiving.value
    callReceiving.value = enabled
    issue.value = null
    try {
      await ctx.patchCallReceiving(enabled)
    } catch (error) {
      callReceiving.value = previous
      issue.value = error instanceof Error ? error.message : '更新可被呼叫设置失败'
      throw error
    }
  }

  // 个人信息卡片每次打开都调用：服务端状态是权威，不走跨会话缓存。
  async function fetchBlock(userId: number) {
    const block = await ctx.getBlock(userId)
    applyBlockState(userId, block)
    return block
  }

  async function persistBlock(userId: number, kind: CallBlockKind) {
    const block = await ctx.setBlock(userId, kind)
    applyBlockState(userId, block)
    applyBlockToSearch(userId, block)
    return block
  }

  async function setBlock(userId: number, kind: CallBlockKind) {
    await persistBlock(userId, kind)
    await refreshBlocks()
  }

  // 来电浮层专用：只写入并更新本地状态，不追加列表刷新请求——避免刷新失败
  // 阻断紧随其后的拒绝动作（spec：先屏蔽后拒绝）。
  async function setBlockForCall(userId: number, kind: CallBlockKind) {
    await persistBlock(userId, kind)
  }

  async function removeBlock(userId: number) {
    await ctx.deleteBlock(userId)
    applyBlockState(userId, null)
    applyBlockToSearch(userId, null)
    await refreshBlocks()
  }

  function clearSearch() {
    searchQuery.value = ''
    searchResults.value = []
    searchIssue.value = null
  }

  async function search(query: string) {
    // 规格：前缀匹配 @用户名/显示名称——归一化前导 @，仅剩 @ 时视为空查询。
    const trimmed = query.trim().replace(/^@/, '')
    if (trimmed === '') {
      searchQuery.value = ''
      searchResults.value = []
      searchIssue.value = null
      return
    }
    searchQuery.value = query
    searching.value = true
    searchIssue.value = null
    try {
      searchResults.value = await ctx.searchCandidates(trimmed)
    } catch (error) {
      searchIssue.value = error instanceof Error ? error.message : '搜索失败'
      throw error
    } finally {
      searching.value = false
    }
  }

  return {
    callReceiving,
    blocks,
    loading,
    issue,
    searchQuery,
    searching,
    searchResults,
    searchIssue,
    blockState,
    initialize,
    syncCallReceiving,
    setCallReceiving,
    fetchBlock,
    setBlock,
    setBlockForCall,
    removeBlock,
    search,
    clearSearch,
  }
}

export type CallPermissions = ReturnType<typeof useCallPermissions>

// 客户端单例：组件共享同一份权限状态；当前用户变化时由 UI 调用
// initialize / setCallReceiving 前经 currentUser 读最新账号值。
const callPermissions = useCallPermissions({
  patchCallReceiving: async (enabled) => {
    await request<{ user: { id: number; callReceiving: boolean } }>('/api/me/call-receiving', {
      method: 'PATCH',
      body: JSON.stringify({ callReceiving: enabled }),
    })
  },
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
