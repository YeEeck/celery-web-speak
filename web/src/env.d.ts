/// <reference types="vite/client" />

import type { DesktopApplicationAudioBridge } from './audio/applicationAudioBridge'

declare global {
  interface Window {
    desktopApplicationAudio?: DesktopApplicationAudioBridge
  }
}
