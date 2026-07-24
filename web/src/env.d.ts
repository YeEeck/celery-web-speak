/// <reference types="vite/client" />

import type { DesktopApplicationAudioBridge } from './audio/applicationAudioBridge'

declare global {
  interface Window {
    desktopApplicationAudio?: DesktopApplicationAudioBridge
    /** Injected by the Android shell via addJavascriptInterface so the web app can report itself as android. */
    celeryShell?: { platform: () => string; version: () => string }
  }
}
