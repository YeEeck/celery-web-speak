import assert from 'node:assert/strict'
import test from 'node:test'
import { RNNOISE_WORKLET_PROCESSOR_ID, rnnoiseWorkletNodeOptions } from '../src/audio/rnnoise.ts'

test('RNNoise worklet node is constructed as explicit mono', () => {
  const wasmBinary = new ArrayBuffer(8)
  assert.equal(RNNOISE_WORKLET_PROCESSOR_ID, '@sapphi-red/web-noise-suppressor/rnnoise')
  assert.deepEqual(rnnoiseWorkletNodeOptions(wasmBinary), {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { maxChannels: 1, wasmBinary },
  })
})
