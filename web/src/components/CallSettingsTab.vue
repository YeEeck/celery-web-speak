<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Ban, Phone, Search } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useCallPermissionsStore } from '../stores/call-permissions'
import { useToastStore } from '../stores/toast'
import type { CallBlockKind } from '../types'
import { callBlockRemainingLabel } from '../utils/call-block'
import UserAvatar from './UserAvatar.vue'

const app = useAppStore()
const permissions = useCallPermissionsStore()
const toast = useToastStore()

const searchInput = ref('')
const savingReceiving = ref(false)
const blockBusy = ref(new Set<number>())
let searchTimer: ReturnType<typeof setTimeout> | null = null

function describeBlock(kind: CallBlockKind | undefined, expiresAt: string | undefined): string {
  if (!kind) return '未屏蔽'
  if (kind === 'permanent') return '永久屏蔽'
  return `暂时屏蔽 · ${callBlockRemainingLabel(expiresAt)}`
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  const query = searchInput.value.trim()
  if (query === '') {
    void permissions.search('')
    return
  }
  searchTimer = setTimeout(() => {
    void permissions.search(query).catch(() => undefined)
  }, 250)
}

async function setBlock(userId: number, kind: CallBlockKind) {
  blockBusy.value = new Set(blockBusy.value).add(userId)
  try {
    await toast.runAction(async () => {
      await permissions.setBlock(userId, kind)
    }, kind === 'temporary' ? '已暂时屏蔽 24 小时' : '已永久屏蔽')
  } finally {
    const next = new Set(blockBusy.value)
    next.delete(userId)
    blockBusy.value = next
  }
}

async function removeBlock(userId: number) {
  blockBusy.value = new Set(blockBusy.value).add(userId)
  try {
    await toast.runAction(async () => {
      await permissions.removeBlock(userId)
    }, '已解除屏蔽')
  } finally {
    const next = new Set(blockBusy.value)
    next.delete(userId)
    blockBusy.value = next
  }
}

async function setCallReceiving(enabled: boolean) {
  savingReceiving.value = true
  try {
    await toast.runAction(async () => {
      await app.setMyCallReceiving(enabled)
    }, enabled ? '已允许别人发起语音通话' : '已关闭别人发起语音通话')
  } finally {
    savingReceiving.value = false
  }
}

// toast store 负责操作反馈；这里只需异步触发，避免 @change 产生未处理拒绝。
function onCallReceivingChange(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  void setCallReceiving(enabled)
}

onMounted(() => {
  void permissions.initialize().catch(() => undefined)
})

watch(() => permissions.issue.value, (message) => {
  if (message) toast.showError(message)
})

watch(() => permissions.searchIssue.value, (message) => {
  if (message) toast.showError(message)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  permissions.clearSearch()
})
</script>

<template>
  <section class="settings-section motion-content-in">
    <h3><Phone :size="18" />可被呼叫设置</h3>
    <label class="setting-toggle">
      <span>允许别人发起语音通话给我</span>
      <input
        type="checkbox"
        :checked="app.user?.callReceiving ?? true"
        :disabled="savingReceiving"
        aria-label="允许别人发起语音通话给我"
        @change="onCallReceivingChange"
      />
    </label>
    <h3><Ban :size="18" />呼叫屏蔽</h3>
    <div class="call-block-search">
      <Search :size="16" />
      <input
        v-model="searchInput"
        type="search"
        placeholder="搜索与你共享服务器的用户"
        aria-label="搜索与你共享服务器的用户"
        @input="onSearchInput"
      />
    </div>
    <p v-if="permissions.searching.value" class="profile-hint">正在搜索…</p>

    <div v-if="permissions.searchQuery.value.trim() && !permissions.searching.value" class="call-block-list">
      <div v-for="candidate in permissions.searchResults.value" :key="candidate.userId" class="call-block-row">
        <UserAvatar
          :name="candidate.displayName"
          :size="32"
          :user="{ id: candidate.userId, hasAvatar: candidate.hasAvatar, avatarVersion: candidate.avatarVersion }"
        />
        <div class="call-block-identity">
          <strong>{{ candidate.displayName }}</strong>
          <small>@{{ candidate.username }}</small>
        </div>
        <span class="call-block-state">{{ describeBlock(candidate.block?.kind, candidate.block?.expiresAt) }}</span>
        <div class="call-block-actions">
          <button
            v-if="candidate.block?.kind !== 'temporary'"
            class="secondary-button"
            type="button"
            :disabled="blockBusy.has(candidate.userId)"
            @click="setBlock(candidate.userId, 'temporary')"
          >
            {{ candidate.block ? '转为暂时屏蔽' : '暂时屏蔽 24 小时' }}
          </button>
          <button
            v-if="candidate.block?.kind !== 'permanent'"
            class="secondary-button"
            type="button"
            :disabled="blockBusy.has(candidate.userId)"
            @click="setBlock(candidate.userId, 'permanent')"
          >
            {{ candidate.block ? '转为永久屏蔽' : '永久屏蔽' }}
          </button>
          <button
            v-if="candidate.block"
            class="secondary-button danger-text"
            type="button"
            :disabled="blockBusy.has(candidate.userId)"
            @click="removeBlock(candidate.userId)"
          >
            解除屏蔽
          </button>
        </div>
      </div>
      <p v-if="permissions.searchResults.value.length === 0" class="profile-card-empty">没有找到与你共享服务器的用户</p>
    </div>

    <template v-else>
      <p v-if="permissions.loading.value" class="profile-hint">正在加载呼叫屏蔽…</p>
      <div v-else-if="permissions.blocks.value.length" class="call-block-list">
        <div v-for="entry in permissions.blocks.value" :key="entry.userId" class="call-block-row">
          <UserAvatar
            :name="entry.displayName"
            :size="32"
            :user="{ id: entry.userId, hasAvatar: entry.hasAvatar, avatarVersion: entry.avatarVersion }"
          />
          <div class="call-block-identity">
            <strong>{{ entry.displayName }}</strong>
            <small>@{{ entry.username }}</small>
          </div>
          <span class="call-block-state">{{ describeBlock(entry.kind, entry.expiresAt) }}</span>
          <div class="call-block-actions">
            <button
              v-if="entry.kind === 'temporary'"
              class="secondary-button"
              type="button"
              :disabled="blockBusy.has(entry.userId)"
              @click="setBlock(entry.userId, 'permanent')"
            >
              转为永久屏蔽
            </button>
            <button
              v-else
              class="secondary-button"
              type="button"
              :disabled="blockBusy.has(entry.userId)"
              @click="setBlock(entry.userId, 'temporary')"
            >
              转为暂时屏蔽 24 小时
            </button>
            <button class="secondary-button danger-text" type="button" :disabled="blockBusy.has(entry.userId)" @click="removeBlock(entry.userId)">
              解除屏蔽
            </button>
          </div>
        </div>
      </div>
      <p v-else class="profile-card-empty">你还没有屏蔽任何人的呼叫</p>
    </template>
  </section>
</template>
