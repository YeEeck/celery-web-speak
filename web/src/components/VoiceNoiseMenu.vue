<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, Settings2, Volume2 } from '@lucide/vue'
import { useVoiceStore } from '../stores/voice'

const props = defineProps<{
  trigger: HTMLButtonElement
}>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  settings: [trigger: HTMLButtonElement]
}>()

const voice = useVoiceStore()
const menu = ref<HTMLElement | null>(null)
const left = ref(0)
const top = ref(0)
const maxHeight = ref<number | null>(null)
const positioned = ref(false)
const options = computed(() => [
  { value: 'off', label: '关闭' },
  { value: 'webrtc', label: '系统降噪（WebRTC）' },
  { value: 'rnnoise', label: '增强降噪（RNNoise）' },
] as const)

function radioItems() {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])
}

function focusRadio(index: number) {
  const items = radioItems()
  if (!items.length) return
  items[(index + items.length) % items.length]?.focus()
}

function focusInitialRadio() {
  const target = radioItems().find((item) => item.dataset.option === voice.noiseSuppressionOption) ?? radioItems()[0]
  target?.focus()
}

function handleKeyDown(event: KeyboardEvent) {
  const items = radioItems()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusRadio(current + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusRadio(current - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusRadio(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusRadio(items.length - 1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close', true)
  } else if (event.key === 'Tab') {
    emit('close', false)
  }
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (menu.value?.contains(target) || props.trigger.contains(target)) return
  emit('close', false)
}

function closeOnViewportChange(event: Event) {
  if (event.type === 'scroll' && event.target instanceof Node && menu.value?.contains(event.target)) return
  emit('close', false)
}

function selectOption(option: (typeof options.value)[number]['value']) {
  if (option !== voice.noiseSuppressionOption) voice.setNoiseSuppressionOption(option)
}

function openSettings() {
  emit('settings', props.trigger)
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('resize', closeOnViewportChange)
  window.addEventListener('scroll', closeOnViewportChange, true)
  await nextTick()
  const margin = 8
  const gap = 8
  const triggerBounds = props.trigger.getBoundingClientRect()
  maxHeight.value = Math.max(0, triggerBounds.top - gap - margin)
  await nextTick()
  const bounds = menu.value?.getBoundingClientRect()
  if (!bounds) return
  // 进入动画会对菜单施加 transform（scale(.98)），getBoundingClientRect 会返回
  // 缩放后的尺寸导致锚定偏移；offsetWidth/offsetHeight 是未变换的布局尺寸。
  const menuWidth = menu.value!.offsetWidth
  const menuHeight = menu.value!.offsetHeight
  const centeredLeft = triggerBounds.left + (triggerBounds.width - menuWidth) / 2
  left.value = Math.min(Math.max(margin, centeredLeft), window.innerWidth - menuWidth - margin)
  top.value = Math.max(margin, triggerBounds.top - gap - menuHeight)
  positioned.value = true
  await nextTick()
  focusInitialRadio()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('resize', closeOnViewportChange)
  window.removeEventListener('scroll', closeOnViewportChange, true)
})
</script>

<template>
  <section
    ref="menu"
    class="voice-noise-menu motion-origin-bottom"
    :class="{ positioned }"
    :style="{ left: `${left}px`, top: `${top}px`, maxHeight: maxHeight === null ? undefined : `${maxHeight}px` }"
    role="menu"
    aria-label="降噪方法"
    @keydown="handleKeyDown"
  >
    <header><Volume2 :size="16" /><strong>降噪方法</strong></header>
    <div class="voice-noise-option-list">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="menuitemradio"
        :data-option="option.value"
        :aria-checked="option.value === voice.noiseSuppressionOption"
        :title="option.label"
        @click="selectOption(option.value)"
      >
        <span class="voice-noise-radio" aria-hidden="true"><Check v-if="option.value === voice.noiseSuppressionOption" :size="13" /></span>
        <span class="voice-noise-name">{{ option.label }}</span>
      </button>
    </div>
    <div class="voice-noise-actions">
      <button type="button" role="menuitem" @click="openSettings"><Settings2 :size="16" />语音设置</button>
    </div>
  </section>
</template>
