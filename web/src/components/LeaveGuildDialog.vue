<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LoaderCircle, LogOut } from '@lucide/vue'
import type { GuildSummary } from '../types'

const props = defineProps<{ guild: GuildSummary; busy: boolean }>()
const emit = defineEmits<{ cancel: []; confirm: [] }>()
const panel = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)

function cancel() {
  if (!props.busy) emit('cancel')
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (!focusable.length) {
    event.preventDefault()
    panel.value?.focus()
    return
  }
  const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
  event.preventDefault()
  const direction = event.shiftKey ? -1 : 1
  focusable[(current + direction + focusable.length) % focusable.length]?.focus()
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeyDown)
  await nextTick()
  cancelButton.value?.focus()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop leave-guild-backdrop" @mousedown.self="cancel">
      <section ref="panel" class="leave-guild-panel" role="alertdialog" aria-modal="true" aria-labelledby="leave-guild-title" aria-describedby="leave-guild-description" tabindex="-1">
        <h2 id="leave-guild-title">离开“{{ guild.name }}”？</h2>
        <p id="leave-guild-description">你的成员身份将被移除，之后需要由服务器管理员重新添加。你发送的历史消息不会被删除。</p>
        <footer>
          <button ref="cancelButton" class="secondary-button" type="button" :disabled="busy" @click="cancel">取消</button>
          <button class="danger-button" type="button" :disabled="busy" @click="emit('confirm')">
            <LoaderCircle v-if="busy" :size="17" class="spin" />
            <LogOut v-else :size="17" />
            {{ busy ? '正在离开' : '离开服务器' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
