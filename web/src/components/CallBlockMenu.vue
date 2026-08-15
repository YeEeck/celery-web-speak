<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Ban } from '@lucide/vue'
import { useCallPermissionsStore } from '../stores/call-permissions'
import type { CallBlockKind } from '../types'
import { callBlockRemainingLabel } from '../utils/call-block'

const props = defineProps<{ userId: number }>()

const permissions = useCallPermissionsStore()
const open = ref(false)
const busy = ref(false)
const issue = ref('')

const block = computed(() => permissions.blockState(props.userId))

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
  void permissions.fetchBlock(props.userId).catch(() => undefined)
})
</script>

<template>
  <div class="profile-card-block-control">
    <button
      class="profile-card-call-button block"
      type="button"
      title="呼叫屏蔽"
      aria-label="呼叫屏蔽"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Ban :size="16" />
    </button>
    <div v-if="open" class="profile-card-block-menu" role="menu" aria-label="呼叫屏蔽">
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
