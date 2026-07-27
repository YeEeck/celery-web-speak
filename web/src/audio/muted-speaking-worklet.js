const SAMPLE_RATE = 16_000
const FRAME_DURATION_MS = 20
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_DURATION_MS / 1_000

class MutedSpeakingPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.transport = null
    this.frame = new Int16Array(FRAME_SAMPLES)
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'connect' || !(event.data.port instanceof MessagePort)) return
      this.transport?.close()
      this.transport = event.data.port
      this.transport.start()
    }
  }

  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0)
    }

    const input = inputs[0]?.[0]
    if (!input || !this.transport) return true

    for (const value of input) {
      const clamped = Math.max(-1, Math.min(1, value))
      this.frame[this.offset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.offset += 1
      if (this.offset !== FRAME_SAMPLES) continue

      const completed = this.frame
      this.frame = new Int16Array(FRAME_SAMPLES)
      this.offset = 0
      this.transport.postMessage(completed, [completed.buffer])
    }
    return true
  }
}

registerProcessor('muted-speaking-pcm', MutedSpeakingPcmProcessor)
