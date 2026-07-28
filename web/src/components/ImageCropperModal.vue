<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { Save, X } from '@lucide/vue'

const props = withDefaults(defineProps<{
  file: File
  title?: string
  confirmLabel?: string
}>(), {
  title: '调整头像',
  confirmLabel: '设为头像',
})
const emit = defineEmits<{ cancel: []; confirm: [Blob] }>()

const OUT = 512
const VIEW = 224

const canvas = ref<HTMLCanvasElement | null>(null)
const sourceUrl = ref('')
const image = ref<HTMLImageElement | null>(null)
const scale = ref(1)
const minScale = ref(1)
const maxScale = ref(3)
const posX = ref(0)
const posY = ref(0)
const loading = ref(true)
const dragging = ref(false)
let lastX = 0
let lastY = 0

sourceUrl.value = URL.createObjectURL(props.file)
const img = new Image()
img.onload = () => {
  image.value = img
  minScale.value = OUT / Math.min(img.naturalWidth, img.naturalHeight)
  maxScale.value = minScale.value * 4
  scale.value = minScale.value
  recenter()
  loading.value = false
}
img.onerror = () => {
  loading.value = false
}
img.src = sourceUrl.value

function recenter() {
  const scaledW = (image.value?.naturalWidth ?? 0) * scale.value
  const scaledH = (image.value?.naturalHeight ?? 0) * scale.value
  posX.value = (OUT - scaledW) / 2
  posY.value = (OUT - scaledH) / 2
  draw()
}

function clampPos() {
  const scaledW = (image.value?.naturalWidth ?? 0) * scale.value
  const scaledH = (image.value?.naturalHeight ?? 0) * scale.value
  if (scaledW < OUT) posX.value = (OUT - scaledW) / 2
  else posX.value = Math.min(0, Math.max(OUT - scaledW, posX.value))
  if (scaledH < OUT) posY.value = (OUT - scaledH) / 2
  else posY.value = Math.min(0, Math.max(OUT - scaledH, posY.value))
}

function draw() {
  const canvasEl = canvas.value
  const imgEl = image.value
  if (!canvasEl || !imgEl) return
  const ctx = canvasEl.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, OUT, OUT)
  ctx.drawImage(imgEl, posX.value, posY.value, imgEl.naturalWidth * scale.value, imgEl.naturalHeight * scale.value)
}

function onPointerDown(event: PointerEvent) {
  if (!image.value) return
  dragging.value = true
  lastX = event.clientX
  lastY = event.clientY
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (!dragging.value || !image.value) return
  const dx = (event.clientX - lastX) * (OUT / VIEW)
  const dy = (event.clientY - lastY) * (OUT / VIEW)
  lastX = event.clientX
  lastY = event.clientY
  posX.value += dx
  posY.value += dy
  clampPos()
  draw()
}
function onPointerUp(event: PointerEvent) {
  dragging.value = false
  ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
}

function onZoom(event: Event) {
  scale.value = Number((event.target as HTMLInputElement).value)
  clampPos()
  draw()
}

async function confirm() {
  if (!canvas.value || loading.value) return
  let blob = await new Promise<Blob | null>((resolve) => canvas.value!.toBlob(resolve, 'image/webp', 0.85))
  if (!blob) blob = await new Promise<Blob | null>((resolve) => canvas.value!.toBlob(resolve, 'image/png'))
  if (!blob) return
  emit('confirm', blob)
}

function cancel() {
  emit('cancel')
}

onBeforeUnmount(() => {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop avatar-cropper-backdrop" @mousedown.self="cancel">
      <section class="avatar-cropper" role="dialog" aria-modal="true" aria-labelledby="avatar-cropper-title">
        <header>
          <h3 id="avatar-cropper-title">{{ props.title }}</h3>
          <button class="icon-button" title="取消" @click="cancel"><X :size="20" /></button>
        </header>
        <div class="cropper-stage">
          <canvas
            ref="canvas"
            class="cropper-canvas"
            :class="{ dragging }"
            :width="OUT"
            :height="OUT"
            tabindex="0"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          />
        </div>
        <label class="cropper-zoom">
          <span>缩放</span>
          <input
            type="range"
            :min="minScale"
            :max="maxScale"
            :step="0.01"
            :value="scale"
            :disabled="loading"
            aria-label="缩放"
            @input="onZoom"
          />
        </label>
        <p class="cropper-hint">拖动调整画面位置,滑动缩放裁剪区域。</p>
        <footer>
          <button class="secondary-button" @click="cancel">取消</button>
          <button class="primary-button" :disabled="loading" @click="confirm"><Save :size="16" />{{ props.confirmLabel }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.avatar-cropper-backdrop { z-index: 70; }

.avatar-cropper {
  width: 320px;
  max-width: calc(100vw - 32px);
  background: var(--main);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, .35);
  padding: 16px;
  display: grid;
  gap: 14px;
}
.avatar-cropper header { display: flex; align-items: center; justify-content: space-between; }
.avatar-cropper header h3 { margin: 0; font-size: 16px; }
.cropper-stage { display: grid; place-items: center; }
.cropper-canvas {
  width: 224px;
  height: 224px;
  border-radius: 50%;
  background: var(--elevated);
  touch-action: none;
  cursor: grab;
  outline: 2px solid var(--line);
}
.cropper-canvas.dragging { cursor: grabbing; }
.cropper-zoom { display: grid; gap: 6px; }
.cropper-zoom span { color: var(--muted); font-size: 12px; }
.cropper-zoom input[type="range"] { width: 100%; }
.cropper-hint { color: var(--faint); font-size: 11px; margin: 0; text-align: center; }
.avatar-cropper footer { display: flex; justify-content: flex-end; gap: 8px; }
.avatar-cropper footer .primary-button,
.avatar-cropper footer .secondary-button { min-height: 34px; padding: 0 14px; display: inline-flex; align-items: center; gap: 6px; }
</style>