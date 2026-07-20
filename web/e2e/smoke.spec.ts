import { expect, request as createRequestContext, test } from '@playwright/test'

const username = process.env.E2E_USERNAME ?? 'admin'
const password = process.env.E2E_PASSWORD ?? 'admin-password-123'
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('登录名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
})

test('登录、聊天和管理员设置可用', async ({ page }) => {
  const message = `端到端检查 ${Date.now()}`
  await page.getByPlaceholder('发送消息到 #文字聊天').fill(message)
  await page.getByTitle('发送消息').click()
  await expect(page.getByText(message)).toBeVisible()

  const adminButton = page.getByText('管理控制台', { exact: true })
  if (!(await adminButton.isVisible())) {
    await page.getByTitle('频道').click()
  }
  await adminButton.click()
  await expect(page.getByRole('heading', { name: '管理控制台' })).toBeVisible()
  await expect(page.getByText('Opus 发送码率')).toBeVisible()
  await page.getByTitle('关闭').last().click()

  const viewport = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(viewport.width).toBeLessThanOrEqual(viewport.client)
  const verticalLayout = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')!.getBoundingClientRect()
    const composer = document.querySelector('.composer-area')!.getBoundingClientRect()
    return { viewport: window.innerHeight, shellHeight: shell.height, composerBottom: composer.bottom }
  })
  expect(Math.abs(verticalLayout.viewport - verticalLayout.shellHeight)).toBeLessThan(2)
  expect(Math.abs(verticalLayout.viewport - verticalLayout.composerBottom)).toBeLessThan(2)
})

test('本地音量增益默认 100% 并持久化到浏览器', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()

  const microphoneGain = page.getByLabel('麦克风增益')
  const outputVolume = page.getByLabel('扬声器音量')
  await expect(microphoneGain).toHaveValue('1')
  await expect(outputVolume).toHaveValue('1')
  await expect(microphoneGain).toHaveAttribute('max', '3')
  await expect(outputVolume).toHaveAttribute('max', '3')

  await microphoneGain.fill('2.5')
  await outputVolume.fill('1.5')
  await expect(page.getByText('250%', { exact: true })).toBeVisible()
  await expect(page.getByText('150%', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => ({
    microphone: localStorage.getItem('cws.microphoneGain'),
    output: localStorage.getItem('cws.outputVolume'),
  }))).toEqual({ microphone: '2.5', output: '1.5' })
})

test('操作提示音默认开启并持久化到浏览器', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()

  const masterSwitch = page.getByLabel('启用提示音')
  const soundVolume = page.getByLabel('提示音音量')
  const joinSwitch = page.getByLabel('加入语音')
  const leaveSwitch = page.getByLabel('退出语音')
  const messageSwitch = page.getByLabel('新文字消息')
  await expect(masterSwitch).toBeChecked()
  await expect(soundVolume).toHaveValue('0.6')
  await expect(joinSwitch).toBeChecked()
  await expect(leaveSwitch).toBeChecked()
  await expect(messageSwitch).toBeChecked()

  await soundVolume.fill('0.35')
  await joinSwitch.uncheck()
  await messageSwitch.uncheck()
  await expect.poll(() => page.evaluate(() => ({
    volume: localStorage.getItem('cws.notificationSounds.volume'),
    join: localStorage.getItem('cws.notificationSounds.join'),
    message: localStorage.getItem('cws.notificationSounds.message'),
  }))).toEqual({ volume: '0.35', join: 'false', message: 'false' })

  await masterSwitch.uncheck()
  await expect(soundVolume).toBeDisabled()
  await expect(joinSwitch).toBeDisabled()
  await expect(leaveSwitch).toBeDisabled()
  await expect(messageSwitch).toBeDisabled()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.notificationSounds.enabled'))).toBe('false')

  await page.reload()
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()
  await expect(page.getByLabel('启用提示音')).not.toBeChecked()
  await expect(page.getByLabel('提示音音量')).toHaveValue('0.35')
  await expect(page.getByLabel('加入语音')).not.toBeChecked()
  await expect(page.getByLabel('新文字消息')).not.toBeChecked()
})

