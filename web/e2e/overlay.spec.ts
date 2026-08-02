import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_VOICE_OVERLAY_CONFIG } from '../src/audio/voiceOverlayBridge.ts'
import type { VoiceOverlayConfig, VoiceOverlayState } from '../src/audio/voiceOverlayBridge.ts'

interface WindowWithOverlay {
  __pushState?: (state: VoiceOverlayState) => void
  __pushConfig?: (config: VoiceOverlayConfig) => void
  __contentSizes?: { width: number; height: number }[]
}

interface OverlayHostPayload {
  state: VoiceOverlayState
  config: VoiceOverlayConfig
}

function installOverlayHost({ state, config }: OverlayHostPayload): void {
  const host = {
    getState: () => Promise.resolve({ state, config }),
    onState: (listener: (next: VoiceOverlayState) => void) => {
      (window as unknown as WindowWithOverlay).__pushState = listener
      return () => undefined
    },
    onConfig: (listener: (next: VoiceOverlayConfig) => void) => {
      (window as unknown as WindowWithOverlay).__pushConfig = listener
      return () => undefined
    },
    reportContentSize: (size: { width: number; height: number }) => {
      const win = window as unknown as WindowWithOverlay
      win.__contentSizes = win.__contentSizes ?? []
      win.__contentSizes.push(size)
    },
  }
  Object.defineProperty(window, 'overlayHost', { value: host })
}

const lastContentSize = (page: Page) => page.evaluate(() =>
  (window as unknown as WindowWithOverlay).__contentSizes?.at(-1) ?? null)

const defaultConfig: VoiceOverlayConfig = { ...DEFAULT_VOICE_OVERLAY_CONFIG }

test('语音浮层页面：按快照渲染参与者并应用配置', async ({ page }) => {
  await page.addInitScript(installOverlayHost, {
    state: {
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: 'alice', avatarUrl: null, isLocal: true, speaking: true, microphoneMuted: false, deafened: false },
        { identity: 'u2', name: '李四', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: true, deafened: false },
        { identity: 'u3', name: '王五', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: false, deafened: true },
        { identity: 'u4', name: '赵六', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: true, deafened: true },
        { identity: 'u5', name: '😀表情', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: false, deafened: false },
      ],
    },
    config: defaultConfig,
  })
  await page.goto('/overlay.html')
  await expect(page.locator('.participant')).toHaveCount(5)
  await expect.poll(() => lastContentSize(page)).toEqual({ width: 280, height: 204 })
  await expect(page.locator('.participant:has-text("😀表情") .participant-avatar-initial')).toHaveText('😀')
  await expect(page.locator('.participant.speaking', { hasText: 'alice' })).toHaveCount(1)
  await expect(page.getByText('alice（你）')).toBeVisible()
  await expect(page.locator('.participant:has-text("alice") .participant-avatar-initial')).toHaveText('A')
  await expect(page.locator('.participant:has-text("李四") .participant-icon[aria-label="麦克风已静音"]')).toBeVisible()
  await expect(page.locator('.participant:has-text("王五") .participant-icon[aria-label="耳机已静音"]')).toBeVisible()
  await expect(page.locator('.participant:has-text("赵六") .participant-icon[aria-label="耳机已静音"]')).toBeVisible()
  await expect(page.locator('.participant:has-text("赵六") .participant-icon[aria-label="麦克风已静音"]')).toBeVisible()
  await expect(page.locator('.participant.speaking')).toHaveCSS('opacity', '0.8')
  await expect(page.locator('.participant:has-text("李四")')).toHaveCSS('opacity', '0.4')

  await page.evaluate(() => {
    (window as unknown as WindowWithOverlay).__pushState?.({
      channel: null,
      participants: [],
    })
  })
  await expect(page.locator('.participant')).toHaveCount(0)
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('语音浮层页面：头像加载失败回退首字母', async ({ page }) => {
  await page.addInitScript(installOverlayHost, {
    state: {
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: '张三', avatarUrl: 'http://127.0.0.1:1/missing.png', isLocal: false, speaking: false, microphoneMuted: false, deafened: false },
      ],
    },
    config: defaultConfig,
  })
  await page.goto('/overlay.html')
  await expect(page.locator('.participant')).toHaveCount(1)
  await expect(page.locator('.participant:has-text("张三") .participant-avatar-initial')).toHaveText('张')
})

test('语音浮层页面：配置推送改变不透明度与缩放', async ({ page }) => {
  await page.addInitScript(installOverlayHost, {
    state: {
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: '张三', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: false, deafened: false },
      ],
    },
    config: defaultConfig,
  })
  await page.goto('/overlay.html')
  await expect(page.locator('.participant')).toHaveCount(1)
  await expect(page.locator('#participants')).toHaveCSS('zoom', '1')
  await page.waitForFunction(() => (
    typeof (window as unknown as WindowWithOverlay).__pushState === 'function' &&
    typeof (window as unknown as WindowWithOverlay).__pushConfig === 'function'
  ))

  const pushed = await page.evaluate(() => {
    const win = window as unknown as WindowWithOverlay
    const pushConfig = win.__pushConfig
    const pushState = win.__pushState
    if (pushConfig) pushConfig({
      scalePercent: 150,
      positionXPercent: 9,
      positionYPercent: 50,
      speakingOpacityPercent: 90,
      silentOpacityPercent: 20,
    })
    if (pushState) pushState({
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: '张三', avatarUrl: null, isLocal: false, speaking: true, microphoneMuted: false, deafened: false },
      ],
    })
    return { pushConfig: typeof pushConfig, pushState: typeof pushState }
  })
  expect(pushed).toEqual({ pushConfig: 'function', pushState: 'function' })
  await expect(page.locator('#participants')).toHaveCSS('zoom', '1.5')
  await expect(page.locator('.participant.speaking')).toHaveCSS('opacity', '0.9')
  await expect.poll(() => lastContentSize(page)).toEqual({ width: 420, height: 54 })
})
