import { expect, test } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

test('两个独立账号可建立并接收语音轨道', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const accounts = [
    { username: `voice_a_${suffix}`, displayName: `语音甲${suffix.slice(-1)}`, password: 'voice-member-password-a' },
    { username: `voice_b_${suffix}`, displayName: `语音乙${suffix.slice(-1)}`, password: 'voice-member-password-b' },
  ]
  for (const account of accounts) {
    const response = await request.post('/api/admin/users', { data: { ...account, role: 'member' } })
    expect(response.ok()).toBeTruthy()
  }

  const contexts = await Promise.all(accounts.map(async (account) => {
    const context = await browser.newContext({ permissions: ['microphone'] })
    await context.grantPermissions(['microphone'], { origin: baseURL })
    const page = await context.newPage()
    await page.goto(baseURL)
    await page.getByLabel('登录名').fill(account.username)
    await page.getByLabel('密码').fill(account.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
    if (testInfo.project.name.startsWith('android')) await page.getByTitle('频道').click()
    await page.getByRole('button', { name: /语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    return { context, page }
  }))

  try {
    for (const { page } of contexts) {
      await expect(page.locator('.voice-member').filter({ hasText: accounts[0].displayName })).toBeVisible()
      await expect(page.locator('.voice-member').filter({ hasText: accounts[1].displayName })).toBeVisible()
      await expect.poll(() => page.locator('#voice-audio-root audio').count()).toBeGreaterThanOrEqual(1)
    }
  } finally {
    await Promise.all(contexts.map(({ context }) => context.close()))
  }
})