test('他人的新消息播放提示音，自己的消息不播放', async ({ page, request, isMobile }, testInfo) => {
  await installToneCounter(page)
  await expect(page.locator('.rail-status.online')).toBeAttached()

  await request.post('/api/auth/login', { data: { username, password } })
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `sound_${suffix}`,
    displayName: `提示音测试${suffix.slice(-3)}`,
    password: 'sound-member-password',
    role: 'member',
  }
  const createResponse = await request.post('/api/admin/users', { data: account })
  expect(createResponse.ok()).toBeTruthy()

  const other = await createRequestContext.newContext({ baseURL })
  try {
    const loginResponse = await other.post('/api/auth/login', { data: { username: account.username, password: account.password } })
    expect(loginResponse.ok()).toBeTruthy()
    if (isMobile) await page.waitForTimeout(700)
    const beforeOtherMessage = await toneCount(page)
    const otherMessage = `他人提示音检查 ${Date.now()}`
    const sendResponse = await other.post('/api/messages', { data: { content: otherMessage } })
    expect(sendResponse.ok()).toBeTruthy()
    await expect(page.getByText(otherMessage, { exact: true })).toBeVisible()
    await expect.poll(() => toneCount(page)).toBe(beforeOtherMessage + 1)

    await page.waitForTimeout(350)
    const beforeOwnMessage = await toneCount(page)
    const ownMessage = `自己静默检查 ${Date.now()}`
    await page.getByPlaceholder('发送消息到 #文字聊天').fill(ownMessage)
    await page.getByTitle('发送消息').click()
    await expect(page.getByText(ownMessage, { exact: true })).toBeVisible()
    await page.waitForTimeout(150)
    expect(await toneCount(page)).toBe(beforeOwnMessage)
  } finally {
    await other.dispose()
  }
})

test('退出登录使用明确的二次确认弹窗', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  const logoutTrigger = page.getByTitle('退出登录')
  const dialog = page.getByRole('alertdialog', { name: '退出登录？' })
  const cancel = page.getByRole('button', { name: '取消', exact: true })

  await logoutTrigger.click()
  await expect(dialog).toBeVisible()
  await expect(cancel).toBeFocused()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()

  await logoutTrigger.click()
  await expect(dialog).toBeHidden()
  await expect(logoutTrigger).toBeFocused()

  await logoutTrigger.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(logoutTrigger).toBeFocused()

  await logoutTrigger.click()
  await page.locator('.server-title').click({ position: { x: 8, y: 8 } })
  await expect(dialog).toBeHidden()

  await logoutTrigger.click()
  await cancel.click()
  await expect(dialog).toBeHidden()
  await expect(logoutTrigger).toBeFocused()

  await page.route('**/api/auth/logout', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.continue()
  })
  await logoutTrigger.click()
  const confirm = dialog.getByRole('button', { name: '退出', exact: true })
  await confirm.click()
  await expect(dialog.getByRole('button', { name: '正在退出', exact: true })).toBeDisabled()
  await expect(cancel).toBeDisabled()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
})

