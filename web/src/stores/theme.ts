import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'system' | 'light' | 'dark'
export type AccentPreset = 'indigo' | 'green' | 'rose' | 'amber'

const MODE_KEY = 'cws.theme.mode'
const ACCENT_KEY = 'cws.theme.accent'
const DEFAULT_MODE: ThemeMode = 'system'
const DEFAULT_ACCENT: AccentPreset = 'indigo'

const mediaQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(getSavedMode())
  const accent = ref<AccentPreset>(getSavedAccent())
  let mediaListener: ((event: MediaQueryListEvent) => void) | null = null

  function resolveMode(target: ThemeMode): 'light' | 'dark' {
    if (target === 'system') return mediaQuery?.matches ? 'light' : 'dark'
    return target
  }

  function apply() {
    const resolved = resolveMode(mode.value)
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.setAttribute('data-accent', accent.value)
  }

  function watchMedia() {
    if (mediaListener || !mediaQuery) return
    mediaListener = () => {
      if (mode.value === 'system') apply()
    }
    mediaQuery.addEventListener('change', mediaListener)
  }

  function unwatchMedia() {
    if (mediaListener && mediaQuery) mediaQuery.removeEventListener('change', mediaListener)
    mediaListener = null
  }

  function initialize() {
    apply()
    watchMedia()
  }

  function setMode(next: ThemeMode) {
    mode.value = next
    localStorage.setItem(MODE_KEY, next)
    apply()
  }

  function setAccent(next: AccentPreset) {
    accent.value = next
    localStorage.setItem(ACCENT_KEY, next)
    apply()
  }

  return { mode, accent, initialize, setMode, setAccent }
})

function getSavedMode(): ThemeMode {
  const saved = localStorage.getItem(MODE_KEY)
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return DEFAULT_MODE
}

function getSavedAccent(): AccentPreset {
  const saved = localStorage.getItem(ACCENT_KEY)
  if (saved === 'indigo' || saved === 'green' || saved === 'rose' || saved === 'amber') return saved
  return DEFAULT_ACCENT
}
