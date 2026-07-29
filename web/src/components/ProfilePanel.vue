<script setup lang="ts">
import { onMounted, ref, type ComponentPublicInstance } from 'vue'
import { BellRing, Headphones, Mic, Palette, Play, RefreshCw, Save, Trash2, Upload, UserRound, X } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useSoundStore, type CustomSoundRecord, type NotificationSound, type SoundPresetId, type SoundSource, SOUND_PRESETS } from '../stores/sounds'
import { useThemeStore } from '../stores/theme'
import { useToastStore } from '../stores/toast'
import { useVoiceStore } from '../stores/voice'
import { rangeProgressStyle } from '../utils/range'
import ImageCropperModal from './ImageCropperModal.vue'
import UserAvatar from './UserAvatar.vue'

const props = withDefaults(defineProps<{
  initialTab?: 'account' | 'audio'
  initialAudioSubNav?: 'input' | 'output'
}>(), {
  initialTab: 'account',
  initialAudioSubNav: 'input',
})
defineEmits<{ close: []; changelog: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const sounds = useSoundStore()
const theme = useThemeStore()
const toast = useToastStore()
const tab = ref<'account' | 'audio' | 'sound' | 'theme'>(props.initialTab)
const audioSubNav = ref<'input' | 'output'>(props.initialAudioSubNav)

const displayName = ref(app.user!.displayName)
const currentPassword = ref('')
const newPassword = ref('')
const savingDisplayName = ref(false)
const savingPassword = ref(false)
const passwordError = ref('')

const presetOptions = Object.entries(SOUND_PRESETS).map(([id, { name }]) => ({ id: id as SoundPresetId, name }))
const CUSTOM_OPTION_VALUE = '__custom__'
const CUSTOM_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/wave,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a,audio/webm'
const soundEvents: NotificationSound[] = ['join', 'leave', 'message']
const soundEventLabels: Record<NotificationSound, string> = {
  join: '加入语音',
  leave: '退出语音',
  message: '新文字消息',
}
const customError = ref<Record<NotificationSound, string>>({ join: '', leave: '', message: '' })
const customBusy = ref<Record<NotificationSound, boolean>>({ join: false, leave: false, message: false })
const customFileInputs = new Map<NotificationSound, HTMLInputElement>()

function setCustomFileInput(sound: NotificationSound) {
  return (el: Element | ComponentPublicInstance | null) => {
    if (el instanceof HTMLInputElement) customFileInputs.set(sound, el)
    else customFileInputs.delete(sound)
  }
}

onMounted(() => void voice.refreshDevices(false))

const avatarFile = ref<File | null>(null)
const cropperOpen = ref(false)
const avatarSaving = ref(false)
const avatarError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const allowedAvatarTypes = ['image/png', 'image/jpeg', 'image/webp']

function openAvatarPicker() {
  avatarError.value = ''
  fileInput.value?.click()
}

function onAvatarFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 4 * 1024 * 1024) {
    avatarError.value = '图片大小不能超过 4 MB'
    return
  }
  if (!allowedAvatarTypes.includes(file.type)) {
    avatarError.value = '请选择 PNG、JPEG 或 WebP 图片'
    return
  }
  avatarFile.value = file
  cropperOpen.value = true
}

async function onAvatarCropped(blob: Blob) {
  cropperOpen.value = false
  avatarError.value = ''
  avatarSaving.value = true
  try {
    await toast.runAction(async () => {
      await app.updateAvatar(blob)
    }, '头像已更新')
  } finally {
    avatarSaving.value = false
    avatarFile.value = null
  }
}

async function removeAvatar() {
  if (!app.user?.hasAvatar) return
  avatarError.value = ''
  avatarSaving.value = true
  try {
    await toast.runAction(async () => {
      await app.deleteAvatar()
    }, '头像已移除')
  } finally {
    avatarSaving.value = false
  }
}

function cancelCropper() {
  cropperOpen.value = false
  avatarFile.value = null
}

async function saveDisplayName() {
  if (!displayName.value.trim()) return
  savingDisplayName.value = true
  try {
    await toast.runAction(async () => {
      await app.updateProfile({ displayName: displayName.value })
    }, '显示名称已保存')
  } finally {
    savingDisplayName.value = false
  }
}

