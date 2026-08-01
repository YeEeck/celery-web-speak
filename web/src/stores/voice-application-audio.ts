import { computed, ref } from 'vue'
import type { LocalAudioTrack, LocalTrackPublication, Room } from 'livekit-client'
import { Track } from 'livekit-client'
import { ApplicationAudioPipeline } from '../audio/ApplicationAudioPipeline'
import {
  connectApplicationAudioBridge,
  isApplicationAudioSnapshot,
  onApplicationAudioPcmPort,
  type ApplicationAudioSnapshot,
  type ApplicationAudioState,
  type DesktopApplicationAudioBridge,
} from '../audio/applicationAudioBridge'
import {
  APPLICATION_AUDIO_PORT_TIMEOUT_MS,
  APPLICATION_AUDIO_VOLUME_KEY,
  applicationAudioErrorMessage,
  applicationAudioSnapshotError,
  clampApplicationAudioVolume,
  getSavedApplicationAudioVolume,
  isSourcePickerCancellation,
} from './voice-utils'

export interface ConnectedPublishSettings {
  audioBitrateKbps: number
  backgroundAudioBitrateKbps: number
  audioRedEnabled: boolean
  backgroundAudioRedEnabled: boolean
}

export interface ApplicationAudioContext {
  room: () => Room | null
  voiceSession: () => number
  deafened: () => boolean
  status: () => string
  connectedPublishSettings: () => ConnectedPublishSettings
  syncParticipants: () => void
  muted: () => boolean
}

