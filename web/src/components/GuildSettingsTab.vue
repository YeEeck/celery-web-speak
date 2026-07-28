<script setup lang="ts">
import { inject, ref, watch } from 'vue'
import { Save } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { guildAdminContextKey } from './guild-admin-context'

const app = useAppStore()
const toast = useToastStore()
const { busy } = inject(guildAdminContextKey)!
const guildName = ref(app.activeGuild?.name ?? '')

watch(() => app.activeGuild, (guild) => {
  guildName.value = guild?.name ?? ''
})

async function run(action: () => Promise<void>, success: string) {
  busy.value = true
  try {
    await toast.runAction(action, success)
  } finally {
    busy.value = false
  }
}

async function renameGuild() {
  const name = guildName.value.trim()
  if (!name || app.activeGuildId === null) return
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    await app.bootstrap()
  }, '服务器名称已更新')
}
</script>

<template>
  <section class="settings-section guild-settings">
    <h3>服务器名称</h3>
    <div class="guild-rename-row">
      <input v-model.trim="guildName" maxlength="64" aria-label="服务器名称" />
      <button class="secondary-button" :disabled="busy || !guildName || guildName === app.activeGuild?.name" @click="renameGuild"><Save :size="16" />保存名称</button>
    </div>
  </section>
</template>
