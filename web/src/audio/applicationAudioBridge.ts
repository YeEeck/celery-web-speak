export const APPLICATION_AUDIO_PROTOCOL = 1

const REQUIRED_CAPABILITIES = [
  'application_audio_capture',
  'application_audio_source_picker',
  'application_audio_pcm_port',
] as const

export type ApplicationAudioState = 'idle' | 'selecting' | 'starting' | 'playing' | 'paused' | 'stopping' | 'error'

export type ApplicationAudioErrorCode =
  | 'unsupported_platform'
  | 'unsupported_windows_version'
  | 'process_loopback_unavailable'
  | 'source_picker_cancelled'
  | 'source_unavailable'
  | 'source_process_exited'
  | 'capture_start_failed'
  | 'capture_stream_failed'
  | 'bridge_incompatible'
  | 'voice_not_connected'
  | 'voice_publish_forbidden'
  | 'livekit_publish_failed'
  | 'capture_worker_exited'

export interface ApplicationAudioError {
  code: ApplicationAudioErrorCode
  message: string
}

export interface ApplicationAudioSnapshot {
  sessionId: string | null
  revision: number
  state: ApplicationAudioState
  supported: boolean
  error: ApplicationAudioError | null
}

export interface ApplicationAudioPcmPortEvent {
  sessionId: string
  port: MessagePort
}

export interface DesktopApplicationAudioBridge {
  hello(input: { minProtocol: number; maxProtocol: number }): Promise<{ protocol: number; capabilities: string[] }>
  getSnapshot(): Promise<ApplicationAudioSnapshot>
  start(): Promise<ApplicationAudioSnapshot>
  pause(sessionId: string): Promise<ApplicationAudioSnapshot>
  resume(sessionId: string): Promise<ApplicationAudioSnapshot>
  stop(sessionId: string): Promise<ApplicationAudioSnapshot>
  onSnapshot(listener: (snapshot: ApplicationAudioSnapshot) => void): () => void
}

export async function connectApplicationAudioBridge(): Promise<{
  bridge: DesktopApplicationAudioBridge
  snapshot: ApplicationAudioSnapshot
} | null> {
  const bridge = window.desktopApplicationAudio
  if (!isBridge(bridge)) return null
  try {
    const result = await bridge.hello({
      minProtocol: APPLICATION_AUDIO_PROTOCOL,
      maxProtocol: APPLICATION_AUDIO_PROTOCOL,
    })
    if (result.protocol !== APPLICATION_AUDIO_PROTOCOL) return null
    if (!REQUIRED_CAPABILITIES.every((capability) => result.capabilities.includes(capability))) return null
    const snapshot = await bridge.getSnapshot()
    return isSnapshot(snapshot) && snapshot.supported ? { bridge, snapshot } : null
  } catch {
    return null
  }
}

export function isApplicationAudioSnapshot(value: unknown): value is ApplicationAudioSnapshot {
  return isSnapshot(value)
}

export function onApplicationAudioPcmPort(
  listener: (event: ApplicationAudioPcmPortEvent) => void,
) {
  const handleMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin || event.ports.length !== 1) return
    if (!isRecord(event.data)) return
    if (event.data.type !== 'celery:application-audio:pcm-port') return
    if (event.data.protocol !== APPLICATION_AUDIO_PROTOCOL || typeof event.data.sessionId !== 'string' || !event.data.sessionId) {
      event.ports[0].close()
      return
    }
    listener({ sessionId: event.data.sessionId, port: event.ports[0] })
  }
  window.addEventListener('message', handleMessage)
  return () => window.removeEventListener('message', handleMessage)
}

function isBridge(value: unknown): value is DesktopApplicationAudioBridge {
  if (!isRecord(value)) return false
  return ['hello', 'getSnapshot', 'start', 'pause', 'resume', 'stop', 'onSnapshot']
    .every((method) => typeof value[method] === 'function')
}

function isSnapshot(value: unknown): value is ApplicationAudioSnapshot {
  if (!isRecord(value)) return false
  if (value.sessionId !== null && typeof value.sessionId !== 'string') return false
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false
  if (!['idle', 'selecting', 'starting', 'playing', 'paused', 'stopping', 'error'].includes(String(value.state))) return false
  if (typeof value.supported !== 'boolean') return false
  return value.error === null || isApplicationAudioError(value.error)
}

function isApplicationAudioError(value: unknown): value is ApplicationAudioError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
