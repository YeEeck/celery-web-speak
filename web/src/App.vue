<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AuthScreen from './components/AuthScreen.vue'
import AppShell from './components/AppShell.vue'
import { useAppStore } from './stores/app'
import { useSoundStore } from './stores/sounds'

const app = useAppStore()
const sounds = useSoundStore()
const startupError = ref('')

onMounted(async () => {
  sounds.installInteractionUnlock()
  try {
    await app.initialize()
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : '应用初始化失败'
  }
})

onBeforeUnmount(() => sounds.removeInteractionUnlock())

function reload() {
  window.location.reload()
}
</script>

<template>
  <main v-if="!app.ready" class="boot-screen" aria-live="polite">
    <span class="brand-mark">C</span>
    <span>正在连接 Celery Web Speak</span>
  </main>
  <main v-else-if="startupError" class="boot-screen error-state">
    <span class="brand-mark">C</span>
    <strong>无法连接服务器</strong>
    <span>{{ startupError }}</span>
    <button class="primary-button" @click="reload">重新加载</button>
  </main>
  <AuthScreen v-else-if="!app.user" />
  <AppShell v-else />
</template>
