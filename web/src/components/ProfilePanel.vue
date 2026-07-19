<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Headphones, Mic, Save, UserRound, X } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'

defineEmits<{ close: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const displayName = ref(app.user!.displayName)
const currentPassword = ref('')
const newPassword = ref('')
const saving = ref(false)
const message = ref('')
const errorMessage = ref('')

onMounted(() => void voice.refreshDevices(false))

async function save() {
  saving.value = true
  message.value = ''
  errorMessage.value = ''
  try {
    await app.updateProfile({
      displayName: displayName.value,
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    currentPassword.value = ''
    newPassword.value = ''
    message.value = '设置已保存'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="$emit('close')">
    <section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <header class="panel-header">
        <div><h2 id="profile-title">用户设置</h2><p>@{{ app.user!.username }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <div class="settings-scroll">
        <section class="settings-section">
          <h3><UserRound :size="18" />账号</h3>
          <label><span>显示名称</span><input v-model.trim="displayName" maxlength="32" /></label>
          <div class="two-column">
            <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" /></label>
            <label><span>新密码</span><input v-model="newPassword" type="password" minlength="10" autocomplete="new-password" /></label>
          </div>
        </section>

        <section class="settings-section">
          <h3><Mic :size="18" />输入设备</h3>
          <label>
            <span>麦克风</span>
            <select :value="voice.activeInputId" :disabled="!voice.joined" @change="voice.switchInput(($event.target as HTMLSelectElement).value)">
              <option v-if="!voice.inputDevices.length" value="">系统默认</option>
              <option v-for="device in voice.inputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || '麦克风' }}</option>
            </select>
          </label>
          <label class="audio-level-control">
            <span><span>麦克风增益</span><strong>{{ Math.round(voice.microphoneGain * 100) }}%</strong></span>
            <input
              type="range"
              min="0"
              max="3"
              step="0.05"
              :value="voice.microphoneGain"
              aria-label="麦克风增益"
              @input="voice.setMicrophoneGain(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
        </section>

        <section class="settings-section">
          <h3><Headphones :size="18" />输出设备</h3>
          <label>
            <span>扬声器</span>
            <select :value="voice.activeOutputId" :disabled="!voice.joined || !voice.outputDevices.length" @change="voice.switchOutput(($event.target as HTMLSelectElement).value)">
              <option v-if="!voice.outputDevices.length" value="">系统默认</option>
              <option v-for="device in voice.outputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || '扬声器' }}</option>
            </select>
          </label>
          <label class="audio-level-control">
            <span><span>扬声器音量</span><strong>{{ Math.round(voice.outputVolume * 100) }}%</strong></span>
            <input
              type="range"
              min="0"
              max="3"
              step="0.05"
              :value="voice.outputVolume"
              aria-label="扬声器音量"
              @input="voice.setOutputVolume(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
        </section>
      </div>
      <footer class="panel-footer">
        <span v-if="errorMessage" class="form-error">{{ errorMessage }}</span><span v-else class="form-success">{{ message }}</span>
        <button class="primary-button" :disabled="saving || !displayName" @click="save"><Save :size="17" />{{ saving ? '保存中' : '保存' }}</button>
      </footer>
    </section>
  </div>
</template>
