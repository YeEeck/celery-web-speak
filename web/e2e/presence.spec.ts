import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'

test('成员列表实时反映多连接关闭与异常断网', async ({ browser, isMobile, page, request }, testInfo) => {
  test.skip(isMobile, '成员状态生命周期只需在一个浏览器项目中验证')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name}`.replace(/[^a-z0-9_-]/g, '_')
  const account = {
    username: `presence_${suffix}`.slice(0, 32),
    displayName: `在线状态${suffix.slice(-6)}`,
    password: 'presence-member-password',
  }
  const createResponse = await request.post('/api/admin/users', { data: { ...account, role: 'member' } })
  expect(createResponse.ok()).toBeTruthy()
  const accountID = (await createResponse.json() as { user: { id: number } }).user.id
  const targetContexts: BrowserContext[] = []

  try {
    await login(page, adminUsername, adminPassword)
    const first = await openLoggedInContext(browser, account)
    const second = await openLoggedInContext(browser, account)
    targetContexts.push(first.context, second.context)

    await expect(onlineMember(page, account.displayName)).toBeVisible()
    await first.context.close()
    targetContexts.splice(targetContexts.indexOf(first.context), 1)
    await expect(onlineMember(page, account.displayName)).toBeVisible()

    await second.context.close()
    targetContexts.splice(targetContexts.indexOf(second.context), 1)
    await expect(offlineMember(page, account.displayName)).toBeVisible({ timeout: 5_000 })

    const reconnecting = await openLoggedInContext(browser, account)
    targetContexts.push(reconnecting.context)
    await expect(onlineMember(page, account.displayName)).toBeVisible()

    await reconnecting.context.setOffline(true)
    await page.waitForTimeout(8_000)
    await expect(onlineMember(page, account.displayName)).toBeVisible()
    await reconnecting.context.setOffline(false)
    await expect(reconnecting.page.getByText('实时连接正常', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(onlineMember(page, account.displayName)).toBeVisible()

    await reconnecting.context.setOffline(true)
    await expect(offlineMember(page, account.displayName)).toBeVisible({ timeout: 20_000 })
    await reconnecting.context.setOffline(false)
    await expect(reconnecting.page.getByText('实时连接正常', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(onlineMember(page, account.displayName)).toBeVisible()
  } finally {
    await Promise.all(targetContexts.map((context) => context.close()))
    await request.delete(`/api/admin/users/${accountID}`, { data: { username: account.username } })
  }
})

async function login(page: Page, username: string, password: string) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
}

async function openLoggedInContext(browser: Browser, account: { username: string; password: string }) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await login(page, account.username, account.password)
  return { context, page }
}

function onlineMember(page: Page, displayName: string) {
  return memberSection(page, /^在线/).locator('.member-row').filter({ hasText: displayName })
}

function offlineMember(page: Page, displayName: string) {
  return memberSection(page, /^离线/).locator('.member-row').filter({ hasText: displayName })
}

function memberSection(page: Page, heading: RegExp) {
  return page.locator('.member-list section').filter({ has: page.getByRole('heading', { name: heading }) })
}
