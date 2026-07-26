import type { InjectionKey, Ref } from 'vue'

export interface GuildAdminContext {
  busy: Ref<boolean>
  run: (action: () => Promise<void>, success: string) => Promise<void>
}

export const guildAdminContextKey = Symbol('guildAdminContext') as InjectionKey<GuildAdminContext>
