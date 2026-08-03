import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMicrophoneCaptureOptions } from '../src/audio/microphoneCaptureOptions.ts'

test('enables automatic gain and disables browser voice isolation while preserving other microphone preferences', () => {
  assert.deepEqual(buildMicrophoneCaptureOptions({
    deviceId: 'preferred-microphone',
    echoCancellation: true,
    noiseSuppression: false,
  }), {
    // deviceId 一律 {exact}：Chromium 以字符串（ideal）传 'default' 会解析到
    // 错误默认设备（见源码注释）。
    deviceId: { exact: 'preferred-microphone' },
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    // 浏览器 AI 语音隔离游离于"降噪选项"语义之外，显式关闭（见源码注释）。
    voiceIsolation: false,
    channelCount: 1,
  })
})