test('消息历史分页使用虚拟列表并保持阅读位置', async ({ page }) => {
  let newestID = 0
  let currentUser = { id: 0, username: '', displayName: '', role: 'member' }
  const makeMessage = (id: number, content: string) => ({
    id,
    userId: currentUser.id,
    username: currentUser.username,
    displayName: currentUser.displayName,
    role: currentUser.role,
    content,
    createdAt: new Date(Date.now() - (newestID - id) * 1000).toISOString(),
  })

  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    currentUser = payload.user
    newestID = payload.messages.at(-1)?.id ?? 0
    const messages = Array.from({ length: 50 }, (_, index) => {
      const id = newestID - 49 + index
      return makeMessage(id, `虚拟消息 ${id}`)
    })
    await route.fulfill({ response, json: { ...payload, messages, messagesHasMore: true, settings: { ...payload.settings, messageRetention: 500 } } })
  })
  await page.route('**/api/messages?**', async (route) => {
    const before = Number(new URL(route.request().url()).searchParams.get('before'))
    const messages = Array.from({ length: 50 }, (_, index) => {
      const id = before - 50 + index
      return makeMessage(id, `虚拟消息 ${id}`)
    })
    await route.fulfill({ json: { messages, hasMore: false } })
  })

  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  const messageList = page.locator('.message-list')
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByText(`虚拟消息 ${newestID}`, { exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.message-row').count()).toBeLessThan(40)

  await messageList.evaluate((element) => { element.scrollTop = 0 })
  const loadEarlier = page.getByRole('button', { name: '加载更早消息' })
  await expect(loadEarlier).toBeVisible()
  const anchor = page.getByText(`虚拟消息 ${newestID - 49}`, { exact: true })
  const anchorTop = await anchor.evaluate((element) => element.getBoundingClientRect().top)
  await loadEarlier.click()
  await expect(anchor).toBeVisible()
  await expect.poll(() => anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(anchorTop, 0)
  await expect.poll(() => page.locator('.message-row').count()).toBeLessThan(40)

  await messageList.evaluate((element) => { element.scrollTop = 0 })
  await expect(page.getByText('这是 Celery Web Speak 频道的开始。')).toBeVisible()
  await expect(loadEarlier).toBeHidden()
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()

  const realtimeMessage = `未读消息检查 ${Date.now()}`
  await page.getByPlaceholder('发送消息到 #文字聊天').fill(realtimeMessage)
  await page.getByTitle('发送消息').click()
  const jumpToLatest = page.getByRole('button', { name: /条新消息/ })
  await expect(jumpToLatest).toBeVisible()
  await jumpToLatest.click()
  await expect(page.getByText(realtimeMessage, { exact: true })).toBeVisible()
  await expect(page.locator('.jump-to-latest')).toBeHidden()
})

test('成员列表按钮在桌面和中等宽度均可切换面板', async ({ page, isMobile }) => {
  test.skip(isMobile, '由桌面项目覆盖宽屏和中等宽度布局')
  const memberButton = page.getByRole('button', { name: /成员列表/ })
  const permanentList = page.locator('.app-shell > .member-list')
  const channelSidebar = page.locator('.app-shell > .channel-sidebar')

  await expect(permanentList).toBeVisible()
  await expect(channelSidebar).toHaveCSS('width', '280px')
  await expect(channelSidebar.locator('.current-user small')).toHaveText('未连接语音')
  await expect.poll(() => channelSidebar.locator('.current-user small').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(memberButton).toHaveAttribute('aria-pressed', 'true')
  await memberButton.click()
  await expect(permanentList).toBeHidden()
  await expect(memberButton).toHaveAttribute('aria-pressed', 'false')
  const collapsedLayout = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')!.getBoundingClientRect()
    const chat = document.querySelector('.chat-pane')!.getBoundingClientRect()
    return { shellRight: shell.right, chatRight: chat.right }
  })
  expect(Math.abs(collapsedLayout.shellRight - collapsedLayout.chatRight)).toBeLessThan(2)

  await memberButton.click()
  await expect(permanentList).toBeVisible()
  await page.setViewportSize({ width: 1140, height: 800 })
  await expect(channelSidebar).toBeVisible()
  await expect(channelSidebar).toHaveCSS('width', '280px')
  await expect(permanentList).toBeHidden()
  await expect(memberButton).toHaveAttribute('aria-pressed', 'false')
  await memberButton.click()
  await expect(page.locator('.member-list.drawer')).toBeVisible()
  await expect(page.locator('.drawer-header strong')).toHaveText('成员')
  const intermediateViewport = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(intermediateViewport.width).toBeLessThanOrEqual(intermediateViewport.client)
  await page.locator('.member-list.drawer').getByTitle('关闭').click()
  await expect(page.locator('.member-list.drawer')).toBeHidden()
})