export function useApplicationAudio(ctx: ApplicationAudioContext) {
  const applicationAudioSupported = ref(false)
  const applicationAudioState = ref<ApplicationAudioState | 'unsupported'>('unsupported')
  const applicationAudioError = ref('')
  const applicationAudioVolume = ref(getSavedApplicationAudioVolume())
  const applicationAudioOperating = ref(false)
  const applicationAudioSessionId = ref<string | null>(null)
  let applicationAudioBridge: DesktopApplicationAudioBridge | null = null
  let applicationAudioRevision = -1
  let applicationAudioGeneration = 0
  let applicationAudioPipeline: ApplicationAudioPipeline | null = null
  let applicationAudioTrack: LocalAudioTrack | null = null
  let applicationAudioPublication: LocalTrackPublication | null = null
  let applicationAudioAutoPaused = false
  let applicationAudioInitialized = false
  let removeApplicationAudioSnapshotListener: (() => void) | null = null
  let removeApplicationAudioPcmListener: (() => void) | null = null
  let pendingApplicationAudioPort: { sessionId: string; port: MessagePort } | null = null
  let pendingApplicationAudioPortWaiter: {
    sessionId: string
    resolve: (port: MessagePort) => void
    reject: (error: Error) => void
    timer: number
  } | null = null

  const applicationAudioActive = computed(() => applicationAudioSessionId.value !== null && ['playing', 'paused'].includes(applicationAudioState.value))
  const applicationAudioPlaying = computed(() => applicationAudioState.value === 'playing')
  const applicationAudioChanging = computed(() => applicationAudioOperating.value || ['selecting', 'starting', 'stopping'].includes(applicationAudioState.value))

  async function initializeApplicationAudio() {
    if (applicationAudioInitialized) return
    applicationAudioInitialized = true
    const connected = await connectApplicationAudioBridge()
    if (!connected) return
    applicationAudioBridge = connected.bridge
    removeApplicationAudioSnapshotListener = connected.bridge.onSnapshot((snapshot) => {
      if (isApplicationAudioSnapshot(snapshot)) applyApplicationAudioSnapshot(snapshot)
    })
    removeApplicationAudioPcmListener = onApplicationAudioPcmPort(handleApplicationAudioPcmPort)
    applicationAudioSupported.value = connected.snapshot.supported
    applicationAudioState.value = connected.snapshot.supported ? 'idle' : 'unsupported'
    applicationAudioRevision = connected.snapshot.revision
    const latest = await connected.bridge.getSnapshot().catch(() => null)
    if (!latest || !isApplicationAudioSnapshot(latest) || !latest.supported) {
      disableApplicationAudio()
      return
    }
    if (latest.sessionId) {
      await connected.bridge.stop(latest.sessionId).catch(() => undefined)
      applicationAudioState.value = 'idle'
      applicationAudioSessionId.value = null
    } else {
      applyApplicationAudioSnapshot(latest)
    }
    window.addEventListener('pagehide', handleApplicationAudioPageHide)
  }

  async function startApplicationAudio() {
    if (!applicationAudioInitialized) await initializeApplicationAudio()
    if (!applicationAudioBridge || !applicationAudioSupported.value || applicationAudioOperating.value) return false
    const room = ctx.room()
    if (!room || ctx.status() !== 'connected' || ctx.muted() || ctx.deafened()) {
      applicationAudioError.value = '请先连接语音频道并取消耳机静音'
      return false
    }
    if (applicationAudioSessionId.value) return true
    const target = room
    const session = ctx.voiceSession()
    const generation = ++applicationAudioGeneration
    let startedSessionId: string | null = null
    applicationAudioOperating.value = true
    applicationAudioState.value = 'selecting'
    applicationAudioError.value = ''
    const pipeline = new ApplicationAudioPipeline()
    applicationAudioPipeline = pipeline
    try {
      const mediaTrack = await pipeline.initialize(applicationAudioVolume.value)
      if (generation !== applicationAudioGeneration) throw new Error('背景音启动已取消')
      const snapshot = await applicationAudioBridge.start()
      if (!isApplicationAudioSnapshot(snapshot)) throw new Error('桌面客户端返回了无效的背景音状态')
      startedSessionId = snapshot.sessionId
      if (generation !== applicationAudioGeneration || ctx.muted()) throw new Error('背景音启动已取消')
      applyApplicationAudioSnapshot(snapshot)
      if (isSourcePickerCancellation(snapshot)) {
        await cleanupApplicationAudioMedia(target)
        applicationAudioState.value = 'idle'
        return false
      }
      const sessionId = snapshot.sessionId ?? applicationAudioSessionId.value
      if (!sessionId || !['starting', 'playing', 'paused'].includes(snapshot.state)) {
        throw applicationAudioSnapshotError(snapshot, '无法启动应用背景音')
      }
      applicationAudioSessionId.value = sessionId
      applicationAudioState.value = snapshot.state
      const port = await waitForApplicationAudioPort(sessionId)
      if (generation !== applicationAudioGeneration) {
        port.close()
        throw new Error('背景音启动已取消')
      }
      if (!pipeline.attachPort(sessionId, port)) throw new Error('背景音 PCM 端口无效')
      if (ctx.room() !== target || session !== ctx.voiceSession() || ctx.muted()) throw new Error('语音频道已切换')
      const publication = await target.localParticipant.publishTrack(mediaTrack, applicationAudioPublishOptions())
      if (ctx.room() !== target || session !== ctx.voiceSession() || applicationAudioSessionId.value !== sessionId) {
        await target.localParticipant.unpublishTrack(publication.track!, false).catch(() => undefined)
        throw new Error('背景音会话已经失效')
      }
      applicationAudioPublication = publication
      applicationAudioTrack = publication.audioTrack ?? null
      if (snapshot.state === 'paused') await publication.mute()
      ctx.syncParticipants()
      return true
    } catch (error) {
      if (!applicationAudioError.value) applicationAudioError.value = applicationAudioErrorMessage(error)
      const sessionId = startedSessionId ?? applicationAudioSessionId.value
      if (sessionId) await applicationAudioBridge.stop(sessionId).catch(() => undefined)
      await cleanupApplicationAudioMedia(target)
      applicationAudioState.value = 'idle'
      return false
    } finally {
      applicationAudioOperating.value = false
    }
  }

  async function pauseApplicationAudio(autoPaused = false) {
    if (!applicationAudioBridge || !applicationAudioSessionId.value || applicationAudioState.value !== 'playing') return false
    if (applicationAudioOperating.value) return false
    applicationAudioOperating.value = true
    applicationAudioError.value = ''
    const sessionId = applicationAudioSessionId.value
    const generation = applicationAudioGeneration
    try {
      const snapshot = await applicationAudioBridge.pause(sessionId)
      if (!isApplicationAudioSnapshot(snapshot)) throw new Error('桌面客户端返回了无效的背景音状态')
      if (applicationAudioSessionId.value !== sessionId || generation !== applicationAudioGeneration) return false
      applyApplicationAudioSnapshot(snapshot)
      await applicationAudioPublication?.mute()
      applicationAudioPipeline?.reset(sessionId)
      applicationAudioState.value = 'paused'
      applicationAudioAutoPaused = autoPaused
      ctx.syncParticipants()
      return true
    } catch (error) {
      applicationAudioError.value = applicationAudioErrorMessage(error)
      if (autoPaused) await stopApplicationAudio()
      return false
    } finally {
      applicationAudioOperating.value = false
    }
  }

  async function resumeApplicationAudio(autoResume = false) {
    if (!applicationAudioBridge || !applicationAudioSessionId.value || applicationAudioState.value !== 'paused') return false
    if (applicationAudioOperating.value) return false
    applicationAudioOperating.value = true
    applicationAudioError.value = ''
    const sessionId = applicationAudioSessionId.value
    const generation = applicationAudioGeneration
    try {
      const snapshot = await applicationAudioBridge.resume(sessionId)
      if (!isApplicationAudioSnapshot(snapshot)) throw new Error('桌面客户端返回了无效的背景音状态')
      if (applicationAudioSessionId.value !== sessionId || generation !== applicationAudioGeneration) return false
      applyApplicationAudioSnapshot(snapshot)
      await applicationAudioPublication?.unmute()
      applicationAudioState.value = 'playing'
      applicationAudioAutoPaused = false
      ctx.syncParticipants()
      return true
    } catch (error) {
      applicationAudioError.value = applicationAudioErrorMessage(error)
      if (autoResume) applicationAudioAutoPaused = false
      return false
    } finally {
      applicationAudioOperating.value = false
    }
  }

  async function stopApplicationAudio() {
    applicationAudioGeneration += 1
    const bridge = applicationAudioBridge
    const sessionId = applicationAudioSessionId.value
    if (!sessionId && !applicationAudioPipeline && !applicationAudioTrack) return
    applicationAudioState.value = 'stopping'
    applicationAudioAutoPaused = false
    const target = ctx.room()
    await cleanupApplicationAudioMedia(target)
    if (bridge && sessionId) await bridge.stop(sessionId).catch(() => undefined)
    applicationAudioState.value = applicationAudioSupported.value ? 'idle' : 'unsupported'
    ctx.syncParticipants()
  }

  function setApplicationAudioVolume(value: number) {
    const normalized = clampApplicationAudioVolume(value)
    applicationAudioVolume.value = normalized
    localStorage.setItem(APPLICATION_AUDIO_VOLUME_KEY, String(normalized))
    applicationAudioPipeline?.setVolume(normalized)
  }

  async function republishBackgroundAudio() {
    const room = ctx.room()
    if (!room || !applicationAudioTrack) return
    const target = room
    const track = applicationAudioTrack
    const generation = applicationAudioGeneration
    const wasPaused = applicationAudioState.value === 'paused'
    try {
      await target.localParticipant.unpublishTrack(track, false)
      if (generation !== applicationAudioGeneration || ctx.room() !== target) return
      const publication = await target.localParticipant.publishTrack(track, applicationAudioPublishOptions())
      if (generation !== applicationAudioGeneration || ctx.room() !== target) {
        await target.localParticipant.unpublishTrack(publication.track!, false).catch(() => undefined)
        return
      }
      applicationAudioPublication = publication
      applicationAudioTrack = publication.audioTrack ?? null
      if (wasPaused) await applicationAudioTrack?.mute()
    } catch (error) {
      applicationAudioError.value = applicationAudioErrorMessage(error)
      await stopApplicationAudio()
    }
  }

  function isAutoPaused() {
    return applicationAudioAutoPaused
  }

  function hasActiveTrack() {
    return applicationAudioTrack !== null
  }

  function applyApplicationAudioSnapshot(snapshot: ApplicationAudioSnapshot) {
    if (snapshot.revision < applicationAudioRevision) return
    if (applicationAudioSessionId.value && snapshot.sessionId && snapshot.sessionId !== applicationAudioSessionId.value) return
    if (!applicationAudioSessionId.value && snapshot.sessionId && !['selecting', 'starting'].includes(applicationAudioState.value)) return
    applicationAudioRevision = snapshot.revision
    if (!snapshot.supported) {
      disableApplicationAudio()
      return
    }
    applicationAudioSupported.value = true
    if (snapshot.sessionId) applicationAudioSessionId.value = snapshot.sessionId
    applicationAudioState.value = snapshot.state
    if (snapshot.error && snapshot.error.code !== 'source_picker_cancelled') {
      applicationAudioError.value = applicationAudioErrorMessage(snapshot.error)
    }
    if (snapshot.state === 'playing') void synchronizeApplicationAudioPublication(false)
    if (snapshot.state === 'paused') void synchronizeApplicationAudioPublication(true)
    if (snapshot.state === 'error' || (snapshot.state === 'idle' && applicationAudioSessionId.value)) {
      void cleanupApplicationAudioMedia(ctx.room())
      applicationAudioState.value = 'idle'
    }
  }

  function handleApplicationAudioPcmPort(event: { sessionId: string; port: MessagePort }) {
    if (pendingApplicationAudioPortWaiter?.sessionId === event.sessionId) {
      const waiter = pendingApplicationAudioPortWaiter
      pendingApplicationAudioPortWaiter = null
      window.clearTimeout(waiter.timer)
      waiter.resolve(event.port)
      return
    }
    if (applicationAudioPipeline?.hasAttachedPort(event.sessionId)) {
      event.port.close()
      return
    }
    if ((!applicationAudioSessionId.value && ['selecting', 'starting'].includes(applicationAudioState.value)) || applicationAudioSessionId.value === event.sessionId) {
      pendingApplicationAudioPort?.port.close()
      pendingApplicationAudioPort = event
      return
    }
    event.port.close()
  }

  function waitForApplicationAudioPort(sessionId: string) {
    if (pendingApplicationAudioPort?.sessionId === sessionId) {
      const port = pendingApplicationAudioPort.port
      pendingApplicationAudioPort = null
      return Promise.resolve(port)
    }
    pendingApplicationAudioPort?.port.close()
    pendingApplicationAudioPort = null
    return new Promise<MessagePort>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (pendingApplicationAudioPortWaiter?.sessionId === sessionId) pendingApplicationAudioPortWaiter = null
        reject(new Error('等待背景音 PCM 端口超时'))
      }, APPLICATION_AUDIO_PORT_TIMEOUT_MS)
      pendingApplicationAudioPortWaiter = { sessionId, resolve, reject, timer }
    })
  }

  async function cleanupApplicationAudioMedia(target: Room | null) {
    rejectPendingApplicationAudioPort()
    pendingApplicationAudioPort?.port.close()
    pendingApplicationAudioPort = null
    const publication = applicationAudioPublication
    applicationAudioPublication = null
    applicationAudioTrack = null
    if (target && publication?.track) {
      await target.localParticipant.unpublishTrack(publication.track, false).catch(() => undefined)
    }
    const pipeline = applicationAudioPipeline
    applicationAudioPipeline = null
    await pipeline?.destroy()
    applicationAudioSessionId.value = null
    applicationAudioAutoPaused = false
  }

  async function synchronizeApplicationAudioPublication(muted: boolean) {
    const publication = applicationAudioPublication
    if (!publication || publication.isMuted === muted) return
    try {
      if (muted) await publication.mute()
      else await publication.unmute()
      ctx.syncParticipants()
    } catch {
      applicationAudioError.value = '无法同步背景音播放状态'
    }
  }

  function rejectPendingApplicationAudioPort() {
    const waiter = pendingApplicationAudioPortWaiter
    if (!waiter) return
    pendingApplicationAudioPortWaiter = null
    window.clearTimeout(waiter.timer)
    waiter.reject(new Error('背景音会话已经停止'))
  }

  function disableApplicationAudio() {
    applicationAudioSupported.value = false
    applicationAudioState.value = 'unsupported'
    removeApplicationAudioSnapshotListener?.()
    removeApplicationAudioPcmListener?.()
    removeApplicationAudioSnapshotListener = null
    removeApplicationAudioPcmListener = null
    applicationAudioBridge = null
    window.removeEventListener('pagehide', handleApplicationAudioPageHide)
    void cleanupApplicationAudioMedia(ctx.room())
  }

  function handleApplicationAudioPageHide() {
    const bridge = applicationAudioBridge
    const sessionId = applicationAudioSessionId.value
    if (bridge && sessionId) void bridge.stop(sessionId)
  }

  function applicationAudioPublishOptions() {
    const settings = ctx.connectedPublishSettings()
    return {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: settings.backgroundAudioBitrateKbps * 1000 },
      dtx: false,
      red: settings.backgroundAudioRedEnabled,
      forceStereo: true,
    }
  }

  return {
    applicationAudioSupported,
    applicationAudioState,
    applicationAudioError,
    applicationAudioVolume,
    applicationAudioOperating,
    applicationAudioSessionId,
    applicationAudioActive,
    applicationAudioPlaying,
    applicationAudioChanging,
    initializeApplicationAudio,
    startApplicationAudio,
    pauseApplicationAudio,
    resumeApplicationAudio,
    stopApplicationAudio,
    setApplicationAudioVolume,
    republishBackgroundAudio,
    isAutoPaused,
    hasActiveTrack,
  }
}
