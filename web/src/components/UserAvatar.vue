<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  name: string
  size?: number
  online?: boolean
}>(), {
  size: 36,
  online: false,
})

const palette = ['#5865f2', '#248046', '#d83c3e', '#a64d79', '#ca8a04', '#0f766e', '#7c3aed', '#b45309']
const color = computed(() => {
  let hash = 0
  for (const char of props.name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]
})
const initial = computed(() => Array.from(props.name.trim())[0]?.toUpperCase() || '?')
</script>

<template>
  <span class="avatar-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
    <span class="avatar" :style="{ backgroundColor: color, fontSize: `${Math.max(12, size * 0.42)}px` }">{{ initial }}</span>
    <span v-if="online" class="online-dot" aria-label="在线" />
  </span>
</template>
