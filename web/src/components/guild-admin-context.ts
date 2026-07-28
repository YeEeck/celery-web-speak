import type { InjectionKey, Ref } from 'vue'

export interface GuildAdminContext {
  busy: Ref<boolean>
}

export const guildAdminContextKey = Symbol('guildAdminContext') as InjectionKey<GuildAdminContext>
