import { mkdirSync, writeFileSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'
import { buildGifAvatarFixture } from './e2e/gif-fixture'
import { framesToWav, generateFixtureFrames } from './e2e/noise-fixture'

// 降噪测量 fixture：确定性生成并落盘，供 --use-file-for-fake-audio-capture 使用。
// 生成在 config 加载时完成（幂等、约 1.3MB，开销可忽略），保证测量项目随时可跑。
const noiseFixturePath = new URL('./e2e/fixtures/noise-fixture.wav', import.meta.url).pathname
mkdirSync(new URL('./e2e/fixtures/', import.meta.url).pathname, { recursive: true })
writeFileSync(noiseFixturePath, framesToWav(generateFixtureFrames()))

// GIF 头像上传 fixture：确定性生成 2 帧动画 GIF，供头像上传用例旁路裁剪器直传。
const gifFixturePath = new URL('./e2e/fixtures/gif-avatar.gif', import.meta.url).pathname
writeFileSync(gifFixturePath, buildGifAvatarFixture())

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: 'list',
  // All projects mutate the same backend database, so parallel workers are not isolated.
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: [/noise-suppression\.spec\.ts/, /voice-auto-balance\.spec\.ts/] },
    { name: 'android-chromium', use: { ...devices['Pixel 7'] }, testIgnore: [/noise-suppression\.spec\.ts/, /voice-auto-balance\.spec\.ts/] },
    // 降噪测量专用项目：文件假麦克风注入确定性音频样本。与其余项目隔离——
    // 全局注入会改变现有用例的假麦克风输入（静音→语音信号），破坏
    // 在线状态/DTX 等依赖静音的断言。
    {
      name: 'desktop-chromium-noise',
      testMatch: /noise-suppression\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${noiseFixturePath}`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    // 自动音量平衡专用项目：fixture 音频注入确定性发送电平（隔离原则同噪声项目）。
    {
      name: 'desktop-chromium-voice-balance',
      testMatch: /voice-auto-balance\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${noiseFixturePath}`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
})