async function savePassword() {
  if (newPassword.value.length < 10) {
    passwordError.value = '新密码至少 10 位'
    return
  }
  passwordError.value = ''
  savingPassword.value = true
  try {
    await toast.runAction(async () => {
      await app.updateProfile({
        displayName: app.user!.displayName,
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      })
      currentPassword.value = ''
      newPassword.value = ''
    }, '密码已更新')
  } finally {
    savingPassword.value = false
  }
}

function setSoundEnabled(sound: NotificationSound, event: Event) {
  sounds.setSoundEnabled(sound, (event.target as HTMLInputElement).checked)
}

function onSoundSelectChange(sound: NotificationSound, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === CUSTOM_OPTION_VALUE) {
    sounds.setSoundSource(sound, 'custom')
  } else {
    sounds.setSoundPreset(sound, value as SoundPresetId)
  }
}

function getCustomRecord(sound: NotificationSound): CustomSoundRecord | null {
  if (sound === 'join') return sounds.joinCustom
  if (sound === 'leave') return sounds.leaveCustom
  return sounds.messageCustom
}

function getCurrentSource(sound: NotificationSound): SoundSource {
  if (sound === 'join') return sounds.joinSource
  if (sound === 'leave') return sounds.leaveSource
  return sounds.messageSource
}

function getSelectedDropdownValue(sound: NotificationSound): string {
  if (getCurrentSource(sound) === 'custom' && getCustomRecord(sound)) return CUSTOM_OPTION_VALUE
  if (sound === 'join') return sounds.joinPreset
  if (sound === 'leave') return sounds.leavePreset
  return sounds.messagePreset
}

function isSoundEnabled(sound: NotificationSound): boolean {
  if (sound === 'join') return sounds.joinEnabled
  if (sound === 'leave') return sounds.leaveEnabled
  return sounds.messageEnabled
}

function triggerCustomUpload(sound: NotificationSound) {
  customError.value = { ...customError.value, [sound]: '' }
  customFileInputs.get(sound)?.click()
}

async function onCustomFileChosen(sound: NotificationSound, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  customError.value = { ...customError.value, [sound]: '' }
  customBusy.value = { ...customBusy.value, [sound]: true }
  try {
    const result = await sounds.uploadCustomSound(sound, file)
    if (!result.ok) {
      customError.value = { ...customError.value, [sound]: result.error }
    }
  } finally {
    customBusy.value = { ...customBusy.value, [sound]: false }
  }
}

async function removeCustomSound(sound: NotificationSound) {
  customError.value = { ...customError.value, [sound]: '' }
  customBusy.value = { ...customBusy.value, [sound]: true }
  try {
    await sounds.removeCustomSound(sound)
  } finally {
    customBusy.value = { ...customBusy.value, [sound]: false }
  }
}

function previewPreset(sound: NotificationSound) {
  sounds.previewPreset(sound)
}

function previewCustom(sound: NotificationSound) {
  sounds.previewCustom(sound)
}

const themeModes: { value: 'system' | 'light' | 'dark'; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
]

