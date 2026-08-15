<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Mic, MicOff, Phone, PhoneOff } from '@lucide/vue'
import { useVoiceStore } from '../stores/voice'
import UserAvatar from './UserAvatar.vue'

const voice = useVoiceStore()

const displayName = computed(() => voice.callPeer?.displayName ?? '用户')

// 通话时长（mm:ss）：以 accepted 时刻为起点，每秒刷新。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

// 通话中 Ctrl+Shift+M 复用全局麦克风静音（prototype 08：同一偏好）。全局快捷键
// 在 aria-modal 内不拦截，由浮层自己接管；浮层打开但未进入通话中时不响应。
function handleKeyDown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.repeat) return
  if (event.code !== 'KeyM' || voice.callStatus !== 'active') return
  event.preventDefault()
  void voice.toggleMute()
}

onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 1000)
  document.addEventListener('keydown', handleKeyDown)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('keydown', handleKeyDown)
})

const elapsedSeconds = computed(() => {
  const started = voice.callConnectedAt
  if (started == null) return 0
  return Math.max(0, Math.floor((now.value - started) / 1000))
})

const durationLabel = computed(() => {
  const total = elapsedSeconds.value
  const m = Math.floor(total / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(m)}:${pad(s)}`
})

function cancel() {
  void voice.cancelCall()
}

function accept() {
  void voice.acceptCall()
}

function reject() {
  void voice.rejectCall()
}

function rejectAndBlockTemporarily() {
  void voice.rejectAndBlockTemporarily()
}

function hangup() {
  void voice.hangupCall()
}

function toggleMute() {
  void voice.toggleCallMicrophoneMute()
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop call-overlay-backdrop motion-modal-static">
      <section class="call-overlay-panel" role="dialog" aria-modal="true" aria-label="通话浮层">
        <UserAvatar :name="displayName" :size="72" />
        <strong class="call-overlay-name">{{ displayName }}</strong>

        <span v-if="voice.callReconnecting" class="call-overlay-status reconnecting">正在重连…</span>

        <template v-else-if="voice.callStatus === 'outgoing'">
          <span class="call-overlay-status">正在呼叫…</span>
          <button class="call-action hangup" type="button" title="取消" aria-label="取消" @click="cancel">
            <PhoneOff :size="24" />
          </button>
        </template>

        <template v-else-if="voice.callStatus === 'ringing'">
          <span class="call-overlay-status">来电</span>
          <div class="call-overlay-actions">
            <button class="call-action accept" type="button" title="接听" aria-label="接听" @click="accept">
              <Phone :size="24" />
            </button>
            <button class="call-action reject" type="button" title="拒绝" aria-label="拒绝" @click="reject">
              <PhoneOff :size="24" />
            </button>
          </div>
          <button class="call-overlay-block-temporary" type="button" @click="rejectAndBlockTemporarily">
            暂时屏蔽 24 小时
          </button>
        </template>

        <template v-else-if="voice.callStatus === 'active'">
          <span class="call-overlay-status">{{ durationLabel }}</span>
          <div class="call-overlay-actions">
            <button
              class="call-action"
              :class="{ muted: voice.callMicrophoneMuted }"
              type="button"
              :title="voice.callMicrophoneMuted ? '取消麦克风静音' : '麦克风静音'"
              :aria-label="voice.callMicrophoneMuted ? '取消麦克风静音' : '麦克风静音'"
              @click="toggleMute"
            >
              <MicOff v-if="voice.callMicrophoneMuted" :size="24" />
              <Mic v-else :size="24" />
            </button>
            <button class="call-action hangup" type="button" title="挂断" aria-label="挂断" @click="hangup">
              <PhoneOff :size="24" />
            </button>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>
