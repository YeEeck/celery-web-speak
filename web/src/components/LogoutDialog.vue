<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LoaderCircle, LogOut } from '@lucide/vue'

const props = defineProps<{ busy: boolean; voiceJoined: boolean }>()
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
  const direction = event.shiftKey ? -1 : 1
  event.preventDefault()
  focusable[(current + direction + focusable.length) % focusable.length]?.focus()
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeyDown)
  await nextTick()
  cancelButton.value?.focus()
})

onBeforeUnmount(() => document.removeEventListener('keydown', handleKeyDown))
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop logout-backdrop motion-modal-static" @mousedown.self="cancel">
      <section ref="panel" class="logout-panel" role="alertdialog" aria-modal="true" aria-labelledby="logout-confirm-title" aria-describedby="logout-confirm-description" tabindex="-1">
        <h2 id="logout-confirm-title">退出登录？</h2>
        <p id="logout-confirm-description">{{ voiceJoined ? '退出后将断开当前语音连接。' : '你需要重新输入账号和密码才能继续使用。' }}</p>
        <footer>
          <button ref="cancelButton" class="secondary-button" type="button" :disabled="busy" @click="cancel">取消</button>
          <button class="danger-button" type="button" :disabled="busy" @click="emit('confirm')">
            <LoaderCircle v-if="busy" :size="17" class="spin" />
            <LogOut v-else :size="17" />
            {{ busy ? '正在退出' : '退出' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
