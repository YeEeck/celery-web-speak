const SAMPLE_RATE = 16_000

type WorkerMessage = { type: 'ready' } | { type: 'reminder' } | { type: 'error'; message: string }

interface MutedSpeakingReminderCallbacks {
  onReminder: () => void
  onError: (error: Error) => void
}

export class MutedSpeakingReminderMonitor {
  private operation = 0
  private failed = false
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private silence: GainNode | null = null
  private worker: Worker | null = null
  private callbacks: MutedSpeakingReminderCallbacks

  constructor(callbacks: MutedSpeakingReminderCallbacks) {
    this.callbacks = callbacks
  }

  async start(deviceId?: string) {
    this.stop()
    if (this.failed) return false
    const operation = this.operation

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风访问')
      if (!window.AudioWorkletNode) throw new Error('当前浏览器不支持 AudioWorklet')

      const constraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      }
      if (deviceId && deviceId !== 'default') constraints.deviceId = { exact: deviceId }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      if (operation !== this.operation) {
        stopStream(stream)
        return false
      }
      this.stream = stream
      const track = stream.getAudioTracks()[0]
      if (!track) throw new Error('未取得麦克风音轨')
      track.contentHint = 'speech'

      const context = new AudioContext({ sampleRate: SAMPLE_RATE })
      this.context = context
      if (context.sampleRate !== SAMPLE_RATE) throw new Error(`浏览器不支持 ${SAMPLE_RATE} Hz 音频上下文`)
      await context.audioWorklet.addModule(new URL('./muted-speaking-worklet.js', import.meta.url))
      if (operation !== this.operation) return false

      const worker = new Worker(new URL('./muted-speaking-vad-worker.ts', import.meta.url), {
        type: 'module',
        name: 'muted-speaking-vad',
      })
      this.worker = worker
      const channel = new MessageChannel()
      const ready = waitForWorker(worker)
      worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2])
      await ready
      if (operation !== this.operation) return false

      const source = context.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(context, 'muted-speaking-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      const silence = context.createGain()
      silence.gain.value = 0
      worklet.port.postMessage({ type: 'connect', port: channel.port1 }, [channel.port1])
      source.connect(worklet).connect(silence).connect(context.destination)
      this.source = source
      this.worklet = worklet
      this.silence = silence
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.handleWorkerMessage(event.data)
      worker.onerror = (event) => this.fail(new Error(event.message || 'VAD Worker failed'))

      if (context.state !== 'running') await context.resume()
      if (context.state !== 'running') throw new Error('VAD 音频上下文无法启动')
      return true
    } catch (error) {
      if (operation === this.operation) this.fail(asError(error))
      return false
    }
  }

  stop() {
    this.operation += 1
    this.releaseResources()
  }

  resetFailure() {
    this.failed = false
  }

  private handleWorkerMessage(message: WorkerMessage) {
    if (message.type === 'reminder') this.callbacks.onReminder()
    if (message.type === 'error') this.fail(new Error(message.message))
  }

  private fail(error: Error) {
    if (this.failed) return
    this.failed = true
    this.operation += 1
    this.releaseResources()
    this.callbacks.onError(error)
  }

  private releaseResources() {
    this.source?.disconnect()
    this.source = null
    this.worklet?.disconnect()
    this.worklet?.port.close()
    this.worklet = null
    this.silence?.disconnect()
    this.silence = null
    this.worker?.terminate()
    this.worker = null
    stopStream(this.stream)
    this.stream = null
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') void context.close()
  }
}

function waitForWorker(worker: Worker) {
  return new Promise<void>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === 'ready') resolve()
      if (event.data.type === 'error') reject(new Error(event.data.message))
    }
    worker.onerror = (event) => reject(new Error(event.message || 'VAD Worker failed'))
  })
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error('静音说话检测启动失败')
}
