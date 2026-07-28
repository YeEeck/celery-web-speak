import { onBeforeUnmount, onMounted } from 'vue'
import { useVoiceStore } from './voice'

/**
 * 全局语音快捷键：Ctrl+Shift+M 切换麦克风静音，Ctrl+Shift+D 切换耳机静音。
 * Meta（⌘）等价于 Ctrl；已登录主界面内任何焦点位置均生效，
 * 模态弹窗（aria-modal）打开期间不拦截。
 * 参见 docs/adr/0004-voice-shortcuts-fire-during-text-input.md
 */
export function useVoiceShortcuts() {
  const voice = useVoiceStore()

  function handleKeyDown(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.repeat) return
    const target = event.target as Element | null
    if (target?.closest('[aria-modal="true"]')) return
    if (event.code === 'KeyM') {
      event.preventDefault()
      void voice.toggleMute()
    } else if (event.code === 'KeyD') {
      event.preventDefault()
      void voice.toggleDeafen()
    }
  }

  onMounted(() => document.addEventListener('keydown', handleKeyDown))
  onBeforeUnmount(() => document.removeEventListener('keydown', handleKeyDown))
}
