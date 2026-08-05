<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue'
import { BellRing, Gamepad2, Headphones, Mic, Palette, Play, RefreshCw, Save, Trash2, Upload, UserRound, X } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useApplicationSoundStore, type OperationSoundControl, type OperationSoundEvent } from '../stores/application-sounds'
import { useThemeStore } from '../stores/theme'
import { useToastStore } from '../stores/toast'
import { useVoiceStore } from '../stores/voice'
import { VOICE_OVERLAY_CONFIG_LIMITS } from '../stores/voice-overlay'
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
const emit = defineEmits<{ close: []; changelog: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const sounds = useApplicationSoundStore()
const theme = useThemeStore()
const toast = useToastStore()
const tab = ref<'account' | 'audio' | 'sound' | 'theme' | 'overlay'>(props.initialTab)
const audioSubNav = ref<'input' | 'output'>(props.initialAudioSubNav)

const displayName = ref(app.user!.displayName)
const bio = ref(app.user!.bio ?? '')
const currentPassword = ref('')
const newPassword = ref('')
const savingDisplayName = ref(false)
const savingBio = ref(false)
const savingPassword = ref(false)
const passwordError = ref('')

const customFileInputs = new Map<OperationSoundEvent, HTMLInputElement>()

function setCustomFileInput(sound: OperationSoundEvent) {
  return (el: Element | ComponentPublicInstance | null) => {
    if (el instanceof HTMLInputElement) customFileInputs.set(sound, el)
    else customFileInputs.delete(sound)
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown)
  void voice.refreshDevices(false)
})

onBeforeUnmount(() => document.removeEventListener('keydown', handleKeyDown))

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
      await app.updateProfile({ displayName: displayName.value, bio: bio.value })
    }, '显示名称已保存')
  } finally {
    savingDisplayName.value = false
  }
}

