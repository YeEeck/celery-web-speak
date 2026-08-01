<script setup lang="ts">
import { computed, ref } from 'vue'
import { Crown, Globe, Monitor, ShieldCheck, Smartphone, X } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'
import { useVoiceStore } from '../stores/voice'
import type { ClientType, PresenceStatus, User } from '../types'
import { presenceStatusFor } from '../utils/presence-status'

defineProps<{ drawer?: boolean }>()
const emit = defineEmits<{ close: []; openMember: [user: User, trigger: HTMLElement, x: number, y: number, onClose: () => void] }>()
const app = useAppStore()
const voice = useVoiceStore()
const selectedId = ref<number | null>(null)

const sortedUsers = computed(() => [...app.users].sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.displayName.localeCompare(b.displayName, 'zh-CN')))
const online = computed(() => sortedUsers.value.filter((user) => statusOf(user.id) === 'online'))
const away = computed(() => sortedUsers.value.filter((user) => statusOf(user.id) === 'away'))
const offline = computed(() => sortedUsers.value.filter((user) => statusOf(user.id) === 'offline'))

function statusOf(userId: number): PresenceStatus {
  return presenceStatusFor(userId, app.user?.id ?? null, voice.ownPresenceStatus, app.presenceStatuses)
}

const clientIcons = { web: Globe, electron: Monitor, android: Smartphone }
const clientLabels: Record<ClientType, string> = { web: '网页端', electron: '桌面端', android: '安卓端' }

function roleRank(role: string) {
  if (role === 'owner') return 2
  if (role === 'admin') return 1
  return 0
}

function openMember(event: MouseEvent | KeyboardEvent, member: User) {
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  selectedId.value = member.id
  emit('openMember', member, trigger, ('clientX' in event ? event.clientX : 0) || (bounds.left + 1), ('clientY' in event ? event.clientY : 0) || (bounds.top + 1), () => { selectedId.value = null })
}
</script>

<template>
  <aside :class="['member-list', { drawer }]">
    <header v-if="drawer" class="drawer-header"><strong>成员</strong><button class="icon-button" title="关闭" @click="$emit('close')"><X :size="20" /></button></header>
    <section>
      <h3>在线 — {{ online.length }}</h3>
      <div v-for="member in online" :key="member.id" :class="['member-row', { active: selectedId === member.id }]" tabindex="0" role="button" :aria-label="`查看${member.displayName}的个人信息`" @click="openMember($event, member)" @keydown.enter="openMember($event, member)">
        <UserAvatar :name="member.displayName" :size="34" :status="'online'" :user="member" />
        <span><strong>{{ member.displayName }}</strong><small>@{{ member.username }}</small></span>
        <component :is="clientIcons[app.onlineClients[member.id] ?? 'web']" :size="14" class="client-type" :aria-label="clientLabels[app.onlineClients[member.id] ?? 'web']" />
        <Crown v-if="member.role === 'owner'" :size="15" class="guild-role" aria-label="服务器所有者" />
        <ShieldCheck v-else-if="member.role === 'admin'" :size="15" class="channel-role" aria-label="服务器管理员" />
      </div>
    </section>
    <section v-if="away.length">
      <h3>离开 — {{ away.length }}</h3>
      <div v-for="member in away" :key="member.id" :class="['member-row', { active: selectedId === member.id }]" tabindex="0" role="button" :aria-label="`查看${member.displayName}的个人信息`" @click="openMember($event, member)" @keydown.enter="openMember($event, member)">
        <UserAvatar :name="member.displayName" :size="34" :status="'away'" :user="member" />
        <span><strong>{{ member.displayName }}</strong><small>@{{ member.username }}</small></span>
        <component :is="clientIcons[app.onlineClients[member.id] ?? 'web']" :size="14" class="client-type" :aria-label="clientLabels[app.onlineClients[member.id] ?? 'web']" />
        <Crown v-if="member.role === 'owner'" :size="15" class="guild-role" aria-label="服务器所有者" />
        <ShieldCheck v-else-if="member.role === 'admin'" :size="15" class="channel-role" aria-label="服务器管理员" />
      </div>
    </section>
    <section v-if="offline.length">
      <h3>离线 — {{ offline.length }}</h3>
      <div v-for="member in offline" :key="member.id" :class="['member-row', { active: selectedId === member.id }]" tabindex="0" role="button" :aria-label="`查看${member.displayName}的个人信息`" @click="openMember($event, member)" @keydown.enter="openMember($event, member)">
        <UserAvatar :name="member.displayName" :size="34" :status="'offline'" :user="member" />
        <span><strong>{{ member.displayName }}</strong><small>@{{ member.username }}</small></span>
        <Crown v-if="member.role === 'owner'" :size="15" class="guild-role" aria-label="服务器所有者" />
        <ShieldCheck v-else-if="member.role === 'admin'" :size="15" class="channel-role" aria-label="服务器管理员" />
      </div>
    </section>
  </aside>
</template>
