import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'

test('账户菜单切换固定离开实时同步到其他客户端且刷新保留', async ({ browser, isMobile, page, request }, testInfo) => {
  test.setTimeout(100_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name}`.replace(/[^a-z0-9_-]/g, '_')
  const account = {
    username: `status_${suffix}`.slice(0, 32),
    displayName: `状态测试${suffix.slice(-6)}`,
    password: 'status-member-password',
  }
  const accountID = (await createGuildMember(request, guildID, account)).id
  const memberContexts: BrowserContext[] = []

  try {
    await login(page, adminUsername, adminPassword)
    const memberContext = await openLoggedInContext(browser, account)
    memberContexts.push(memberContext.context)
    const memberPage = memberContext.page

    if (isMobile) await page.getByTitle('显示成员列表').click()
    await expect(onlineMember(page, account.username)).toBeVisible()

    const menu = await openAccountMenu(memberPage)
    const fixedAwayItem = menu.getByRole('menuitem', { name: '固定离开', exact: true })
    await expect(fixedAwayItem).toHaveAttribute('aria-checked', 'false')
    await fixedAwayItem.click()
    await expect(fixedAwayItem).toHaveAttribute('aria-checked', 'true')

    await expect(memberPage.getByTitle('用户账户').locator('.presence-dot')).toHaveAttribute('aria-label', '离开')
    await expect(awayMember(page, account.username)).toBeVisible({ timeout: 10_000 })

    await memberPage.reload()
    await memberPage.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
    await expect(memberPage.getByTitle('用户账户').locator('.presence-dot')).toHaveAttribute('aria-label', '离开')
    await expect(awayMember(page, account.username)).toBeVisible()

    const menuAgain = await openAccountMenu(memberPage)
    await menuAgain.getByRole('menuitem', { name: '自动模式', exact: true }).click()
    await expect(memberPage.getByTitle('用户账户').locator('.presence-dot')).toHaveAttribute('aria-label', '在线')
    await expect(onlineMember(page, account.username)).toBeVisible({ timeout: 10_000 })
  } finally {
    await Promise.allSettled(memberContexts.map((context) => context.close()))
    await deletePlatformUser(request, accountID, account.username)
  }
})

test('自动模式 10 分钟无说话进入离开并同步给其他客户端', async ({ browser, isMobile, page, request }, testInfo) => {
  test.skip(isMobile, '时钟模拟只需在一个浏览器项目中验证')
  test.setTimeout(100_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name}`.replace(/[^a-z0-9_-]/g, '_')
  const account = {
    username: `away_${suffix}`.slice(0, 32),
    displayName: `离开测试${suffix.slice(-6)}`,
    password: 'away-member-password',
  }
  const accountID = (await createGuildMember(request, guildID, account)).id
  const memberContexts: BrowserContext[] = []

  try {
    await login(page, adminUsername, adminPassword)

    const context = await browser.newContext()
    const memberPage = await context.newPage()
    memberContexts.push(context)
    await memberPage.clock.install()
    await login(memberPage, account.username, account.password)

    await expect(onlineMember(page, account.username)).toBeVisible()
    await expect(memberPage.getByTitle('用户账户').locator('.presence-dot')).toHaveAttribute('aria-label', '在线')

    // 关闭静音时说话提醒开关不停止在线状态检测
    await openUserSettings(memberPage)
    await memberPage.getByRole('button', { name: '音频', exact: true }).click()
    await memberPage.getByLabel('静音时说话提醒').uncheck()
    await memberPage.getByRole('dialog', { name: '用户设置' }).getByTitle('关闭').click()

    await memberPage.clock.fastForward(11 * 60_000)

    await expect(memberPage.getByTitle('用户账户').locator('.presence-dot')).toHaveAttribute('aria-label', '离开', { timeout: 10_000 })
    await expect(awayMember(page, account.username)).toBeVisible({ timeout: 10_000 })
  } finally {
    await Promise.allSettled(memberContexts.map((context) => context.close()))
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

async function openAccountMenu(page: Page) {
  await page.getByTitle('用户账户').click()
  const menu = page.getByRole('menu', { name: '用户账户操作' })
  await expect(menu).toBeVisible()
  return menu
}

async function openUserSettings(page: Page) {
  const menu = await openAccountMenu(page)
  await menu.getByRole('menuitem', { name: '用户设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '用户设置' })).toBeVisible()
}

function onlineMember(page: Page, username: string) {
  return memberSection(page, /^在线/).locator('.member-row').filter({ has: page.getByText(`@${username}`, { exact: true }) })
}

function awayMember(page: Page, username: string) {
  return memberSection(page, /^离开/).locator('.member-row').filter({ has: page.getByText(`@${username}`, { exact: true }) })
}

function memberSection(page: Page, heading: RegExp) {
  return page.locator('.member-list section').filter({ has: page.getByRole('heading', { name: heading }) })
}
