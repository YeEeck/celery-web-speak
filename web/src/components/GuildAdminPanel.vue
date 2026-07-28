<script setup lang="ts">
import { computed, nextTick, provide, ref } from 'vue'
import { Gauge, Settings, UserCog, X } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { guildAdminContextKey, type GuildAdminContext } from './guild-admin-context'
import ChannelAdminTab from './ChannelAdminTab.vue'
import GuildSettingsTab from './GuildSettingsTab.vue'
import MemberAdminTab from './MemberAdminTab.vue'

const props = defineProps<{
  initialTab?: 'guild' | 'channel' | 'users'
  initialChannelId?: number | null
}>()
defineEmits<{ close: [] }>()
const app = useAppStore()
const canSeeGuildTab = computed(() => app.isPlatformAdmin || app.activeGuild?.role === 'owner')
const defaultTab = canSeeGuildTab.value ? 'guild' : 'channel'
const tab = ref<'guild' | 'channel' | 'users'>(props.initialTab ?? defaultTab)
const busy = ref(false)
const adminContent = ref<HTMLElement | null>(null)

const guildContext = computed(() => app.activeGuild)
const adminSubtitle = computed(() => {
  const guildRole = guildContext.value?.role === 'owner' ? '服务器所有者' : '服务器管理员'
  return app.isPlatformAdmin ? `${guildRole} · 平台管理员` : guildRole
})

provide<GuildAdminContext>(guildAdminContextKey, { busy })

function selectTab(nextTab: 'guild' | 'channel' | 'users') {
  if (tab.value === nextTab) return
  tab.value = nextTab
  nextTick(() => adminContent.value?.scrollTo({ top: 0 }))
}
</script>

<template>
  <div class="modal-backdrop admin-backdrop" @mousedown.self="$emit('close')">
    <section class="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <header class="panel-header">
        <div><h2 id="admin-title">服务器管理</h2><p>{{ adminSubtitle }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="admin-tabs">
        <button v-if="canSeeGuildTab" :class="{ active: tab === 'guild' }" @click="selectTab('guild')"><Settings :size="17" />服务器</button>
        <button :class="{ active: tab === 'channel' }" @click="selectTab('channel')"><Gauge :size="17" />频道</button>
        <button :class="{ active: tab === 'users' }" @click="selectTab('users')"><UserCog :size="17" />成员</button>
      </nav>

      <div ref="adminContent" :class="['admin-content', { contained: tab !== 'guild' }]">
        <GuildSettingsTab v-if="tab === 'guild'" />
        <ChannelAdminTab v-else-if="tab === 'channel'" :initial-channel-id="initialChannelId" />
        <MemberAdminTab v-else />
      </div>
    </section>
  </div>
</template>