test('管理控制台外框不随页签内容变化', async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 412 : 1200, height: isMobile ? 800 : 900 })
  const adminButton = page.getByText('管理控制台', { exact: true })
  if (!(await adminButton.isVisible())) await page.getByTitle('频道').click()
  await adminButton.click()

  const panel = page.locator('.admin-panel')
  const panelSize = () => panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  const channelSize = await panelSize()

  await page.getByRole('button', { name: '成员', exact: true }).click()
  expect(await panelSize()).toEqual(channelSize)
  await page.getByRole('button', { name: '账号与邀请', exact: true }).click()
  expect(await panelSize()).toEqual(channelSize)

  if (isMobile) {
    expect(channelSize).toEqual({ width: 412, height: 800 })
  } else {
    expect(channelSize).toEqual({ width: 980, height: 820 })
    await page.setViewportSize({ width: 1200, height: 800 })
    await expect.poll(panelSize).toEqual({ width: 1200, height: 800 })
    await page.setViewportSize({ width: 1200, height: 900 })
    await expect.poll(panelSize).toEqual({ width: 980, height: 820 })
  }
})

test('服务器管理员可通过登录名确认删除账号', async ({ page, request, browser, isMobile }, testInfo) => {
  await request.post('/api/auth/login', { data: { username, password } })
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `delete_${suffix}`,
    displayName: `待删除账号${suffix.slice(-3)}`,
    password: 'delete-member-password',
    role: 'member',
  }
  const createResponse = await request.post('/api/admin/users', { data: account })
  expect(createResponse.ok()).toBeTruthy()
  const created = await createResponse.json() as { user: { id: number } }

  const target = await browser.newContext({ baseURL })
  const targetPage = await target.newPage()
  const historicalMessage = `账号删除消息 ${suffix}`
  try {
    await targetPage.goto('/')
    await targetPage.getByLabel('登录名').fill(account.username)
    await targetPage.getByLabel('密码').fill(account.password)
    await targetPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect(targetPage.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    await targetPage.getByPlaceholder('发送消息到 #文字聊天').fill(historicalMessage)
    await targetPage.getByTitle('发送消息').click()
    await expect(page.getByText(historicalMessage, { exact: true })).toBeVisible()

    const adminButton = page.getByText('管理控制台', { exact: true })
    if (!(await adminButton.isVisible())) await page.getByTitle('频道').click()
    await adminButton.click()
    await page.getByRole('button', { name: '成员', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(account.displayName) }).click()
    await page.getByRole('button', { name: '删除账号', exact: true }).click()

    const dialog = page.getByRole('alertdialog', { name: '永久删除账号？' })
    await expect(dialog).toBeVisible()
    const confirmButton = dialog.getByRole('button', { name: '永久删除', exact: true })
    await expect(confirmButton).toBeDisabled()
    const confirmation = dialog.getByRole('textbox')
    await confirmation.fill(`${account.username}_wrong`)
    await expect(confirmButton).toBeDisabled()
    await confirmation.fill(account.username)
    await expect(confirmButton).toBeEnabled()
    await confirmButton.click()

    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: new RegExp(account.displayName) })).toHaveCount(0)
    await expect(targetPage.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    await page.getByTitle('关闭').last().click()
    const messageRow = page.locator('.message-row').filter({ hasText: historicalMessage })
    await expect(messageRow.getByText('已删除用户', { exact: true })).toBeVisible()

    const revokedSession = await target.request.get('/api/me')
    expect(revokedSession.status()).toBe(401)
    const deletedLogin = await target.request.post('/api/auth/login', { data: { username: account.username, password: account.password } })
    expect(deletedLogin.status()).toBe(401)
    const replacementResponse = await request.post('/api/admin/users', { data: { ...account, displayName: '同名新账号' } })
    expect(replacementResponse.ok()).toBeTruthy()
    const replacement = await replacementResponse.json() as { user: { id: number } }
    expect(replacement.user.id).not.toBe(created.user.id)
  } finally {
    await target.close()
  }
})

