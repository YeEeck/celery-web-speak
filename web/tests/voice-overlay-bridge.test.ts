import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VOICE_OVERLAY_PROTOCOL,
  connectVoiceOverlayBridge,
  type DesktopVoiceOverlayBridge,
} from '../src/audio/voiceOverlayBridge.ts'

interface FakeBridge {
  helloCalls: Array<{ minProtocol: number; maxProtocol: number }>
  helloResult: unknown
  helloError: Error | null
}

function fakeBridge(): FakeBridge {
  return {
    helloCalls: [],
    helloResult: { protocol: 1, capabilities: ['voice_overlay'] },
    helloError: null,
  }
}

function installBridge(bridge: FakeBridge): void {
  const desktopVoiceOverlay: DesktopVoiceOverlayBridge = {
    hello: async (input) => {
      bridge.helloCalls.push(input)
      if (bridge.helloError) throw bridge.helloError
      return bridge.helloResult as { protocol: number; capabilities: string[] }
    },
    setEnabled: async () => undefined,
    pushState: () => undefined,
  }
  Object.defineProperty(globalThis, 'window', {
    value: { desktopVoiceOverlay },
    configurable: true,
    writable: true,
  })
}

test('voice overlay bridge: accepts the active desktop bridge', async () => {
  const bridge = fakeBridge()
  installBridge(bridge)
  const connected = await connectVoiceOverlayBridge()
  assert.ok(connected)
  assert.deepEqual(bridge.helloCalls, [{
    minProtocol: VOICE_OVERLAY_PROTOCOL,
    maxProtocol: VOICE_OVERLAY_PROTOCOL,
  }])
})

test('voice overlay bridge: returns null when no desktop bridge is exposed', async () => {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true })
  assert.equal(await connectVoiceOverlayBridge(), null)
})

test('voice overlay bridge: returns null on protocol mismatch', async () => {
  const bridge = fakeBridge()
  bridge.helloResult = { protocol: 2, capabilities: ['voice_overlay'] }
  installBridge(bridge)
  assert.equal(await connectVoiceOverlayBridge(), null)
})

test('voice overlay bridge: returns null when the capability is missing', async () => {
  const bridge = fakeBridge()
  bridge.helloResult = { protocol: 1, capabilities: [] }
  installBridge(bridge)
  assert.equal(await connectVoiceOverlayBridge(), null)
})

test('voice overlay bridge: returns null when the handshake throws', async () => {
  const bridge = fakeBridge()
  bridge.helloError = new Error('bridge crashed')
  installBridge(bridge)
  assert.equal(await connectVoiceOverlayBridge(), null)
})
