<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GuildSummary } from '../types'

const props = withDefaults(defineProps<{
  name: string
  size?: number
  guild?: GuildSummary
}>(), {
  size: undefined,
  guild: undefined,
})

const initial = computed(() => Array.from(props.name.trim())[0]?.toUpperCase() || '?')

const iconUrl = computed(() => {
  if (!props.guild || !props.guild.hasIcon || props.guild.iconVersion < 1) return ''
  return `/api/guilds/${props.guild.id}/icon?v=${props.guild.iconVersion}`
})
const imgFailed = ref(false)
const showImage = computed(() => iconUrl.value !== '' && !imgFailed.value)
watch(() => iconUrl.value, () => { imgFailed.value = false })
</script>

<template>
  <span v-if="size !== undefined" class="guild-icon-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
    <img v-if="showImage" class="guild-icon-img" :src="iconUrl" alt="" @error="imgFailed = true" />
    <span v-else class="guild-initial">{{ initial }}</span>
  </span>
  <template v-else>
    <img v-if="showImage" class="guild-icon-img" :src="iconUrl" alt="" @error="imgFailed = true" />
    <span v-else class="guild-initial">{{ initial }}</span>
  </template>
</template>

<style scoped>
.guild-icon-wrap { position: relative; flex: 0 0 auto; display: inline-block; }
.guild-icon-img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>