async function installToneCounter(page: import('@playwright/test').Page) {
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

async function toneCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as typeof window & { __cwsToneCount?: number }).__cwsToneCount ?? 0)
}

test('管理控制台成员列表和详情分别滚动', async ({ page, isMobile }) => {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const users = [
      payload.user,
      ...Array.from({ length: 40 }, (_, index) => ({
        id: 10_000 + index,
        username: `scroll-member-${index + 1}`,
        displayName: `滚动测试成员 ${String(index + 1).padStart(2, '0')}`,
        role: 'member',
        voiceMuted: false,
        textMuted: false,
        permanentlyBanned: false,
        createdAt: new Date().toISOString(),
      })),
    ]
    await route.fulfill({ response, json: { ...payload, users } })
  })

  await page.setViewportSize({ width: isMobile ? 412 : 1200, height: 600 })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  const adminButton = page.getByText('管理控制台', { exact: true })
  if (!(await adminButton.isVisible())) await page.getByTitle('频道').click()
  await adminButton.click()
  await page.getByRole('button', { name: '成员', exact: true }).click()

  const content = page.locator('.admin-content')
  const list = page.locator('.admin-user-list')
  const detail = page.locator('.user-admin-detail')
  await expect(list).toBeVisible()
  await expect(detail).toBeVisible()

  const layout = await page.evaluate(() => {
    const contentElement = document.querySelector<HTMLElement>('.admin-content')!
    const listElement = document.querySelector<HTMLElement>('.admin-user-list')!
    const detailElement = document.querySelector<HTMLElement>('.user-admin-detail')!
    const listRect = listElement.getBoundingClientRect()
    const detailRect = detailElement.getBoundingClientRect()
    return {
      contentOverflow: getComputedStyle(contentElement).overflowY,
      listCanScroll: listElement.scrollHeight > listElement.clientHeight,
      detailCanScroll: detailElement.scrollHeight > detailElement.clientHeight,
      listOverscroll: getComputedStyle(listElement).overscrollBehaviorY,
      detailOverscroll: getComputedStyle(detailElement).overscrollBehaviorY,
      listRect: { top: listRect.top, right: listRect.right, bottom: listRect.bottom },
      detailRect: { top: detailRect.top, left: detailRect.left, bottom: detailRect.bottom },
    }
  })
  expect(layout.contentOverflow).toBe('hidden')
  expect(layout.listCanScroll).toBe(true)
  expect(layout.detailCanScroll).toBe(true)
  expect(layout.listOverscroll).toBe('contain')
  expect(layout.detailOverscroll).toBe('contain')
  if (isMobile) {
    expect(layout.listRect.bottom).toBeLessThanOrEqual(layout.detailRect.top)
  } else {
    expect(layout.listRect.right).toBeLessThanOrEqual(layout.detailRect.left)
    expect(Math.abs(layout.listRect.top - layout.detailRect.top)).toBeLessThan(2)
    expect(Math.abs(layout.listRect.bottom - layout.detailRect.bottom)).toBeLessThan(2)
  }

  await list.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await detail.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const listScrollTop = await list.evaluate((element) => element.scrollTop)
  expect(listScrollTop).toBeGreaterThan(0)
  expect(await detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.locator('.admin-user-list button').last().click()
  await expect.poll(() => detail.evaluate((element) => element.scrollTop)).toBe(0)
  expect(await list.evaluate((element) => element.scrollTop)).toBeCloseTo(listScrollTop, 0)
  await expect(content).toHaveClass(/users-content/)
})

