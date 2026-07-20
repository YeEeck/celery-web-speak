import { expect, test, type Page } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

test('两个独立账号可建立并接收语音轨道', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const displaySuffix = suffix.slice(-6)
  const accounts = [
    { username: `voice_a_${suffix}`, displayName: `语音甲${displaySuffix}`, password: 'voice-member-password-a' },
    { username: `voice_b_${suffix}`, displayName: `语音乙${displaySuffix}`, password: 'voice-member-password-b' },
  ]
  const accountIds = new Map<string, number>()
  for (const account of accounts) {
    const response = await request.post('/api/admin/users', { data: { ...account, role: 'member' } })
    expect(response.ok()).toBeTruthy()
    const payload = await response.json() as { user: { id: number } }
    accountIds.set(account.username, payload.user.id)
  }

  const contexts = []
  for (const account of accounts) {
    const context = await browser.newContext({ permissions: ['microphone'] })
    await context.grantPermissions(['microphone'], { origin: baseURL })
    const page = await context.newPage()
    await page.goto(baseURL)
    await page.getByLabel('登录名').fill(account.username)
    await page.getByLabel('密码').fill(account.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
    if (testInfo.project.name.startsWith('android')) await page.getByTitle('频道').click()
    await installToneCounter(page)
    const tonesBeforeJoin = await toneCount(page)
    await page.getByRole('button', { name: /语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    await expect.poll(() => toneCount(page)).toBeGreaterThanOrEqual(tonesBeforeJoin + 2)
    contexts.push({ context, page })
  }

  try {
    await expect.poll(() => toneCount(contexts[0].page)).toBeGreaterThanOrEqual(4)
    for (const { page } of contexts) {
      await expect(page.locator('.voice-member').filter({ hasText: accounts[0].displayName })).toBeVisible()
      await expect(page.locator('.voice-member').filter({ hasText: accounts[1].displayName })).toBeVisible()
      await expect.poll(() => page.locator('#voice-audio-root audio').count()).toBeGreaterThanOrEqual(1)
    }

    await expectVoiceOrder(contexts.map(({ page }) => page), accounts.map(({ displayName }) => displayName))

    const secondAccountId = accountIds.get(accounts[1].username)!
    const promoteResponse = await request.patch(`/api/admin/users/${secondAccountId}/role`, { data: { role: 'channel_admin' } })
    expect(promoteResponse.ok()).toBeTruthy()
    await expectVoiceOrder(contexts.map(({ page }) => page), [accounts[1].displayName, accounts[0].displayName])

    const demoteResponse = await request.patch(`/api/admin/users/${secondAccountId}/role`, { data: { role: 'member' } })
    expect(demoteResponse.ok()).toBeTruthy()
    await expectVoiceOrder(contexts.map(({ page }) => page), accounts.map(({ displayName }) => displayName))

    const remoteMember = contexts[0].page.locator('.voice-member').filter({ hasText: accounts[1].displayName })
    await remoteMember.locator('.voice-member-main').click()
    const remoteVolume = remoteMember.getByLabel('用户音量')
    await expect(remoteVolume).toHaveValue('1')
    await expect(remoteVolume).toHaveAttribute('max', '3')
    await remoteVolume.fill('3')
    await expect(remoteMember.getByText('300%', { exact: true })).toBeVisible()

    const beforeRemoteLeave = await toneCount(contexts[0].page)
    await contexts[1].page.getByTitle('断开语音').click()
    await expect.poll(() => toneCount(contexts[0].page)).toBeGreaterThanOrEqual(beforeRemoteLeave + 2)
  } finally {
    await Promise.all(contexts.map(({ context }) => context.close()))
  }
})

async function expectVoiceOrder(pages: Page[], expected: string[]) {
  for (const page of pages) {
    await expect.poll(async () => {
      const labels = await page.locator('.voice-member-name').allTextContents()
      return labels.map((label) => label.replace('你', '').trim()).filter((label) => expected.includes(label))
    }).toEqual(expected)
  }
}

async function installToneCounter(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __cwsToneCount?: number }
    target.__cwsToneCount = 0
    const prototype = AudioContext.prototype
    const original = prototype.createOscillator
    prototype.createOscillator = function createCountedOscillator(this: AudioContext) {
      target.__cwsToneCount = (target.__cwsToneCount ?? 0) + 1
      return original.call(this)
    }
  })
}

async function toneCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __cwsToneCount?: number }).__cwsToneCount ?? 0)
}
