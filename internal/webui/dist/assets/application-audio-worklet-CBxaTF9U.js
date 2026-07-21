const CHANNELS = 2
const SAMPLE_RATE_HZ = 48000
const CAPACITY_FRAMES = SAMPLE_RATE_HZ

class ApplicationAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(CAPACITY_FRAMES * CHANNELS)
    this.readFrame = 0
    this.writeFrame = 0
    this.availableFrames = 0
    this.sessionId = null
    this.pcmPort = null
    this.lastSequence = -1
    this.port.onmessage = (event) => this.handleControl(event.data)
  }

  handleControl(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'attach-port' && !this.pcmPort && message.port instanceof MessagePort) {
      this.sessionId = message.sessionId
      this.pcmPort = message.port
      this.pcmPort.onmessage = (event) => this.handlePcm(event.data)
      this.pcmPort.start()
      return
    }
    if (message.type === 'reset' && message.sessionId === this.sessionId) this.clear()
    if (message.type === 'destroy') {
      this.pcmPort?.close()
      this.pcmPort = null
      this.sessionId = null
      this.clear()
    }
  }

  handlePcm(block) {
    if (!block || block.sessionId !== this.sessionId) return
    if (block.channels !== CHANNELS || block.sampleRate !== SAMPLE_RATE_HZ) return
    if (!Number.isSafeInteger(block.sequence) || block.sequence <= this.lastSequence) return
    if (!Number.isSafeInteger(block.frames) || block.frames <= 0 || !(block.data instanceof ArrayBuffer)) return
    const samples = new Float32Array(block.data)
    if (samples.length !== block.frames * CHANNELS) return
    this.lastSequence = block.sequence
    const acceptedFrames = Math.min(block.frames, CAPACITY_FRAMES)
    const skippedFrames = block.frames - acceptedFrames
    const overflow = Math.max(0, this.availableFrames + acceptedFrames - CAPACITY_FRAMES)
    this.readFrame = (this.readFrame + overflow) % CAPACITY_FRAMES
    this.availableFrames -= overflow
    for (let frame = 0; frame < acceptedFrames; frame += 1) {
      const source = (skippedFrames + frame) * CHANNELS
      const target = this.writeFrame * CHANNELS
      this.buffer[target] = samples[source]
      this.buffer[target + 1] = samples[source + 1]
      this.writeFrame = (this.writeFrame + 1) % CAPACITY_FRAMES
    }
    this.availableFrames += acceptedFrames
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    const left = output?.[0]
    const right = output?.[1]
    if (!left || !right) return true
    for (let frame = 0; frame < left.length; frame += 1) {
      if (this.availableFrames === 0) {
        left[frame] = 0
        right[frame] = 0
        continue
      }
      const source = this.readFrame * CHANNELS
      left[frame] = this.buffer[source]
      right[frame] = this.buffer[source + 1]
      this.readFrame = (this.readFrame + 1) % CAPACITY_FRAMES
      this.availableFrames -= 1
    }
    return true
  }

  clear() {
    this.readFrame = 0
    this.writeFrame = 0
    this.availableFrames = 0
    this.lastSequence = -1
  }
}

registerProcessor('cws-application-audio', ApplicationAudioProcessor)
