import { WebrtcVad } from 'auditok-webrtcvad'
import { MutedSpeakingReminderState } from './MutedSpeakingReminderState'

const SAMPLE_RATE = 16_000
const FRAME_DURATION_MS = 20
const VAD_MODE_VERY_AGGRESSIVE = 3

type MainMessage = { type: 'connect'; port: MessagePort }
type WorkerMessage = { type: 'ready' } | { type: 'reminder' } | { type: 'error'; message: string }

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<MainMessage>) => void): void
  postMessage(message: WorkerMessage): void
}

const scope = globalThis as unknown as WorkerScope
let vad: WebrtcVad | null = null
let transport: MessagePort | null = null

scope.addEventListener('message', (event) => {
  if (event.data.type !== 'connect') return
  void connect(event.data.port)
})

async function connect(port: MessagePort) {
  try {
    transport?.close()
    vad?.destroy()
    transport = port
    vad = await WebrtcVad.create(VAD_MODE_VERY_AGGRESSIVE, SAMPLE_RATE)
    const state = new MutedSpeakingReminderState()
    transport.onmessage = (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof Int16Array) || !vad) return
      try {
        if (state.process(vad.isSpeech(event.data), FRAME_DURATION_MS)) {
          scope.postMessage({ type: 'reminder' })
        }
      } catch (error) {
        reportError(error)
      }
    }
    transport.start()
    scope.postMessage({ type: 'ready' })
  } catch (error) {
    reportError(error)
  }
}

function reportError(error: unknown) {
  transport?.close()
  transport = null
  vad?.destroy()
  vad = null
  scope.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : 'WebRTC VAD failed',
  })
}
