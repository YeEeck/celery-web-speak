import { expect, test } from '@playwright/test'
import type { VoiceOverlayConfig, VoiceOverlayState } from '../src/audio/voiceOverlayBridge.ts'

interface WindowWithOverlay {
  __pushState?: (state: VoiceOverlayState) => void
  __pushConfig?: (config: VoiceOverlayConfig) => void
}

test('语音浮层页面：按快照渲染参与者并应用配置', async ({ page }) => {
  await page.addInitScript(() => {
    let state: VoiceOverlayState = {
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: 'alice', avatarUrl: null, isLocal: true, speaking: true, microphoneMuted: false, deafened: false },
        { identity: 'u2', name: '李四', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: true, deafened: false },
        { identity: 'u3', name: '王五', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: false, deafened: true },
      ],
    }
    let config: VoiceOverlayConfig = {
      scalePercent: 100,
      positionXPercent: 9,
      positionYPercent: 50,
      speakingOpacityPercent: 80,
      silentOpacityPercent: 40,
    }
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
    }
    Object.defineProperty(window, 'overlayHost', { value: host })
  })
  await page.goto('/overlay.html')
  await expect(page.locator('.participant')).toHaveCount(3)
  await expect(page.locator('.participant.speaking', { hasText: 'alice' })).toHaveCount(1)
  await expect(page.getByText('alice（你）')).toBeVisible()
  await expect(page.locator('.participant:has-text("alice") .participant-avatar-initial')).toHaveText('A')
  await expect(page.locator('.participant:has-text("李四") .participant-icon[aria-label="麦克风已静音"]')).toBeVisible()
  await expect(page.locator('.participant:has-text("王五") .participant-icon[aria-label="耳机已静音"]')).toBeVisible()
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

test('语音浮层页面：配置推送改变不透明度与缩放', async ({ page }) => {
  await page.addInitScript(() => {
    let state: VoiceOverlayState = {
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: '张三', avatarUrl: null, isLocal: false, speaking: false, microphoneMuted: false, deafened: false },
      ],
    }
    let config: VoiceOverlayConfig = {
      scalePercent: 100,
      positionXPercent: 9,
      positionYPercent: 50,
      speakingOpacityPercent: 80,
      silentOpacityPercent: 40,
    }
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
    }
    Object.defineProperty(window, 'overlayHost', { value: host })
  })
  await page.goto('/overlay.html')
  await expect(page.locator('.participant')).toHaveCount(1)
  await expect(page.locator('#participants')).toHaveCSS('zoom', '1')
  await page.waitForFunction(() => (
    typeof (window as unknown as WindowWithOverlay).__pushState === 'function' &&
    typeof (window as unknown as WindowWithOverlay).__pushConfig === 'function'
  ))

  await page.evaluate(() => {
    (window as unknown as WindowWithOverlay).__pushConfig?.({
      scalePercent: 150,
      positionXPercent: 9,
      positionYPercent: 50,
      speakingOpacityPercent: 90,
      silentOpacityPercent: 20,
    })
    (window as unknown as WindowWithOverlay).__pushState?.({
      channel: { name: '大厅' },
      participants: [
        { identity: 'u1', name: '张三', avatarUrl: null, isLocal: false, speaking: true, microphoneMuted: false, deafened: false },
      ],
    })
  })
  await expect(page.locator('#participants')).toHaveCSS('zoom', '1.5')
  await expect(page.locator('.participant.speaking')).toHaveCSS('opacity', '0.9')
})
