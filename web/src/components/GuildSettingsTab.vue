<script setup lang="ts">
import { inject, ref, watch } from 'vue'
import { Save, Trash2 } from '@lucide/vue'
import { request } from '../api'
import { useAppStore } from '../stores/app'
import { useToastStore } from '../stores/toast'
import { guildAdminContextKey } from './guild-admin-context'
import GuildIcon from './GuildIcon.vue'
import ImageCropperModal from './ImageCropperModal.vue'

const app = useAppStore()
const toast = useToastStore()
const { busy } = inject(guildAdminContextKey)!
const guildName = ref(app.activeGuild?.name ?? '')
const iconFile = ref<File | null>(null)
const cropperOpen = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const iconSaving = ref(false)
const iconError = ref('')

const allowedIconTypes = ['image/png', 'image/jpeg', 'image/webp']

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
    await request(`/api/guilds/${app.activeGuildId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    await app.bootstrap()
  }, '服务器名称已更新')
}

function openIconPicker() {
  iconError.value = ''
  fileInput.value?.click()
}

function onIconFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 4 * 1024 * 1024) {
    iconError.value = '图片大小不能超过 4 MB'
    return
  }
  if (!allowedIconTypes.includes(file.type)) {
    iconError.value = '请选择 PNG、JPEG 或 WebP 图片'
    return
  }
  iconFile.value = file
  cropperOpen.value = true
}

async function onIconCropped(blob: Blob) {
  cropperOpen.value = false
  iconError.value = ''
  const form = new FormData()
  form.append('file', blob)
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/icon`, { method: 'POST', body: form })
    await app.bootstrap()
  }, '服务器图标已更新')
  iconFile.value = null
}

async function removeIcon() {
  if (!app.activeGuild?.hasIcon) return
  iconError.value = ''
  await run(async () => {
    await request(`/api/guilds/${app.activeGuildId}/icon`, { method: 'DELETE' })
    await app.bootstrap()
  }, '服务器图标已移除')
}

function cancelCropper() {
  cropperOpen.value = false
  iconFile.value = null
}
</script>

<template>
  <section class="settings-section guild-settings">
    <h3>服务器图标</h3>
    <div class="avatar-editor-row">
      <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onIconFileChosen" />
      <button class="avatar-trigger guild-icon-trigger" type="button" :disabled="busy || iconSaving" :aria-label="`更换${app.activeGuild?.name ?? ''}的服务器图标`" @click="openIconPicker">
        <GuildIcon :name="app.activeGuild?.name ?? ''" :size="80" :guild="app.activeGuild ?? undefined" />
        <span class="avatar-overlay" aria-hidden="true">更换图标</span>
      </button>
      <div class="avatar-editor-actions">
        <button class="secondary-button danger-text" :disabled="busy || iconSaving || !app.activeGuild?.hasIcon" @click="removeIcon"><Trash2 :size="16" />移除图标</button>
      </div>
    </div>
    <div class="profile-save-row avatar-editor-message-row">
      <span v-if="iconError" class="form-error">{{ iconError }}</span>
    </div>

    <h3>服务器名称</h3>
    <div class="guild-rename-row">
      <input v-model.trim="guildName" maxlength="64" aria-label="服务器名称" />
      <button class="secondary-button" :disabled="busy || !guildName || guildName === app.activeGuild?.name" @click="renameGuild"><Save :size="16" />保存名称</button>
    </div>
  </section>
  <ImageCropperModal v-if="cropperOpen && iconFile" :file="iconFile" title="调整服务器图标" confirm-label="设为服务器图标" @cancel="cancelCropper" @confirm="onIconCropped" />
</template>