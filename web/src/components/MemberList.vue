<script setup lang="ts">
import { computed } from 'vue'
import { Crown, ShieldCheck, X } from '@lucide/vue'
import UserAvatar from './UserAvatar.vue'
import { useAppStore } from '../stores/app'

defineProps<{ drawer?: boolean }>()
defineEmits<{ close: [] }>()
const app = useAppStore()

const online = computed(() => sortedUsers.value.filter((user) => app.onlineIds.includes(user.id)))
const offline = computed(() => sortedUsers.value.filter((user) => !app.onlineIds.includes(user.id)))
const sortedUsers = computed(() => [...app.users].sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.displayName.localeCompare(b.displayName, 'zh-CN')))

function roleRank(role: string) {
  if (role === 'server_admin') return 2
  if (role === 'channel_admin') return 1
  return 0
}
</script>

<template>
  <aside :class="['member-list', { drawer }]">
    <header v-if="drawer" class="drawer-header"><strong>成员</strong><button class="icon-button" title="关闭" @click="$emit('close')"><X :size="20" /></button></header>
    <section>
      <h3>在线 — {{ online.length }}</h3>
      <div v-for="member in online" :key="member.id" class="member-row">
        <UserAvatar :name="member.displayName" :size="34" :online="true" />
        <span><strong>{{ member.displayName }}</strong><small>@{{ member.username }}</small></span>
        <Crown v-if="member.role === 'server_admin'" :size="15" class="server-role" aria-label="服务器所有者" />
        <ShieldCheck v-else-if="member.role === 'channel_admin'" :size="15" class="channel-role" aria-label="服务器管理员" />
      </div>
    </section>
    <section v-if="offline.length">
      <h3>离线 — {{ offline.length }}</h3>
      <div v-for="member in offline" :key="member.id" class="member-row offline">
        <UserAvatar :name="member.displayName" :size="34" />
        <span><strong>{{ member.displayName }}</strong><small>@{{ member.username }}</small></span>
        <Crown v-if="member.role === 'server_admin'" :size="15" class="server-role" aria-label="服务器所有者" />
        <ShieldCheck v-else-if="member.role === 'channel_admin'" :size="15" class="channel-role" aria-label="服务器管理员" />
      </div>
    </section>
  </aside>
</template>
