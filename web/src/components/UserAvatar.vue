<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface AvatarUser {
  id: number
  hasAvatar: boolean
  avatarVersion: number
}

const props = withDefaults(defineProps<{
  name: string
  size?: number
  online?: boolean
  user?: AvatarUser
}>(), {
  size: 36,
  online: false,
  user: undefined,
})

const palette = ['#5865f2', '#248046', '#d83c3e', '#a64d79', '#ca8a04', '#0f766e', '#7c3aed', '#b45309']
const color = computed(() => {
  let hash = 0
  for (const char of props.name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]
})
const initial = computed(() => Array.from(props.name.trim())[0]?.toUpperCase() || '?')

const imageUrl = computed(() => {
  if (!props.user || !props.user.hasAvatar || props.user.avatarVersion < 1) return ''
  return `/api/users/${props.user.id}/avatar?v=${props.user.avatarVersion}`
})
const imgFailed = ref(false)
const showImage = computed(() => imageUrl.value !== '' && !imgFailed.value)
watch(() => imageUrl.value, () => { imgFailed.value = false })
</script>

<template>
  <span class="avatar-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
    <img v-if="showImage" class="avatar profile-avatar" :src="imageUrl" alt="" @error="imgFailed = true" />
    <span v-else class="avatar" :style="{ backgroundColor: color, fontSize: `${Math.max(12, size * 0.42)}px` }">{{ initial }}</span>
    <span v-if="online" class="online-dot" aria-label="在线" />
  </span>
</template>

<style scoped>
.profile-avatar { object-fit: cover; display: block; }
</style>