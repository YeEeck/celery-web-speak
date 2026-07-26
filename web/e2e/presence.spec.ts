import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'

test('成员列表实时反映多连接关闭与异常断网', async ({ browser, isMobile, page, request }, testInfo) => {
  test.skip(isMobile, '成员状态生命周期只需在一个浏览器项目中验证')
  test.setTimeout(100_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const serverID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name}`.replace(/[^a-z0-9_-]/g, '_')
  const account = {
    username: `presence_${suffix}`.slice(0, 32),
    displayName: `在线状态${suffix.slice(-6)}`,
    password: 'presence-member-password',
  }
  const accountID = (await createGuildMember(request, serverID, account)).id
  const targetContexts: BrowserContext[] = []

  try {
    await login(page, adminUsername, adminPassword)
    const first = await openLoggedInContext(browser, account)
    const second = await openLoggedInContext(browser, account)
    targetContexts.push(first.context, second.context)

    await expect(onlineMember(page, account.username)).toBeVisible()
    await first.context.close()
    targetContexts.splice(targetContexts.indexOf(first.context), 1)
    await expect(onlineMember(page, account.username)).toBeVisible()

    await second.context.close()
    targetContexts.splice(targetContexts.indexOf(second.context), 1)
    await expect(offlineMember(page, account.username)).toBeVisible({ timeout: 5_000 })

    const reconnecting = await openLoggedInContext(browser, account)
    targetContexts.push(reconnecting.context)
    await expect(onlineMember(page, account.username)).toBeVisible()

    await reconnecting.context.setOffline(true)
    await page.waitForTimeout(8_000)
    await expect(onlineMember(page, account.username)).toBeVisible()
    await reconnecting.context.setOffline(false)
    await expect(reconnecting.page.getByText('实时连接正常', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(onlineMember(page, account.username)).toBeVisible()

    await reconnecting.context.setOffline(true)
    await expect(offlineMember(page, account.username)).toBeVisible({ timeout: 35_000 })
    await reconnecting.context.setOffline(false)
    await expect(reconnecting.page.getByText('实时连接正常', { exact: true })).toBeVisible({ timeout: 8_000 })
    await expect(onlineMember(page, account.username)).toBeVisible()
  } finally {
    await Promise.allSettled(targetContexts.map((context) => context.close()))
    await deletePlatformUser(request, accountID, account.username)
  }
})

test('业务连接恢复后同步断线期间的频道和消息', async ({ isMobile, page, request }) => {
  test.skip(isMobile, '业务状态恢复只需在一个浏览器项目中验证')
  test.setTimeout(100_000)
  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const serverID = await firstJoinedGuildID(request)
  const suffix = Date.now().toString(36)
  const account = { username: `sync_${suffix}`, displayName: `同步测试${suffix.slice(-4)}`, password: 'sync-member-password' }
  const accountID = (await createGuildMember(request, serverID, account)).id
  await login(page, account.username, account.password)
  const channelName = `恢复频道${Date.now().toString(36).slice(-5)}`
  const message = `断线恢复检查 ${Date.now()}`
  let channelID = 0

  try {
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await expect.poll(async () => {
      const bootstrap = await (await request.get(`/api/guilds/${serverID}/bootstrap`)).json() as { online: { userId: number; client: string }[] }
      return bootstrap.online.some((entry) => entry.userId === accountID)
    }).toBe(false)
    const channelResponse = await request.post(`/api/guilds/${serverID}/channels`, { data: { type: 'text', name: channelName } })
    expect(channelResponse.ok()).toBeTruthy()
    channelID = (await channelResponse.json() as { channel: { id: number } }).channel.id
    const messageResponse = await request.post(`/api/guilds/${serverID}/channels/${channelID}/messages`, { data: { content: message } })
    expect(messageResponse.ok()).toBeTruthy()

    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
    await expect(page.getByText('实时连接正常', { exact: true })).toBeVisible({ timeout: 12_000 })
    const channelButton = page.getByRole('button', { name: new RegExp(channelName) })
    await expect(channelButton).toBeVisible()
    await channelButton.click()
    await expect(page.getByText(message, { exact: true })).toBeVisible()
  } finally {
    if (channelID) await request.delete(`/api/guilds/${serverID}/channels/${channelID}`)
    await deletePlatformUser(request, accountID, account.username)
  }
})

async function login(page: Page, username: string, password: string) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
}

async function openLoggedInContext(browser: Browser, account: { username: string; password: string }) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await login(page, account.username, account.password)
  return { context, page }
}

function onlineMember(page: Page, username: string) {
  return memberSection(page, /^在线/).locator('.member-row').filter({ has: page.getByText(`@${username}`, { exact: true }) })
}

function offlineMember(page: Page, username: string) {
  return memberSection(page, /^离线/).locator('.member-row').filter({ has: page.getByText(`@${username}`, { exact: true }) })
}

function memberSection(page: Page, heading: RegExp) {
  return page.locator('.member-list section').filter({ has: page.getByRole('heading', { name: heading }) })
}
