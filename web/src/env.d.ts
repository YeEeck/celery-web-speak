/// <reference types="vite/client" />

import type { DesktopApplicationAudioBridge } from './audio/applicationAudioBridge'
import type { DesktopVoiceOverlayBridge } from './audio/voiceOverlayBridge'

declare global {
  interface Window {
    desktopApplicationAudio?: DesktopApplicationAudioBridge
    desktopVoiceOverlay?: DesktopVoiceOverlayBridge
    /** Injected by the Android shell via addJavascriptInterface so the web app can report itself as android. */
    celeryShell?: { platform: () => string; version: () => string }
  }
}
