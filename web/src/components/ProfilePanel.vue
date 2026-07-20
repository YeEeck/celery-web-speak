<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { BellRing, Headphones, Mic, Palette, Save, UserRound, X } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useSoundStore, type NotificationSound } from '../stores/sounds'
import { useThemeStore } from '../stores/theme'
import { useVoiceStore } from '../stores/voice'

defineEmits<{ close: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const sounds = useSoundStore()
const theme = useThemeStore()
const tab = ref<'account' | 'audio' | 'sound' | 'theme'>('account')
const audioSubNav = ref<'input' | 'output'>('input')

const displayName = ref(app.user!.displayName)
const currentPassword = ref('')
const newPassword = ref('')
const savingDisplayName = ref(false)
const savingPassword = ref(false)
const displayNameMessage = ref('')
const displayNameError = ref('')
const passwordMessage = ref('')
const passwordError = ref('')

onMounted(() => void voice.refreshDevices(false))

async function saveDisplayName() {
  if (!displayName.value.trim()) return
  savingDisplayName.value = true
  displayNameMessage.value = ''
  displayNameError.value = ''
  try {
    await app.updateProfile({ displayName: displayName.value })
    displayNameMessage.value = '显示名称已保存'
  } catch (error) {
    displayNameError.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    savingDisplayName.value = false
  }
}

async function savePassword() {
  if (newPassword.value.length < 10) {
    passwordError.value = '新密码至少 10 位'
    return
  }
  savingPassword.value = true
  passwordMessage.value = ''
  passwordError.value = ''
  try {
    await app.updateProfile({
      displayName: app.user!.displayName,
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    currentPassword.value = ''
    newPassword.value = ''
    passwordMessage.value = '密码已更新'
  } catch (error) {
    passwordError.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    savingPassword.value = false
  }
}

function setSoundEnabled(sound: NotificationSound, event: Event) {
  sounds.setSoundEnabled(sound, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="$emit('close')">
    <section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <header class="panel-header">
        <div><h2 id="profile-title">用户设置</h2><p>@{{ app.user!.username }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="profile-tabs">
        <button :class="{ active: tab === 'account' }" @click="tab = 'account'"><UserRound :size="17" />账号</button>
        <button :class="{ active: tab === 'audio' }" @click="tab = 'audio'"><Mic :size="17" />音频</button>
        <button :class="{ active: tab === 'sound' }" @click="tab = 'sound'"><BellRing :size="17" />音效</button>
        <button :class="{ active: tab === 'theme' }" @click="tab = 'theme'"><Palette :size="17" />主题</button>
      </nav>
      <div class="settings-scroll">
        <section v-if="tab === 'account'" class="settings-section">
          <h3><UserRound :size="18" />个人资料</h3>
          <label><span>显示名称</span><input v-model.trim="displayName" maxlength="32" /></label>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingDisplayName || !displayName.trim()" @click="saveDisplayName"><Save :size="17" />{{ savingDisplayName ? '保存中' : '保存显示名称' }}</button>
            <span v-if="displayNameError" class="form-error">{{ displayNameError }}</span>
            <span v-else-if="displayNameMessage" class="form-success">{{ displayNameMessage }}</span>
          </div>
          <h3><UserRound :size="18" />修改密码</h3>
          <div class="two-column">
            <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" /></label>
            <label><span>新密码</span><input v-model="newPassword" type="password" minlength="10" autocomplete="new-password" /></label>
          </div>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingPassword || !currentPassword || !newPassword" @click="savePassword"><Save :size="17" />{{ savingPassword ? '保存中' : '保存密码' }}</button>
            <span v-if="passwordError" class="form-error">{{ passwordError }}</span>
            <span v-else-if="passwordMessage" class="form-success">{{ passwordMessage }}</span>
          </div>
        </section>

        <section v-else-if="tab === 'audio'" class="profile-audio-layout">
          <aside class="profile-audio-nav">
            <button :class="{ active: audioSubNav === 'input' }" @click="audioSubNav = 'input'"><Mic :size="16" />输入</button>
            <button :class="{ active: audioSubNav === 'output' }" @click="audioSubNav = 'output'"><Headphones :size="16" />输出</button>
          </aside>
          <div v-if="audioSubNav === 'input'">
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
                <input type="range" min="0" max="3" step="0.05" :value="voice.microphoneGain" aria-label="麦克风增益" @input="voice.setMicrophoneGain(Number(($event.target as HTMLInputElement).value))" />
              </label>
            </section>
          </div>
          <div v-else>
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
                <input type="range" min="0" max="3" step="0.05" :value="voice.outputVolume" aria-label="扬声器音量" @input="voice.setOutputVolume(Number(($event.target as HTMLInputElement).value))" />
              </label>
            </section>
          </div>
        </section>

        <section v-else-if="tab === 'sound'" class="settings-section sound-settings">
          <h3><BellRing :size="18" />全局</h3>
          <label class="setting-toggle">
            <span>启用提示音</span>
            <input type="checkbox" :checked="sounds.enabled" aria-label="启用提示音" @change="sounds.setEnabled(($event.target as HTMLInputElement).checked)" />
          </label>
          <label class="audio-level-control">
            <span><span>提示音音量</span><strong>{{ Math.round(sounds.volume * 100) }}%</strong></span>
            <input type="range" min="0" max="1" step="0.05" :value="sounds.volume" :disabled="!sounds.enabled" aria-label="提示音音量" @input="sounds.setVolume(Number(($event.target as HTMLInputElement).value))" />
          </label>
          <h3><BellRing :size="18" />各事件</h3>
          <div class="sound-toggle-list">
            <label><span>加入语音</span><input type="checkbox" :checked="sounds.joinEnabled" :disabled="!sounds.enabled" @change="setSoundEnabled('join', $event)" /></label>
            <label><span>退出语音</span><input type="checkbox" :checked="sounds.leaveEnabled" :disabled="!sounds.enabled" @change="setSoundEnabled('leave', $event)" /></label>
            <label><span>新文字消息</span><input type="checkbox" :checked="sounds.messageEnabled" :disabled="!sounds.enabled" @change="setSoundEnabled('message', $event)" /></label>
          </div>
        </section>

        <section v-else-if="tab === 'theme'" class="settings-section">
          <h3><Palette :size="18" />主题</h3>
          <p class="profile-hint">主题与强调色仅保存在当前浏览器。</p>
        </section>
      </div>
      <footer class="panel-footer"><span class="profile-hint">用户设置</span></footer>
    </section>
  </div>
</template>