const accentSwatches: { value: 'indigo' | 'green' | 'rose' | 'amber'; label: string; color: string }[] = [
  { value: 'indigo', label: '靛蓝', color: '#5865f2' },
  { value: 'green', label: '绿色', color: '#23a559' },
  { value: 'rose', label: '玫瑰', color: '#e64855' },
  { value: 'amber', label: '琥珀', color: '#d4a32e' },
]
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
          <h3><UserRound :size="18" />头像</h3>
          <div class="avatar-editor-row">
            <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onAvatarFileChosen" />
            <button class="avatar-trigger" type="button" :disabled="avatarSaving" :aria-label="`更换${app.user!.displayName}的头像`" @click="openAvatarPicker">
              <UserAvatar :name="app.user!.displayName" :size="80" :user="app.user ?? undefined" />
              <span class="avatar-overlay" aria-hidden="true">更换头像</span>
            </button>
            <div class="avatar-editor-actions">
              <button class="secondary-button danger-text" :disabled="avatarSaving || !app.user?.hasAvatar" @click="removeAvatar"><Trash2 :size="16" />移除头像</button>
            </div>
          </div>
          <div class="profile-save-row avatar-editor-message-row">
            <span v-if="avatarError" class="form-error">{{ avatarError }}</span>
          </div>
          <h3><UserRound :size="18" />个人资料</h3>
          <label><span>显示名称</span><input v-model.trim="displayName" maxlength="32" /></label>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingDisplayName || !displayName.trim()" @click="saveDisplayName"><Save :size="17" />{{ savingDisplayName ? '保存中' : '保存显示名称' }}</button>
          </div>
          <h3><UserRound :size="18" />修改密码</h3>
          <div class="two-column">
            <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" /></label>
            <label><span>新密码</span><input v-model="newPassword" type="password" minlength="10" autocomplete="new-password" /></label>
          </div>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingPassword || !currentPassword || !newPassword" @click="savePassword"><Save :size="17" />{{ savingPassword ? '保存中' : '保存密码' }}</button>
            <span v-if="passwordError" class="form-error">{{ passwordError }}</span>
          </div>
          <h3>关于</h3>
          <button class="changelog-entry-button" @click="$emit('changelog')">更新日志</button>
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
                <select :value="voice.preferredInputId" :disabled="voice.deviceChangingKind === 'input'" @change="voice.switchInput(($event.target as HTMLSelectElement).value)">
                  <option v-for="device in voice.inputDeviceOptions" :key="device.deviceId" :value="device.deviceId" :disabled="device.unavailable">
                    {{ device.label }}{{ device.unavailable ? '（不可用）' : device.current && device.deviceId !== voice.preferredInputId ? '（当前使用）' : '' }}
                  </option>
                </select>
              </label>
              <div v-if="voice.devicePermissionState === 'denied'" class="profile-device-feedback">
                <p class="form-error" role="alert">{{ voice.devicePermissionError || '无法访问麦克风，请检查浏览器权限' }}</p>
                <button class="secondary-button" type="button" @click="voice.requestMicrophonePermission()">
                  <RefreshCw :size="16" />重新请求麦克风权限
                </button>
              </div>
              <p v-if="voice.deviceChangeErrorKind === 'input' && voice.deviceChangeError" class="form-error" role="alert">{{ voice.deviceChangeError }}</p>
              <label class="audio-level-control">
                <span><span>麦克风增益</span><strong>{{ Math.round(voice.microphoneGain * 100) }}%</strong></span>
                <input type="range" min="0" max="3" step="0.05" :value="voice.microphoneGain" :style="rangeProgressStyle(voice.microphoneGain, 0, 3)" aria-label="麦克风增益" @input="voice.setMicrophoneGain(Number(($event.target as HTMLInputElement).value))" />
              </label>
              <div class="toggle-list">
                <label><span>回声抑制</span><input type="checkbox" :checked="voice.echoCancellation" @change="voice.setEchoCancellation(($event.target as HTMLInputElement).checked)" /></label>
                <label><span>降噪</span><input type="checkbox" :checked="voice.noiseSuppression" @change="voice.setNoiseSuppression(($event.target as HTMLInputElement).checked)" /></label>
              </div>
              <p v-if="voice.joined" class="profile-hint">处理开关更改将在下次加入语音时生效。</p>
              <label class="setting-toggle">
                <span>静音时说话提醒</span>
                <input type="checkbox" :checked="voice.mutedSpeakingReminderEnabled" aria-label="静音时说话提醒" @change="voice.setMutedSpeakingReminderEnabled(($event.target as HTMLInputElement).checked)" />
              </label>
            </section>
          </div>
          <div v-else>
            <section class="settings-section">
              <h3><Headphones :size="18" />输出设备</h3>
              <label>
                <span>扬声器</span>
                <select :value="voice.preferredOutputId" :disabled="voice.deviceChangingKind === 'output'" @change="voice.switchOutput(($event.target as HTMLSelectElement).value)">
                  <option v-for="device in voice.outputDeviceOptions" :key="device.deviceId" :value="device.deviceId" :disabled="device.unavailable">
                    {{ device.label }}{{ device.unavailable ? '（不可用）' : device.current && device.deviceId !== voice.preferredOutputId ? '（当前使用）' : '' }}
                  </option>
                </select>
              </label>
              <p v-if="voice.deviceChangeErrorKind === 'output' && voice.deviceChangeError" class="form-error" role="alert">{{ voice.deviceChangeError }}</p>
              <label class="audio-level-control">
                <span><span>扬声器音量</span><strong>{{ Math.round(voice.outputVolume * 100) }}%</strong></span>
                <input type="range" min="0" max="3" step="0.05" :value="voice.outputVolume" :style="rangeProgressStyle(voice.outputVolume, 0, 3)" aria-label="扬声器音量" @input="voice.setOutputVolume(Number(($event.target as HTMLInputElement).value))" />
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
            <input type="range" min="0" max="1" step="0.05" :value="sounds.volume" :style="rangeProgressStyle(sounds.volume, 0, 1)" :disabled="!sounds.enabled" aria-label="提示音音量" @input="sounds.setVolume(Number(($event.target as HTMLInputElement).value))" />
          </label>
          <h3><BellRing :size="18" />各事件</h3>
          <div class="sound-event-list">
            <div v-for="sound in soundEvents" :key="sound" class="sound-event-block">
              <div class="sound-event-row">
                <label class="setting-toggle">
                  <span>{{ soundEventLabels[sound] }}</span>
                  <input type="checkbox" :checked="isSoundEnabled(sound)" :disabled="!sounds.enabled" :aria-label="`${soundEventLabels[sound]}提示音`" @change="setSoundEnabled(sound, $event)" />
                </label>
                <label><span>音效</span>
                  <select :value="getSelectedDropdownValue(sound)" :disabled="!sounds.enabled" :aria-label="`${soundEventLabels[sound]}音效`" @change="onSoundSelectChange(sound, $event)">
                    <option v-for="preset in presetOptions" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
                    <option v-if="getCustomRecord(sound)" :value="CUSTOM_OPTION_VALUE">自定义：{{ getCustomRecord(sound)!.name }}</option>
                  </select>
                </label>
              </div>
              <input :ref="setCustomFileInput(sound)" type="file" :accept="CUSTOM_ACCEPT" hidden @change="onCustomFileChosen(sound, $event)" />
              <div class="sound-event-actions">
                <button class="secondary-button" type="button" :disabled="!sounds.enabled || customBusy[sound]" :aria-label="`试听${soundEventLabels[sound]}预置音效`" @click="previewPreset(sound)"><Play :size="14" />试听预置</button>
                <button class="secondary-button" type="button" :disabled="!sounds.enabled || !getCustomRecord(sound) || customBusy[sound]" :aria-label="`试听${soundEventLabels[sound]}自定义音效`" @click="previewCustom(sound)"><Play :size="14" />试听自定义</button>
                <button class="secondary-button" type="button" :disabled="!sounds.enabled || customBusy[sound]" :aria-label="`${getCustomRecord(sound) ? '替换' : '上传'}${soundEventLabels[sound]}自定义音效`" @click="triggerCustomUpload(sound)"><Upload :size="14" />{{ getCustomRecord(sound) ? '替换' : '上传' }}自定义</button>
                <button v-if="getCustomRecord(sound)" class="secondary-button danger-text" type="button" :disabled="!sounds.enabled || customBusy[sound]" :aria-label="`删除${soundEventLabels[sound]}自定义音效`" @click="removeCustomSound(sound)"><Trash2 :size="14" />删除自定义</button>
                <span v-if="customError[sound]" class="form-error">{{ customError[sound] }}</span>
              </div>
            </div>
          </div>
          <p class="profile-hint">自定义音效支持 MP3、WAV、OGG、M4A 与 WEBM；单文件 ≤ 512 KB、时长 ≤ 3 秒；保存在本机 IndexedDB，不上传服务器。</p>
        </section>

        <section v-else-if="tab === 'theme'" class="settings-section">
          <h3><Palette :size="18" />外观模式</h3>
          <div class="theme-mode-group">
            <button v-for="mode in themeModes" :key="mode.value" :class="{ active: theme.mode === mode.value }" @click="theme.setMode(mode.value)">{{ mode.label }}</button>
          </div>
          <h3><Palette :size="18" />强调色</h3>
          <div class="accent-swatches">
            <button v-for="swatch in accentSwatches" :key="swatch.value" :class="['accent-swatch', { active: theme.accent === swatch.value }]" :title="swatch.label" :aria-label="swatch.label" @click="theme.setAccent(swatch.value)">
              <span class="accent-swatch-inner" :style="{ background: swatch.color }" />
            </button>
          </div>
          <p class="profile-hint">主题与强调色仅保存在当前浏览器。</p>
        </section>
      </div>
    </section>
    <ImageCropperModal v-if="cropperOpen && avatarFile" :file="avatarFile" @cancel="cancelCropper" @confirm="onAvatarCropped" />
  </div>
</template>
