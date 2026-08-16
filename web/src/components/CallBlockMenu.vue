<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Ban } from '@lucide/vue'
import { useCallPermissionsStore } from '../stores/call-permissions'
import type { CallBlockKind } from '../types'
import { callBlockRemainingLabel, formatCallBlockCountdown } from '../utils/call-block'

const props = defineProps<{ userId: number }>()

const permissions = useCallPermissionsStore()
const open = ref(false)
const busy = ref(false)
const issue = ref('')
const menu = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const now = ref(Date.now())
let tickTimer: number | undefined

const block = computed(() => permissions.blockState(props.userId))

const remainingMs = computed(() => {
  const current = block.value
  if (current?.kind !== 'temporary' || !current.expiresAt) return null
  return new Date(current.expiresAt).getTime() - now.value
})

// 点击「菜单 ∪ 触发按钮」之外的任何位置（含卡片本体）关闭菜单；触发按钮的
// pointerdown 被算作内部、click 仍执行开关切换，避免双重切换。
function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (menu.value?.contains(target) || trigger.value?.contains(target)) return
  open.value = false
}

// Escape 分级关闭：菜单打开时只关菜单（阻止冒泡，不再关卡片）；菜单关闭时
// 不拦截，Escape 照旧关闭整张卡片。
function handleKeyDown(event: KeyboardEvent) {
  if (!open.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  open.value = false
}

// 倒计时归零即本地翻转：清除本地屏蔽状态（不发请求），pill 消失、菜单回到
// 未屏蔽动作（spec：过期 = 不存在，下次打开卡片以服务端为准）。
function tick() {
  now.value = Date.now()
  const current = block.value
  if (current?.kind !== 'temporary') return
  const expiresAt = current.expiresAt
  if (!expiresAt || new Date(expiresAt).getTime() - now.value <= 0) {
    permissions.expireBlock(props.userId)
  }
}

async function setBlock(kind: CallBlockKind) {
  busy.value = true
  issue.value = ''
  try {
    await permissions.setBlock(props.userId, kind)
    open.value = false
  } catch (error) {
    issue.value = error instanceof Error ? error.message : '更新呼叫屏蔽失败'
  } finally {
    busy.value = false
  }
}

async function removeBlock() {
  busy.value = true
  issue.value = ''
  try {
    await permissions.removeBlock(props.userId)
    open.value = false
  } catch (error) {
    issue.value = error instanceof Error ? error.message : '解除呼叫屏蔽失败'
  } finally {
    busy.value = false
  }
}

// 卡片每次打开都从服务端读取当前屏蔽状态，不复用上次卡片的缓存。
onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  document.addEventListener('keydown', handleKeyDown, true)
  tickTimer = window.setInterval(tick, 1000)
  void permissions.fetchBlock(props.userId).catch(() => undefined)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  document.removeEventListener('keydown', handleKeyDown, true)
  window.clearInterval(tickTimer)
})
</script>

<template>
  <span v-if="block" class="profile-card-pill call-blocked-state">
    <Ban :size="13" />
    <span v-if="block.kind === 'temporary'">
      已屏蔽呼叫 · {{ formatCallBlockCountdown(Math.max(0, remainingMs ?? 0)) }} 后解除
    </span>
    <span v-else>已屏蔽呼叫 · 永久</span>
  </span>
  <div class="profile-card-block-control">
    <button
      ref="trigger"
      class="profile-card-call-button block"
      type="button"
      title="呼叫屏蔽"
      aria-label="呼叫屏蔽"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Ban :size="16" />
    </button>
    <div v-if="open" ref="menu" class="profile-card-block-menu" role="menu" aria-label="呼叫屏蔽">
      <span v-if="block?.kind === 'temporary'" class="profile-card-block-state">
        暂时屏蔽 · {{ callBlockRemainingLabel(block.expiresAt) }}
      </span>
      <span v-else-if="block?.kind === 'permanent'" class="profile-card-block-state">永久屏蔽中</span>
      <button v-if="block?.kind === 'temporary'" type="button" :disabled="busy" @click="setBlock('permanent')">转为永久屏蔽</button>
      <button v-else-if="block?.kind === 'permanent'" type="button" :disabled="busy" @click="setBlock('temporary')">转为暂时屏蔽 24 小时</button>
      <template v-else>
        <button type="button" :disabled="busy" @click="setBlock('temporary')">暂时屏蔽 24 小时</button>
        <button type="button" :disabled="busy" @click="setBlock('permanent')">永久屏蔽</button>
      </template>
      <button v-if="block" class="danger-text" type="button" :disabled="busy" @click="removeBlock">解除屏蔽</button>
      <span v-if="issue" class="form-error">{{ issue }}</span>
    </div>
  </div>
</template>