async function saveBio() {
  if ([...bio.value].length > 200) return
  savingBio.value = true
  try {
    await toast.runAction(async () => {
      await app.updateProfile({ displayName: app.user!.displayName, bio: bio.value.trim() })
    }, '简介已保存')
  } finally {
    savingBio.value = false
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
        bio: bio.value,
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

function triggerCustomUpload(sound: OperationSoundControl) {
  customFileInputs.get(sound.event)?.click()
}

async function onCustomFileChosen(sound: OperationSoundControl, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await sound.upload(file)
}

async function removeCustomSound(sound: OperationSoundControl) {
  await sound.removeCustom()
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
        <button v-if="voice.overlayConfigSupported" :class="{ active: tab === 'overlay' }" @click="tab = 'overlay'"><Gamepad2 :size="17" />语音浮层</button>
      </nav>
      <div class="settings-scroll">
        <section v-if="tab === 'account'" class="settings-section motion-content-in">
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
          <label class="profile-bio-label">
            <span>个人简介</span>
            <textarea v-model="bio" maxlength="200" rows="3" placeholder="介绍一下你自己" aria-label="个人简介" />
            <small class="profile-bio-count" :class="{ near: [...bio].length > 180 }">{{ [...bio].length }} / 200</small>
          </label>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingBio || [...bio].length > 200" @click="saveBio"><Save :size="17" />{{ savingBio ? '保存中' : '保存简介' }}</button>
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

        <section v-else-if="tab === 'audio'" class="profile-audio-layout motion-content-in">
          <aside class="profile-audio-nav">
            <button :class="{ active: audioSubNav === 'input' }" @click="audioSubNav = 'input'"><Mic :size="16" />输入</button>
            <button :class="{ active: audioSubNav === 'output' }" @click="audioSubNav = 'output'"><Headphones :size="16" />输出</button>
          </aside>
          <div v-if="audioSubNav === 'input'" class="motion-content-in">
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
                <label>
                  <span>降噪选项</span>
                  <select aria-label="降噪选项" :value="voice.noiseSuppressionOption" @change="voice.setNoiseSuppressionOption(($event.target as HTMLSelectElement).value)">
                    <option value="off">关闭</option>
                    <option value="webrtc">系统降噪（WebRTC）</option>
                    <option value="rnnoise">增强降噪（RNNoise）</option>
                  </select>
                </label>
                <label>
                  <span>自动音量平衡</span>
                  <input type="checkbox" :checked="voice.autoVoiceBalance" aria-label="自动音量平衡" @change="voice.setAutoVoiceBalance(($event.target as HTMLInputElement).checked)" />
                </label>
              </div>
              <p class="profile-hint">自动音量平衡开启后，各说话人的音量将自动均衡到相近水平；按参与者播放控制的手动调节仍作为相对偏置生效。</p>
              <p v-if="voice.joined" class="profile-hint">回声抑制更改将在下次加入语音时生效。</p>
              <label class="setting-toggle">
                <span>静音时说话提醒</span>
                <input type="checkbox" :checked="voice.mutedSpeakingReminderEnabled" aria-label="静音时说话提醒" @change="voice.setMutedSpeakingReminderEnabled(($event.target as HTMLInputElement).checked)" />
              </label>
            </section>
          </div>
          <div v-else class="motion-content-in">
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

        <section v-else-if="tab === 'sound'" class="settings-section sound-settings motion-content-in">
          <h3><BellRing :size="18" />全局</h3>
          <label class="setting-toggle">
            <span>启用提示音</span>
            <input type="checkbox" :checked="sounds.settings.master.enabled" :disabled="sounds.settings.master.phase === 'changing'" aria-label="启用提示音" @change="sounds.settings.master.setEnabled(($event.target as HTMLInputElement).checked)" />
          </label>
          <label class="audio-level-control">
            <span><span>提示音音量</span><strong>{{ Math.round(sounds.settings.master.volume * 100) }}%</strong></span>
            <input type="range" min="0" max="1" step="0.05" :value="sounds.settings.master.volume" :style="rangeProgressStyle(sounds.settings.master.volume, 0, 1)" :disabled="!sounds.settings.master.enabled || sounds.settings.master.phase === 'changing'" aria-label="提示音音量" @input="sounds.settings.master.setVolume(Number(($event.target as HTMLInputElement).value))" />
          </label>
          <span v-if="sounds.settings.master.issue" class="form-error">{{ sounds.settings.master.issue.message }}</span>
          <h3><BellRing :size="18" />各事件</h3>
          <div class="sound-event-list">
            <div v-for="sound in sounds.settings.operationSounds" :key="sound.event" class="sound-event-block" :data-sound="sound.event">
              <div class="sound-event-row">
                <label class="setting-toggle">
                  <span>{{ sound.label }}</span>
                  <input type="checkbox" :checked="sound.enabled" :disabled="!sounds.settings.master.enabled || sound.phase !== 'ready'" @change="sound.setEnabled(($event.target as HTMLInputElement).checked)" />
                </label>
                <label><span>音效</span>
                  <select :value="sound.selectedChoice" :disabled="!sounds.settings.master.enabled || sound.phase !== 'ready'" :aria-label="`${sound.label}音效`" @change="sound.select(($event.target as HTMLSelectElement).value)">
                    <option v-for="choice in sound.choices" :key="choice.key" :value="choice.key">{{ choice.label }}</option>
                  </select>
                </label>
              </div>
              <input :ref="setCustomFileInput(sound.event)" type="file" :accept="sounds.settings.customAccept" :data-sound="sound.event" hidden @change="onCustomFileChosen(sound, $event)" />
              <div class="sound-event-actions">
                <button class="secondary-button" type="button" :disabled="!sounds.settings.master.enabled || sound.phase !== 'ready'" :aria-label="`试听${sound.label}音效`" @click="sound.preview()"><Play :size="14" />试听</button>
                <button class="secondary-button" type="button" :disabled="!sounds.settings.master.enabled || sound.phase !== 'ready'" :aria-label="`${sound.custom.state === 'empty' ? '上传' : '替换'}${sound.label}自定义音效`" @click="triggerCustomUpload(sound)"><Upload :size="14" />{{ sound.custom.state === 'empty' ? '上传' : '替换' }}自定义</button>
                <button v-if="sound.custom.state !== 'empty'" class="secondary-button danger-text" type="button" :disabled="!sounds.settings.master.enabled || sound.phase !== 'ready'" :aria-label="`删除${sound.label}自定义音效`" @click="removeCustomSound(sound)"><Trash2 :size="14" />删除自定义</button>
                <span v-if="sound.issue" class="form-error">{{ sound.issue.message }}</span>
              </div>
            </div>
          </div>
        </section>

        <section v-if="tab === 'overlay'" class="settings-section motion-content-in">
          <h3><Gamepad2 :size="18" />语音浮层</h3>
          <label class="setting-toggle">
            <span>在游戏内显示语音浮层</span>
            <input type="checkbox" :checked="voice.overlayEnabled" aria-label="在游戏内显示语音浮层" @change="voice.setOverlayEnabled(($event.target as HTMLInputElement).checked)" />
          </label>
          <label class="setting-toggle">
            <span>用 Ctrl+Shift+O 切换浮层</span>
            <input type="checkbox" :checked="voice.overlayShortcutEnabled" aria-label="用 Ctrl+Shift+O 切换浮层" @change="voice.setOverlayShortcutEnabled(($event.target as HTMLInputElement).checked)" />
          </label>
          <label class="audio-level-control">
            <span><span>显示大小</span><strong>{{ voice.overlayConfig.scalePercent }}%</strong></span>
            <input type="range" :min="VOICE_OVERLAY_CONFIG_LIMITS.scalePercent.min" :max="VOICE_OVERLAY_CONFIG_LIMITS.scalePercent.max" step="1" :value="voice.overlayConfig.scalePercent" :style="rangeProgressStyle(voice.overlayConfig.scalePercent, VOICE_OVERLAY_CONFIG_LIMITS.scalePercent.min, VOICE_OVERLAY_CONFIG_LIMITS.scalePercent.max)" aria-label="显示大小" @input="voice.setOverlayConfig({ scalePercent: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="audio-level-control">
            <span><span>水平位置</span><strong>{{ voice.overlayConfig.positionXPercent }}%</strong></span>
            <input type="range" :min="VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.min" :max="VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.max" step="1" :value="voice.overlayConfig.positionXPercent" :style="rangeProgressStyle(voice.overlayConfig.positionXPercent, VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.min, VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.max)" aria-label="水平位置" @input="voice.setOverlayConfig({ positionXPercent: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="audio-level-control">
            <span><span>垂直位置</span><strong>{{ voice.overlayConfig.positionYPercent }}%</strong></span>
            <input type="range" :min="VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.min" :max="VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.max" step="1" :value="voice.overlayConfig.positionYPercent" :style="rangeProgressStyle(voice.overlayConfig.positionYPercent, VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.min, VOICE_OVERLAY_CONFIG_LIMITS.positionPercent.max)" aria-label="垂直位置" @input="voice.setOverlayConfig({ positionYPercent: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="audio-level-control">
            <span><span>说话时不透明度</span><strong>{{ voice.overlayConfig.speakingOpacityPercent }}%</strong></span>
            <input type="range" :min="VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.min" :max="VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.max" step="1" :value="voice.overlayConfig.speakingOpacityPercent" :style="rangeProgressStyle(voice.overlayConfig.speakingOpacityPercent, VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.min, VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.max)" aria-label="说话时不透明度" @input="voice.setOverlayConfig({ speakingOpacityPercent: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="audio-level-control">
            <span><span>未说话时不透明度</span><strong>{{ voice.overlayConfig.silentOpacityPercent }}%</strong></span>
            <input type="range" :min="VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.min" :max="VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.max" step="1" :value="voice.overlayConfig.silentOpacityPercent" :style="rangeProgressStyle(voice.overlayConfig.silentOpacityPercent, VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.min, VOICE_OVERLAY_CONFIG_LIMITS.opacityPercent.max)" aria-label="未说话时不透明度" @input="voice.setOverlayConfig({ silentOpacityPercent: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <p class="profile-hint">浮层位置以浮层窗口中心计算，50% 即屏幕正中；拖动实时生效。</p>
        </section>

        <section v-else-if="tab === 'theme'" class="settings-section motion-content-in">
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
    <Teleport to="body">
      <Transition name="motion-modal" appear>
        <ImageCropperModal v-if="cropperOpen && avatarFile" :file="avatarFile" @cancel="cancelCropper" @confirm="onAvatarCropped" />
      </Transition>
    </Teleport>
  </div>
</template>
