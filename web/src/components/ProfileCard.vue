<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Crown, ShieldCheck, MicOff, MessageSquareOff, Ban } from '@lucide/vue'
import type { User, UserProfile } from '../types'
import UserAvatar from './UserAvatar.vue'

const props = defineProps<{
  userId: number
  profile: UserProfile | null
  member: User | null
  loading: boolean
  failed: boolean
  x: number
  y: number
  trigger: HTMLElement | null
  isSelf: boolean
}>()
const emit = defineEmits<{ close: [restoreFocus?: boolean] }>()

const panel = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const positioned = ref(false)

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close', true)
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (panel.value?.contains(target) || props.trigger?.contains(target)) return
  emit('close', false)
}

function closeOnViewportChange(event: Event) {
  if (event.type === 'scroll' && event.target instanceof Node && panel.value?.contains(event.target)) return
  emit('close', false)
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('resize', closeOnViewportChange)
  window.addEventListener('scroll', closeOnViewportChange, true)
  await nextTick()
  const triggerBounds = props.trigger?.getBoundingClientRect()
  const bounds = panel.value?.getBoundingClientRect()
  if (!triggerBounds || !bounds) return
  const margin = 8
  const gap = 8
  const maxWidth = window.innerWidth - bounds.width - margin
  const maxHeight = window.innerHeight - bounds.height - margin
  const center = triggerBounds.left + triggerBounds.width / 2
  const openRight = center <= window.innerWidth / 2
  const proposedLeft = openRight ? triggerBounds.right + gap : triggerBounds.left - gap - bounds.width
  left.value = Math.min(Math.max(margin, proposedLeft), maxWidth)
  top.value = Math.min(Math.max(margin, triggerBounds.top), maxHeight)
  positioned.value = true
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('resize', closeOnViewportChange)
  window.removeEventListener('scroll', closeOnViewportChange, true)
})

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function formatDate(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const roleLabel = (role: string | undefined) => (role === 'owner' ? '服务器所有者' : role === 'admin' ? '服务器管理员' : '普通成员')

function remainingBan(member: User): string {
  if (!member.temporaryBanUntil) return ''
  const ms = new Date(member.temporaryBanUntil).getTime() - Date.now()
  if (ms <= 0) return ''
  const minutes = Math.ceil(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟后解除`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `${hours} 小时后解除`
  return `${Math.ceil(hours / 24)} 天后解除`
}
</script>

<template>
  <Teleport to="body">
    <section
      ref="panel"
      class="profile-card"
      :class="{ positioned }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="dialog"
      :aria-label="`${profile?.displayName ?? '用户'}的个人信息卡片`"
      @keydown="handleKeyDown"
    >
      <header class="profile-card-header">
        <UserAvatar :name="profile?.displayName ?? '用户'" :size="44" :user="member ?? undefined" />
        <div class="profile-card-id">
          <strong>{{ profile?.displayName ?? '用户' }}</strong>
          <small>@{{ profile?.username ?? '—' }}</small>
        </div>
        <div class="profile-card-flags">
          <span v-if="isSelf" class="profile-card-self">你</span>
          <Crown v-else-if="member?.role === 'owner'" :size="15" class="guild-role" aria-label="服务器所有者" />
          <ShieldCheck v-else-if="member?.role === 'admin'" :size="15" class="channel-role" aria-label="服务器管理员" />
        </div>
      </header>

      <div v-if="loading" class="profile-card-status">正在加载…</div>
      <div v-else-if="failed || !profile" class="profile-card-status">无法查看该用户的资料</div>
      <template v-else>
        <section class="profile-card-block">
          <h4>个人简介</h4>
          <p v-if="profile.bio" class="profile-card-bio">{{ profile.bio }}</p>
          <p v-else class="profile-card-empty">未填写简介</p>
        </section>
        <section class="profile-card-block">
          <h4>平台信息</h4>
          <dl class="profile-card-facts">
            <div><dt>在线时长</dt><dd>{{ formatDuration(profile.onlineSecondsTotal) }}</dd></div>
            <div><dt>账号创建</dt><dd>{{ formatDate(profile.createdAt) }}</dd></div>
          </dl>
        </section>
        <section v-if="member" class="profile-card-block">
          <h4>服务器权限信息</h4>
          <dl class="profile-card-facts">
            <div><dt>角色</dt><dd>{{ roleLabel(member.role) }}</dd></div>
            <div><dt>入服时间</dt><dd>{{ formatDate(member.createdAt) }}</dd></div>
          </dl>
          <div class="profile-card-badges">
            <span v-if="member.voiceMuted" class="profile-card-pill danger"><MicOff :size="13" />语音禁言</span>
            <span v-if="member.textMuted" class="profile-card-pill danger"><MessageSquareOff :size="13" />文字禁言</span>
            <span v-if="member.permanentlyBanned" class="profile-card-pill danger"><Ban :size="13" />永久封禁</span>
            <span v-else-if="member.temporaryBanUntil" class="profile-card-pill danger"><Ban :size="13" />临时封禁 · {{ remainingBan(member) }}</span>
          </div>
        </section>
        <section v-else class="profile-card-block">
          <h4>服务器权限信息</h4>
          <p class="profile-card-empty">不在当前服务器或已离服</p>
        </section>
      </template>
    </section>
  </Teleport>
</template>