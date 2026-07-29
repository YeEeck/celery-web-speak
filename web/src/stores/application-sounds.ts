import { onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import {
  createApplicationSounds,
  type ApplicationSoundOccurrence,
  type ApplicationSoundPlaybackContext,
  type CustomSoundPresentation,
  type MasterSoundControl,
  type OperationSoundControl,
  type SoundChangeResult,
  type SoundChoice,
  type SoundIssue,
} from '../application-sounds/core'
import {
  BrowserSoundPreferenceAdapter,
  IndexedDBCustomSoundStorageAdapter,
} from '../application-sounds/storage'
import { BrowserApplicationSoundAudioAdapter } from '../application-sounds/web-audio'

export type {
  ApplicationSoundOccurrence,
  ApplicationSoundPlaybackContext,
  CustomSoundPresentation,
  MasterSoundControl,
  OperationSoundControl,
  SoundChangeResult,
  SoundChoice,
  SoundIssue,
}
export type { OperationSoundEvent } from '../application-sounds/patterns'

export const useApplicationSoundStore = defineStore('applicationSounds', () => {
  const diagnose = (message: string, error?: unknown) => console.warn(message, error)
  const audio = new BrowserApplicationSoundAudioAdapter({
    createContext: createAudioContext,
    interactionTarget: document,
    diagnose,
  })
  const runtime = createApplicationSounds({
    preferences: new BrowserSoundPreferenceAdapter(localStorage),
    customSounds: new IndexedDBCustomSoundStorageAdapter(indexedDB),
    audio,
    monotonicNow: () => performance.now(),
    timestamp: () => Date.now(),
    diagnose,
  })

  onScopeDispose(() => void runtime.dispose())

  return {
    settings: runtime.settings,
    mutedSpeakingReminderAudible: runtime.mutedSpeakingReminderAudible,
    signal: (occurrence: ApplicationSoundOccurrence) => runtime.signal(occurrence),
    followPlayback: (context: ApplicationSoundPlaybackContext) => runtime.followPlayback(context),
  }
})

function createAudioContext() {
  const AudioContextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) throw new Error('当前浏览器不支持应用提示音')
  return new AudioContextConstructor()
}
