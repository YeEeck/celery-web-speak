<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, LoaderCircle, Mic, RefreshCw, Settings2, Volume2 } from '@lucide/vue'
import { useVoiceStore } from '../stores/voice'

const props = defineProps<{
  kind: 'input' | 'output'
  x: number
  y: number
  trigger: HTMLButtonElement
}>()
const emit = defineEmits<{
  close: [restoreFocus?: boolean]
  settings: [kind: 'input' | 'output', trigger: HTMLButtonElement]
}>()

const voice = useVoiceStore()
const menu = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const availableHeight = ref<number | null>(null)
const positioned = ref(false)
const options = computed(() => props.kind === 'input' ? voice.inputDeviceOptions : voice.outputDeviceOptions)
const preferredId = computed(() => props.kind === 'input' ? voice.preferredInputId : voice.preferredOutputId)
const title = computed(() => props.kind === 'input' ? '输入设备' : '输出设备')
const permissionBusy = computed(() => voice.devicePermissionState === 'requesting')
const error = computed(() => {
  if (voice.deviceChangeErrorKind === props.kind) return voice.deviceChangeError
  if (props.kind === 'input' && voice.devicePermissionState === 'denied') {
    return voice.devicePermissionError || '无法访问麦克风，请检查浏览器权限'
  }
  return ''
})

function radioItems() {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])
}

function focusRadio(index: number) {
  const items = radioItems()
  if (!items.length) return
  items[(index + items.length) % items.length]?.focus()
}

function focusInitialRadio() {
  const preferred = options.value.find((option) => option.deviceId === preferredId.value && !option.unavailable)
  const targetId = preferred?.deviceId ?? 'default'
  const target = radioItems().find((item) => item.dataset.deviceId === targetId) ?? radioItems()[0]
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

async function selectDevice(deviceId: string) {
  if (props.kind === 'input') await voice.switchInput(deviceId)
  else await voice.switchOutput(deviceId)
}

function openSettings() {
  emit('settings', props.kind, props.trigger)
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('resize', closeOnViewportChange)
  window.addEventListener('scroll', closeOnViewportChange, true)
  await nextTick()
  const bounds = menu.value?.getBoundingClientRect()
  if (!bounds) return
  const margin = 8
  left.value = Math.min(Math.max(margin, props.x), window.innerWidth - bounds.width - margin)
  top.value = Math.min(Math.max(margin, props.y), window.innerHeight - bounds.height - margin)
  availableHeight.value = window.innerHeight - top.value - margin
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
  <Teleport to="body">
    <section
      ref="menu"
      class="voice-device-menu"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px`, maxHeight: availableHeight === null ? undefined : `${availableHeight}px` }"
      role="menu"
      :aria-label="title"
      @keydown="handleKeyDown"
    >
      <header><Mic v-if="kind === 'input'" :size="16" /><Volume2 v-else :size="16" /><strong>{{ title }}</strong></header>
      <div class="voice-device-list">
        <button
          v-for="option in options"
          :key="option.deviceId"
          type="button"
          role="menuitemradio"
          :data-device-id="option.deviceId"
          :aria-checked="option.deviceId === preferredId"
          :aria-disabled="option.unavailable"
          :disabled="option.unavailable"
          :title="option.label"
          @click="selectDevice(option.deviceId)"
        >
          <span class="voice-device-radio" aria-hidden="true"><Check v-if="option.deviceId === preferredId" :size="13" /></span>
          <span class="voice-device-name">{{ option.label }}</span>
          <small v-if="option.unavailable">不可用</small>
          <small v-else-if="option.current && option.deviceId !== preferredId">当前使用</small>
          <LoaderCircle v-if="voice.deviceChangingKind === kind && voice.deviceChangingId === option.deviceId" :size="14" class="spin" />
        </button>
      </div>
      <p v-if="error" class="voice-device-error" role="alert">{{ error }}</p>
      <div class="voice-device-actions">
        <button
          v-if="kind === 'input' && voice.devicePermissionState === 'denied'"
          type="button"
          role="menuitem"
          :disabled="permissionBusy"
          @click="voice.requestMicrophonePermission()"
        ><LoaderCircle v-if="permissionBusy" :size="16" class="spin" /><RefreshCw v-else :size="16" />重新请求麦克风权限</button>
        <button type="button" role="menuitem" @click="openSettings"><Settings2 :size="16" />语音设置</button>
      </div>
    </section>
  </Teleport>
</template>
