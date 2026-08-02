// RNNoise 运行时加载器：应用启动时预取 WASM 二进制并缓存；worklet 模块注册
// 与节点创建在需要时进行。所有对 @sapphi-red/web-noise-suppressor 的导入都是
// 动态的——该包在模块加载期引用 AudioWorkletNode，node 测试环境不可静态导入，
// 也避免在未使用降噪时把包打进主包。

import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'

let wasmBinaryPromise: Promise<ArrayBuffer | null> | null = null

// 预取 RNNoise WASM 二进制（启动时调用一次），失败返回 null。
export function preloadRnnoiseWasm(): Promise<ArrayBuffer | null> {
  if (!wasmBinaryPromise) {
    const loading = import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url')
      .then(async (module) => {
        const { loadRnnoise } = await import('@sapphi-red/web-noise-suppressor')
        const binary = await loadRnnoise({ url: module.default, simdUrl: module.default })
        if (binary.byteLength === 0 || !WebAssembly.validate(new Uint8Array(binary))) {
          throw new Error('RNNoise WASM binary is invalid')
        }
        return binary
      })
    wasmBinaryPromise = loading.catch(() => {
      // A failed prefetch must be retried by the next voice session.
      wasmBinaryPromise = null
      return null
    })
  }
  return wasmBinaryPromise
}

// 在指定音频上下文创建 RNNoise 降噪节点；注册 worklet 失败或环境不支持时返回
// null。RNNoise 内部固定 48kHz，仅支持 48kHz 上下文。
export async function createRnnoiseNode(context: AudioContext, wasmBinary: ArrayBuffer): Promise<RnnoiseWorkletNode | null> {
  if (context.sampleRate !== 48_000) return null
  try {
    const workletModule = await import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url')
    await context.audioWorklet.addModule(workletModule.default)
    const { RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor')
    return new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary })
  } catch {
    return null
  }
}