test('邀请码列表关联原码、分页并可永久删除', async ({ page }) => {
  const now = Date.now()
  const activeInvite = {
    id: 91001,
    code: 'active-invite-code',
    maxUses: 5,
    useCount: 1,
    expiresAt: new Date(now + 86_400_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
    createdBy: 1,
  }
  const legacyInvite = {
    id: 91000,
    maxUses: 2,
    useCount: 0,
    expiresAt: new Date(now + 86_400_000).toISOString(),
    revokedAt: new Date(now - 30_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(),
    createdBy: 1,
  }
  const expiredInvite = {
    id: 90999,
    code: 'expired-invite-code',
    maxUses: 1,
    useCount: 0,
    expiresAt: new Date(now - 86_400_000).toISOString(),
    createdAt: new Date(now - 180_000).toISOString(),
    createdBy: 1,
  }
  let listRequests = 0
  let deleted = false

  await page.route('**/api/admin/invites**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'DELETE') {
      expect(url.pathname).toBe(`/api/admin/invites/${activeInvite.id}/permanent`)
      deleted = true
      await route.fulfill({ status: 204 })
      return
    }
    if (request.method() !== 'GET') {
      await route.continue()
      return
    }
    listRequests += 1
    if (deleted) {
      await route.fulfill({ json: { invites: [legacyInvite], hasMore: false, nextCursor: '' } })
    } else if (url.searchParams.has('cursor')) {
      await route.fulfill({ json: { invites: [expiredInvite], hasMore: false, nextCursor: '' } })
    } else {
      await route.fulfill({ json: { invites: [activeInvite, legacyInvite], hasMore: true, nextCursor: 'next-page' } })
    }
  })

  const adminButton = page.getByText('管理控制台', { exact: true })
  if (!(await adminButton.isVisible())) await page.getByTitle('频道').click()
  await adminButton.click()
  await page.getByRole('button', { name: '账号与邀请', exact: true }).click()

  const rows = page.locator('.invite-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('active-invite-code')
  await expect(rows.first()).toContainText('有效')
  await expect(rows.nth(1)).toContainText('旧邀请码 #91000（原码不可恢复）')
  await expect(rows.nth(1)).toContainText('已撤销')
  expect(listRequests).toBe(1)

  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2)).toContainText('expired-invite-code')
  await expect(rows.nth(2)).toContainText('已过期')
  expect(listRequests).toBe(2)

  page.once('dialog', (dialog) => dialog.accept())
  await rows.first().getByTitle('永久删除邀请码').click()
  await expect(page.getByText('active-invite-code', { exact: true })).toBeHidden()
  await expect(page.getByText('邀请码已永久删除', { exact: true })).toBeVisible()
  expect(deleted).toBe(true)
})

test('空邀请码列表兼容 null 响应', async ({ page }) => {
  await page.route('**/api/admin/invites**', (route) => route.fulfill({
    json: { invites: null, hasMore: false, nextCursor: '' },
  }))

  const adminButton = page.getByText('管理控制台', { exact: true })
  if (!(await adminButton.isVisible())) await page.getByTitle('频道').click()
  await adminButton.click()
  await page.getByRole('button', { name: '账号与邀请', exact: true }).click()

  await expect(page.getByText('暂无邀请码', { exact: true })).toBeVisible()
  await expect(page.locator('.invite-row')).toHaveCount(0)
})

test('窄屏频道与成员抽屉不溢出', async ({ page, isMobile }) => {
  test.skip(!isMobile, '仅在移动端项目运行')
  await page.getByTitle('频道').click()
  await expect(page.getByText('Celery Web Speak', { exact: true }).last()).toBeVisible()
  await page.getByTitle('关闭').click()
  await page.getByRole('button', { name: /成员列表/ }).click()
  await expect(page.locator('.drawer-header strong')).toHaveText('成员')
  const viewport = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(viewport.width).toBeLessThanOrEqual(viewport.client)
})
