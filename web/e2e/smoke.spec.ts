import { expect, request as createRequestContext, test, type Page } from '@playwright/test'
import { createServerMember, deletePlatformUser, firstJoinedServerID } from './api-helpers'

const username = process.env.E2E_USERNAME ?? 'admin'
const password = process.env.E2E_PASSWORD ?? 'admin-password-123'
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'

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

async function openCurrentServerActions(page: Page) {
  const trigger = page.getByTitle('服务器操作')
  if (!(await trigger.isVisible())) await page.getByTitle('频道', { exact: true }).click()
  await trigger.click()
  const menu = page.getByRole('menu', { name: /的服务器操作$/ })
  await expect(menu).toBeVisible()
  return menu
}

async function openServerAdmin(page: Page) {
  const menu = await openCurrentServerActions(page)
  await menu.getByRole('menuitem', { name: '管理控制台', exact: true }).click()
  await expect(page.getByRole('heading', { name: '服务器管理' })).toBeVisible()
}

async function openPlatformAccounts(page: Page) {
  const platformButton = page.locator('button[title="平台服务器管理"]:visible')
  if (!(await platformButton.isVisible()) && await page.getByTitle('频道', { exact: true }).isVisible()) await page.getByTitle('频道', { exact: true }).click()
  if (await platformButton.isVisible()) await platformButton.click()
  else {
    const menu = await openCurrentServerActions(page)
    await menu.getByRole('menuitem', { name: '平台服务器管理', exact: true }).click()
  }
  await page.getByTitle('平台账号与邀请码').click()
  await expect(page.getByRole('heading', { name: '平台管理' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('登录名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
})

test('浏览器图标与服务器切换栏可用', async ({ page, isMobile }) => {
  const favicon = page.locator('link[rel="icon"]')
  await expect(favicon).toHaveAttribute('href', '/favicon.svg')
  await expect(favicon).toHaveAttribute('sizes', 'any')

  const serverButton = page.locator('.server-button').filter({ has: page.locator('.server-initial') }).first()
  await expect(serverButton).toBeVisible()
  const bounds = await serverButton.boundingBox()
  expect(bounds?.width).toBe(46)
  expect(bounds?.height).toBe(46)

  if (isMobile) {
    await expect(page.getByLabel('切换服务器')).toHaveCount(0)
    await expect.poll(() => page.locator('.server-rail').evaluate((element) => element.getBoundingClientRect().width)).toBe(56)
    await serverButton.click()
    const drawer = page.locator('.channel-sidebar.mobile-drawer-open')
    await expect(drawer).toBeVisible()
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left)).toBe(56)
    await serverButton.click()
    await expect(drawer).toHaveCount(0)
    await page.getByTitle('频道', { exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect.poll(() => page.locator('.drawer-scrim').evaluate((element) => element.getBoundingClientRect().left)).toBe(56)
  }
})

test('移动端切换其他服务器后自动打开频道抽屉', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, '仅在移动端项目运行')
  await request.post('/api/auth/login', { data: { username, password } })
  const serverName = `移动切换${Date.now().toString(36).slice(-5)}`
  const createResponse = await request.post('/api/platform/servers', { data: { name: serverName, ownerUsername: username } })
  expect(createResponse.ok()).toBeTruthy()
  const server = (await createResponse.json() as { server: { id: number } }).server

  try {
    await page.reload()
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    const changelog = page.getByRole('dialog', { name: '更新日志' })
    if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
    const serverButton = page.getByTitle(serverName, { exact: true })
    await expect(serverButton).toBeVisible()
    await serverButton.click()
    const drawer = page.locator('.channel-sidebar.mobile-drawer-open')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.server-title strong')).toHaveText(serverName)
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left)).toBe(56)
    await serverButton.click()
    await expect(drawer).toHaveCount(0)
  } finally {
    const response = await request.delete(`/api/platform/servers/${server.id}`)
    expect(response.ok()).toBeTruthy()
  }
})

test('语音工具栏按职责分栏并持久化 DTX 模式', async ({ page, isMobile }) => {
  await expect(page.locator('.user-controls')).toHaveCount(0)
  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await setSyntheticVoiceConnection(page)

  const connectionPanel = page.locator('.voice-connection-panel')
  const toolbar = page.locator('.user-controls')
  const modeButton = toolbar.locator('.transmission-mode-button')
  const modeTooltip = toolbar.locator('.transmission-mode-tooltip')
  const controlButtons = toolbar.locator('.control-buttons')
  await expect(connectionPanel).toBeVisible()
  await expect(connectionPanel.locator('button')).toHaveCount(0)
  await expect(toolbar).toBeVisible()
  await expect(modeButton).toHaveAccessibleName('当前模式：语音感应；切换为持续传输')
  await expect(modeButton).not.toHaveAttribute('aria-pressed')
  await expect(modeButton).not.toHaveAttribute('title')
  await expect(modeTooltip).toHaveText('切换为持续传输')
  await expect(modeTooltip).toHaveCSS('visibility', 'hidden')
  await expect(toolbar.getByTitle('断开语音', { exact: true })).toHaveClass(/danger/)

  const layout = await toolbar.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const mode = element.querySelector('.transmission-mode-button')!.getBoundingClientRect()
    const controls = element.querySelector('.control-buttons')!.getBoundingClientRect()
    const modeButton = element.querySelector('.transmission-mode-button')!
    const modeColor = getComputedStyle(modeButton).color
    const modeBackground = getComputedStyle(modeButton, '::before')
    return {
      modeLeft: mode.left - bounds.left,
      modeWidth: mode.width,
      modeHeight: mode.height,
      modeBackgroundHeight: Number.parseFloat(modeBackground.height),
      modeBackgroundOpacity: modeBackground.opacity,
      gap: controls.left - mode.right,
      controlsLeft: controls.left,
      controlsRight: bounds.right - controls.right,
      modeUsesTextColor: modeColor === getComputedStyle(document.body).color,
    }
  })
  expect(layout.modeLeft).toBeGreaterThanOrEqual(7)
  expect(layout.modeWidth).toBeLessThan(100)
  expect(layout.modeHeight).toBe(44)
  expect(layout.modeBackgroundHeight).toBe(34)
  expect(layout.modeBackgroundOpacity).toBe('0')
  expect(layout.gap).toBeGreaterThanOrEqual(0)
  expect(layout.controlsRight).toBeGreaterThanOrEqual(7)
  expect(layout.modeUsesTextColor).toBe(true)
  await expect(controlButtons).toBeVisible()

  await page.keyboard.press('Tab')
  await modeButton.focus()
  await expect(modeTooltip).toHaveCSS('visibility', 'visible')
  await expect.poll(() => modeButton.evaluate((element) => getComputedStyle(element, '::before').opacity)).toBe('1')
  if (!isMobile) {
    await modeButton.evaluate((element: HTMLButtonElement) => element.blur())
    await page.locator('.voice-connection-panel').hover()
    await expect(modeTooltip).toHaveCSS('visibility', 'hidden')
    await expect.poll(() => modeButton.evaluate((element) => getComputedStyle(element, '::before').opacity)).toBe('0')
    await modeButton.hover()
    await expect(modeTooltip).toHaveCSS('visibility', 'visible')
    await expect.poll(() => modeButton.evaluate((element) => getComputedStyle(element, '::before').opacity)).toBe('1')
  }

  if (isMobile) {
    await modeButton.evaluate((element: HTMLButtonElement) => element.blur())
    await modeButton.tap()
  } else {
    await modeButton.click()
  }
  const continuousButton = toolbar.locator('.transmission-mode-button')
  await expect(continuousButton).toHaveAccessibleName('当前模式：持续传输；切换为语音感应')
  await expect(modeTooltip).toHaveText('切换为语音感应')
  const continuousLayout = await toolbar.evaluate((element) => {
    const mode = element.querySelector('.transmission-mode-button')!.getBoundingClientRect()
    const controls = element.querySelector('.control-buttons')!.getBoundingClientRect()
    return {
      modeColor: getComputedStyle(element.querySelector('.transmission-mode-button')!).color,
      modeWidth: mode.width,
      controlsLeft: controls.left,
    }
  })
  expect(continuousLayout.modeColor).toBe(await page.evaluate(() => getComputedStyle(document.body).color))
  expect(continuousLayout.modeWidth).toBeLessThan(100)
  expect(continuousLayout.controlsLeft).toBeCloseTo(layout.controlsLeft, 1)
  if (isMobile) {
    await expect.poll(() => continuousButton.evaluate((element) => getComputedStyle(element, '::before').opacity)).toBe('0')
  }
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('continuous')

  await page.reload()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await setSyntheticVoiceConnection(page)
  await expect(page.locator('.transmission-mode-button')).toHaveAccessibleName('当前模式：持续传输；切换为语音感应')

  await page.getByTitle('断开语音', { exact: true }).click()
  await expect(page.locator('.user-controls')).toHaveCount(0)
  await expect(page.locator('.voice-connection-panel')).toHaveCount(0)
})

test('服务器操作菜单集中展示当前角色可用操作', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await expect(page.locator('.channel-scroll').getByText('管理控制台', { exact: true })).toHaveCount(0)
  await expect(page.locator('.channel-scroll').getByText('离开服务器', { exact: true })).toHaveCount(0)

  const trigger = page.getByTitle('服务器操作')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const menu = page.getByRole('menu', { name: /的服务器操作$/ })
  await expect(menu.getByRole('menuitem', { name: '管理控制台', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '平台服务器管理', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '离开服务器', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()

  if (!isMobile) {
    const serverButton = page.locator('.server-button').filter({ has: page.locator('.server-initial') }).first()
    await serverButton.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await serverButton.focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
  } else {
    await expect(page.locator('.server-rail button[title="平台服务器管理"]')).toBeVisible()
    await expect(page.getByLabel('切换服务器')).toHaveCount(0)
    const titleLayout = await page.locator('.server-title').evaluate((element) => {
      const children = Array.from(element.children).filter((child) => getComputedStyle(child).display !== 'none')
      return children.map((child) => {
        const bounds = child.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
      })
    })
    for (let index = 1; index < titleLayout.length; index++) {
      const previous = titleLayout[index - 1]
      const current = titleLayout[index]
      const sameRow = Math.abs(previous.top - current.top) < 2
      if (sameRow) expect(current.left).toBeGreaterThanOrEqual(previous.right - 1)
    }
  }
})

test('普通成员离开服务器前看到明确后果且失败时保留对话框', async ({ page, request, browser, isMobile }, testInfo) => {
  await request.post('/api/auth/login', { data: { username, password } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `leave_${suffix}`,
    displayName: `离开菜单成员${suffix.slice(-3)}`,
    password: 'leave-member-password',
  }
  const member = await createServerMember(request, serverID, account)
  const target = await browser.newContext({ baseURL })
  const targetPage = await target.newPage()
  try {
    await targetPage.goto('/')
    await targetPage.getByLabel('登录名').fill(account.username)
    await targetPage.getByLabel('密码').fill(account.password)
    await targetPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect(targetPage.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    const changelog = targetPage.getByRole('dialog', { name: '更新日志' })
    if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()

    const menu = await openCurrentServerActions(targetPage)
    await expect(menu.getByRole('menuitem')).toHaveCount(1)
    const leaveItem = menu.getByRole('menuitem', { name: '离开服务器', exact: true })
    await expect(leaveItem).toHaveClass(/danger/)
    await leaveItem.click()

    const dialog = targetPage.getByRole('alertdialog', { name: /离开“.+”？/ })
    await expect(dialog).toContainText('你的成员身份将被移除，之后需要由服务器管理员重新添加。')
    await expect(dialog).toContainText('你发送的历史消息不会被删除。')
    const leaveButton = dialog.getByRole('button', { name: '离开服务器', exact: true })
    const buttonLayout = await leaveButton.evaluate((button) => {
      const icon = button.querySelector('svg')
      const buttonStyle = getComputedStyle(button)
      if (!icon) return null
      const buttonBounds = button.getBoundingClientRect()
      const iconBounds = icon.getBoundingClientRect()
      return {
        alignItems: buttonStyle.alignItems,
        iconCenterOffset: Math.abs(
          iconBounds.top + iconBounds.height / 2 - (buttonBounds.top + buttonBounds.height / 2),
        ),
      }
    })
    expect(buttonLayout).not.toBeNull()
    expect(buttonLayout?.alignItems).toBe('center')
    expect(buttonLayout?.iconCenterOffset).toBeLessThanOrEqual(1)
    await targetPage.route(`**/api/servers/${serverID}/leave`, (route) => route.fulfill({
      status: 500,
      json: { error: 'test_failure', message: '测试离开失败' },
    }))
    await leaveButton.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveText('测试离开失败')
    await expect.poll(async () => {
      const response = await target.request.get('/api/bootstrap')
      const payload = await response.json() as { servers: Array<{ id: number; joined: boolean }> }
      return payload.servers.some((server) => server.id === serverID && server.joined)
    }).toBe(true)

    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toBeHidden()
    await targetPage.unroute(`**/api/servers/${serverID}/leave`)
    const reopenedMenu = await openCurrentServerActions(targetPage)
    await reopenedMenu.getByRole('menuitem', { name: '离开服务器', exact: true }).click()
    await targetPage.getByRole('alertdialog').getByRole('button', { name: '离开服务器', exact: true }).click()
    await expect(targetPage.getByRole('alertdialog')).toBeHidden()
    await expect(targetPage.getByTitle('服务器操作')).toHaveCount(0)
    const bootstrapResponse = await target.request.get('/api/bootstrap')
    const bootstrap = await bootstrapResponse.json() as { servers: Array<{ joined: boolean }> }
    expect(bootstrap.servers.some((server) => server.joined)).toBe(false)
  } finally {
    await target.close()
    const response = await deletePlatformUser(request, member.id, account.username)
    expect(response.ok()).toBeTruthy()
  }
})

test('右键离开非当前服务器后保持当前服务器', async ({ request, browser }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('android'), '服务器栏右键菜单仅在桌面布局显示')
  await request.post('/api/auth/login', { data: { username, password } })
  const firstServerID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.workerIndex}`
  const account = {
    username: `leave_other_${suffix}`,
    displayName: `非当前离开成员${suffix.slice(-3)}`,
    password: 'leave-other-password',
  }
  const member = await createServerMember(request, firstServerID, account)
  const serverName = `非当前服务器${suffix.slice(-5)}`
  const createResponse = await request.post('/api/platform/servers', { data: { name: serverName, ownerUsername: username } })
  expect(createResponse.ok()).toBeTruthy()
  const secondServer = (await createResponse.json() as { server: { id: number } }).server
  const addResponse = await request.post(`/api/servers/${secondServer.id}/members`, { data: { username: account.username } })
  expect(addResponse.ok()).toBeTruthy()

  const target = await browser.newContext({ baseURL })
  const targetPage = await target.newPage()
  try {
    await targetPage.goto('/')
    await targetPage.getByLabel('登录名').fill(account.username)
    await targetPage.getByLabel('密码').fill(account.password)
    await targetPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect(targetPage.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    const changelog = targetPage.getByRole('dialog', { name: '更新日志' })
    if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
    const originalServerName = await targetPage.locator('.server-title strong').textContent()

    await targetPage.getByTitle(serverName).click({ button: 'right' })
    const menu = targetPage.getByRole('menu', { name: `${serverName}的服务器操作` })
    await menu.getByRole('menuitem', { name: '离开服务器', exact: true }).click()
    const dialog = targetPage.getByRole('alertdialog', { name: `离开“${serverName}”？` })
    await dialog.getByRole('button', { name: '离开服务器', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(targetPage.locator('.server-title strong')).toHaveText(originalServerName ?? '')
    await expect(targetPage.getByTitle(serverName)).toHaveCount(0)
  } finally {
    await target.close()
    const deleteServerResponse = await request.delete(`/api/platform/servers/${secondServer.id}`)
    expect(deleteServerResponse.ok()).toBeTruthy()
    const deleteUserResponse = await deletePlatformUser(request, member.id, account.username)
    expect(deleteUserResponse.ok()).toBeTruthy()
  }
})

test('登录、聊天和管理员设置可用', async ({ page }) => {
  const message = `端到端检查 ${Date.now()}`
  await page.getByPlaceholder('发送消息到 #文字聊天').fill(message)
  await page.getByTitle('发送消息').click()
  await expect(page.getByText(message)).toBeVisible()

  await openServerAdmin(page)
  await page.getByLabel('选择频道').selectOption({ label: '语音 语音频道' })
  await expect(page.getByText('Opus 发送码率')).toBeVisible()
  await expect(page.getByLabel('语音 RED 丢包冗余')).toBeChecked()
  await expect(page.getByLabel('背景音 RED 丢包冗余')).not.toBeChecked()
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

test('临时封禁状态在刷新后可见并可提前解除', async ({ page, request }, testInfo) => {
  await request.post('/api/auth/login', { data: { username, password } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `temporary_ban_${suffix}`,
    displayName: `临时封禁成员${suffix.slice(-3)}`,
    password: 'member-password-123',
  }
  const member = await createServerMember(request, serverID, account)
  try {
    const banResponse = await request.patch(`/api/servers/${serverID}/members/${member.id}/ban`, {
      data: { banned: false, temporaryBanUntil: new Date(Date.now() + 30 * 60_000).toISOString() },
    })
    expect(banResponse.ok()).toBeTruthy()

    await page.reload()
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    await openServerAdmin(page)
    await page.getByRole('button', { name: '成员', exact: true }).click()
    await page.locator('.admin-user-list button').filter({ hasText: account.displayName }).click()
    const clearButton = page.getByRole('button', { name: '解除临时封禁', exact: true })
    await expect(clearButton).toBeVisible()
    await clearButton.click()
    await expect(clearButton).toHaveCount(0)
  } finally {
    const response = await deletePlatformUser(request, member.id, account.username)
    expect(response.ok()).toBeTruthy()
  }
})

test('WebSocket 重同步的旧服务器响应不会覆盖当前服务器', async ({ page, request, isMobile }) => {
  test.skip(isMobile, '桌面项目覆盖服务器切换的可控乱序响应')
  await request.post('/api/auth/login', { data: { username, password } })
  const firstServerID = await firstJoinedServerID(request)
  const secondServerName = `重同步服务器${Date.now().toString(36).slice(-5)}`
  const createResponse = await request.post('/api/platform/servers', { data: { name: secondServerName, ownerUsername: username } })
  expect(createResponse.ok()).toBeTruthy()
  const secondServer = (await createResponse.json() as { server: { id: number } }).server
  let releaseDelayedResponse = () => {}
  try {
    await expect(page.getByTitle(secondServerName)).toBeVisible()
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket
      const sockets: WebSocket[] = []
      class CapturedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          sockets.push(this)
        }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: CapturedWebSocket })
      ;(window as typeof window & { __cwsSockets?: WebSocket[] }).__cwsSockets = sockets
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()

    let markDelayedRequest = () => {}
    const delayedRequest = new Promise<void>((resolve) => { markDelayedRequest = resolve })
    const release = new Promise<void>((resolve) => { releaseDelayedResponse = resolve })
    let markDelayedResponseComplete = () => {}
    const delayedResponseComplete = new Promise<void>((resolve) => { markDelayedResponseComplete = resolve })
    let delayNextBootstrap = true
    await page.route(`**/api/servers/${firstServerID}/bootstrap`, async (route) => {
      if (!delayNextBootstrap) {
        await route.continue()
        return
      }
      delayNextBootstrap = false
      const response = await route.fetch()
      markDelayedRequest()
      await release
      await route.fulfill({ response })
      markDelayedResponseComplete()
    })

    await page.evaluate(() => {
      const sockets = (window as typeof window & { __cwsSockets?: WebSocket[] }).__cwsSockets ?? []
      sockets.at(-1)?.close(4000, 'test resynchronization')
    })
    await delayedRequest
    await page.getByTitle(secondServerName).click()
    await expect(page.locator('.server-title strong')).toHaveText(secondServerName)
    releaseDelayedResponse()
    await delayedResponseComplete
    await expect(page.locator('.server-title strong')).toHaveText(secondServerName)
  } finally {
    releaseDelayedResponse()
    const response = await request.delete(`/api/platform/servers/${secondServer.id}`)
    expect(response.ok()).toBeTruthy()
  }
})

test('管理员可创建和删除独立文字频道', async ({ page, isMobile }) => {
  const channelName = `项目频道${Date.now().toString(36).slice(-5)}`
  const channelMessage = `频道隔离检查 ${Date.now()}`
  await openServerAdmin(page)
  await page.getByLabel('新频道名称').fill(channelName)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByLabel('选择频道')).toHaveValue(/\d+/)
  await page.getByTitle('关闭').last().click()

  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  const newChannel = page.getByRole('button', { name: new RegExp(channelName) })
  await expect(newChannel).toBeVisible()
  await newChannel.click()
  await expect(page.getByRole('heading', { name: channelName, exact: true })).toBeVisible()
  await page.getByPlaceholder(`发送消息到 #${channelName}`).fill(channelMessage)
  await page.getByTitle('发送消息').click()
  await expect(page.getByText(channelMessage, { exact: true })).toBeVisible()

  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await page.getByRole('button', { name: /文字聊天.*最近/ }).click()
  await expect(page.getByText(channelMessage, { exact: true })).toHaveCount(0)

  await openServerAdmin(page)
  await page.getByLabel('选择频道').selectOption({ label: `# ${channelName}` })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '永久删除', exact: true }).click()
  await expect(page.getByText('频道已永久删除')).toBeVisible()
  await page.getByTitle('关闭').last().click()
  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await expect(page.getByRole('button', { name: new RegExp(channelName) })).toHaveCount(0)
})

test('最新消息与文字输入框保持间距', async ({ page }) => {
  const message = `输入区间距检查 ${Date.now()}`
  await page.getByPlaceholder('发送消息到 #文字聊天').fill(message)
  await page.getByTitle('发送消息').click()

  const latestMessage = page.locator('.message-row').filter({ hasText: message })
  await expect(latestMessage).toBeVisible()
  await expect.poll(() => latestMessage.evaluate((element) => {
    const composer = document.querySelector('.composer')!.getBoundingClientRect()
    const messageRow = element.getBoundingClientRect()
    return composer.top - messageRow.bottom
  })).toBeGreaterThanOrEqual(16)
})

test('本地音量增益默认 100% 并持久化到浏览器', async ({ page, isMobile }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音频', exact: true }).click()
  await page.getByRole('button', { name: '输入', exact: true }).click()

  const microphoneGain = page.getByLabel('麦克风增益')
  await expect(microphoneGain).toHaveValue('1')
  await expect(microphoneGain).toHaveAttribute('max', '3')

  await microphoneGain.fill('2.5')
  await expect(page.getByText('250%', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.microphoneGain'))).toBe('2.5')

  await page.getByRole('button', { name: '输出', exact: true }).click()
  const outputVolume = page.getByLabel('扬声器音量')
  await expect(outputVolume).toHaveValue('1')
  await expect(outputVolume).toHaveAttribute('max', '3')
  await outputVolume.fill('1.5')
  await expect(page.getByText('150%', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.outputVolume'))).toBe('1.5')
})

test('紧凑视口下用户设置页签与内容不重叠', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面项目覆盖可调整高度的紧凑视口')
  await page.setViewportSize({ width: 720, height: 600 })
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()

  const layout = await page.locator('.settings-panel').evaluate((panel) => {
    const panelRect = panel.getBoundingClientRect()
    const [header, tabs, content] = Array.from(panel.children).map((element) => element.getBoundingClientRect())
    return {
      headerBottom: header.bottom,
      tabsTop: tabs.top,
      tabsBottom: tabs.bottom,
      tabsHeight: tabs.height,
      contentTop: content.top,
      contentBottom: content.bottom,
      panelBottom: panelRect.bottom,
    }
  })
  expect(layout.tabsTop).toBeGreaterThanOrEqual(layout.headerBottom - 1)
  expect(layout.tabsHeight).toBeGreaterThanOrEqual(40)
  expect(layout.contentTop).toBeGreaterThanOrEqual(layout.tabsBottom - 1)
  expect(layout.contentBottom).toBeLessThanOrEqual(layout.panelBottom + 1)
})

test('操作提示音默认开启并持久化到浏览器', async ({ page, isMobile }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()

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
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()
  await expect(page.getByLabel('启用提示音')).not.toBeChecked()
  await expect(page.getByLabel('提示音音量')).toHaveValue('0.35')
  await expect(page.getByLabel('加入语音')).not.toBeChecked()
  await expect(page.getByLabel('新文字消息')).not.toBeChecked()
})

test('主题模式与强调色持久化到浏览器', async ({ page, isMobile }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '主题', exact: true }).click()

  await page.getByRole('button', { name: '亮色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.theme.mode'))).toBe('light')

  await page.getByRole('button', { name: '绿色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'green')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.theme.accent'))).toBe('green')

  await page.getByRole('button', { name: '暗色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('音频处理开关持久化到浏览器', async ({ page, isMobile }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音频', exact: true }).click()

  const echoToggle = page.getByLabel('回声抑制')
  const noiseToggle = page.getByLabel('降噪')
  await expect(echoToggle).toBeChecked()
  await expect(noiseToggle).toBeChecked()

  await echoToggle.uncheck()
  await noiseToggle.uncheck()
  await expect.poll(() => page.evaluate(() => ({
    echo: localStorage.getItem('cws.echoCancellation'),
    noise: localStorage.getItem('cws.noiseSuppression'),
  }))).toEqual({ echo: 'false', noise: 'false' })
})

test('他人的新消息播放提示音，自己的消息不播放', async ({ page, request, isMobile }, testInfo) => {
  await installToneCounter(page)
  await expect(page.locator('.rail-status.online')).toBeAttached()

  await request.post('/api/auth/login', { data: { username, password } })
  const serverID = await firstJoinedServerID(request)
  const bootstrapResponse = await request.get(`/api/servers/${serverID}/bootstrap`)
  const bootstrap = await bootstrapResponse.json() as { channels: Array<{ id: number; type: string; name: string }> }
  const activeTextChannel = bootstrap.channels.find((channel) => channel.type === 'text')!
  const extraChannelName = `静默频道${Date.now().toString(36).slice(-5)}`
  const channelResponse = await request.post(`/api/servers/${serverID}/channels`, { data: { type: 'text', name: extraChannelName } })
  expect(channelResponse.ok()).toBeTruthy()
  const extraChannel = (await channelResponse.json() as { channel: { id: number } }).channel
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `sound_${suffix}`,
    displayName: `提示音测试${suffix.slice(-3)}`,
    password: 'sound-member-password',
    role: 'member',
  }
  await createServerMember(request, serverID, account)

  const other = await createRequestContext.newContext({ baseURL })
  try {
    const loginResponse = await other.post('/api/auth/login', { data: { username: account.username, password: account.password } })
    expect(loginResponse.ok()).toBeTruthy()
    if (isMobile) await page.waitForTimeout(700)
    if (isMobile) await page.getByTitle('频道', { exact: true }).click()
    await expect(page.getByRole('button', { name: new RegExp(extraChannelName) })).toBeAttached()
    const beforeInactiveMessage = await toneCount(page)
    const inactiveMessage = `非当前频道静默检查 ${Date.now()}`
    const inactiveResponse = await other.post(`/api/servers/${serverID}/channels/${extraChannel.id}/messages`, { data: { content: inactiveMessage } })
    expect(inactiveResponse.ok()).toBeTruthy()
    await expect(page.getByRole('button', { name: new RegExp(extraChannelName) }).locator('.channel-unread')).toHaveText('1')
    await page.waitForTimeout(150)
    expect(await toneCount(page)).toBe(beforeInactiveMessage)
    if (isMobile) await page.getByRole('button', { name: /文字聊天.*最近/ }).click()

    const beforeOtherMessage = await toneCount(page)
    const otherMessage = `他人提示音检查 ${Date.now()}`
    const sendResponse = await other.post(`/api/servers/${serverID}/channels/${activeTextChannel.id}/messages`, { data: { content: otherMessage } })
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
    await request.delete(`/api/servers/${serverID}/channels/${extraChannel.id}`)
  }
})

test('头像菜单集中账户操作且退出登录使用明确确认', async ({ page, isMobile }) => {
  const accountTrigger = page.getByTitle('用户账户')
  const dialog = page.getByRole('alertdialog', { name: '退出登录？' })
  const cancel = page.getByRole('button', { name: '取消', exact: true })

  await expect(accountTrigger.locator('.online-dot')).toHaveCount(1)
  if (isMobile) {
    await page.getByTitle('频道', { exact: true }).click()
    await expect(page.locator('.channel-sidebar.mobile-drawer-open')).toBeVisible()
  }
  let menu = await openAccountMenu(page)
  if (isMobile) await expect(page.locator('.channel-sidebar.mobile-drawer-open')).toHaveCount(0)
  const settingsItem = menu.getByRole('menuitem', { name: '用户设置', exact: true })
  const logoutItem = menu.getByRole('menuitem', { name: '退出登录', exact: true })
  await expect(settingsItem).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(logoutItem).toBeFocused()
  await expect(logoutItem).toHaveClass(/danger/)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(accountTrigger).toBeFocused()

  menu = await openAccountMenu(page)
  await menu.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(cancel).toBeFocused()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(accountTrigger).toBeFocused()

  menu = await openAccountMenu(page)
  await menu.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await cancel.click()
  await expect(dialog).toBeHidden()
  await expect(accountTrigger).toBeFocused()

  await page.route('**/api/auth/logout', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.continue()
  })
  menu = await openAccountMenu(page)
  await menu.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  const confirm = dialog.getByRole('button', { name: '退出', exact: true })
  await confirm.click()
  await expect(dialog.getByRole('button', { name: '正在退出', exact: true })).toBeDisabled()
  await expect(cancel).toBeDisabled()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
})

test('消息历史分页使用虚拟列表并保持阅读位置', async ({ page }) => {
  let newestID = 0
  let channelID = 0
  let currentUser = { id: 0, username: '', displayName: '', role: 'member' }
  const makeMessage = (id: number, content: string) => ({
    id,
    channelId: channelID,
    userId: currentUser.id,
    username: currentUser.username,
    displayName: currentUser.displayName,
    role: currentUser.role,
    content,
    createdAt: new Date(Date.now() - (newestID - id) * 1000).toISOString(),
  })

  await page.route('**/api/servers/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    currentUser = {
      id: payload.membership.userId,
      username: payload.membership.username,
      displayName: payload.membership.displayName,
      role: payload.membership.role,
    }
    channelID = payload.channels.find((channel: { type: string }) => channel.type === 'text').id
    newestID = 10_000
    await route.fulfill({ response, json: payload })
  })
  await page.route('**/api/servers/*/channels/*/messages?**', async (route) => {
    const url = new URL(route.request().url())
    const hasBefore = url.searchParams.has('before')
    const before = Number(url.searchParams.get('before'))
    const messages = Array.from({ length: 50 }, (_, index) => {
      const id = hasBefore ? before - 50 + index : newestID - 49 + index
      return makeMessage(id, `虚拟消息 ${id}`)
    })
    await route.fulfill({ json: { messages, hasMore: !hasBefore } })
  })

  await page.addInitScript(() => Object.keys(localStorage).filter((key) => key.startsWith('cws.channelScroll.')).forEach((key) => localStorage.removeItem(key)))
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
  await expect(page.getByText('这是 #文字聊天 的开始。')).toBeVisible()
  await expect(loadEarlier).toBeHidden()
  await expect(page.locator('.jump-to-latest')).toBeVisible()

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
  await expect(channelSidebar).toHaveCSS('width', '300px')
  await expect(channelSidebar.locator('.current-user')).toHaveCount(0)
  await expect(channelSidebar.locator('.user-controls')).toHaveCount(0)
  await expect(page.locator('.server-rail .account-trigger')).toBeVisible()
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
  await expect(channelSidebar).toHaveCSS('width', '300px')
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
  await openServerAdmin(page)

  const panel = page.locator('.admin-panel')
  const panelSize = () => panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  const channelSize = await panelSize()

  await page.getByRole('button', { name: '成员', exact: true }).click()
  expect(await panelSize()).toEqual(channelSize)

  await page.getByTitle('关闭').last().click()
  await openPlatformAccounts(page)
  const platformPanel = page.locator('.admin-panel')
  const platformSize = () => platformPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  const platformInitialSize = await platformSize()
  await page.getByRole('button', { name: '创建与邀请', exact: true }).click()
  expect(await platformSize()).toEqual(platformInitialSize)

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

test('平台管理员可通过登录名确认删除账号', async ({ page, request, browser, isMobile }, testInfo) => {
  await request.post('/api/auth/login', { data: { username, password } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `delete_${suffix}`,
    displayName: `待删除账号${suffix.slice(-3)}`,
    password: 'delete-member-password',
    role: 'member',
  }
  const created = { user: await createServerMember(request, serverID, account) }
  let replacementID = 0

  const target = await browser.newContext({ baseURL })
  const targetPage = await target.newPage()
  const historicalMessage = `账号删除消息 ${suffix}`
  try {
    await targetPage.goto('/')
    await targetPage.getByLabel('登录名').fill(account.username)
    await targetPage.getByLabel('密码').fill(account.password)
    await targetPage.getByRole('button', { name: '登录', exact: true }).click()
    await expect(targetPage.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    const targetChangelog = targetPage.getByRole('dialog', { name: '更新日志' })
    if (await targetChangelog.isVisible()) await targetChangelog.getByTitle('关闭').click()
    await targetPage.getByPlaceholder('发送消息到 #文字聊天').fill(historicalMessage)
    await targetPage.getByTitle('发送消息').click()
    await expect(page.getByText(historicalMessage, { exact: true })).toBeVisible()

    await openPlatformAccounts(page)
    await page.getByRole('button', { name: '平台账号', exact: true }).click()
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
    const replacementResponse = await request.post('/api/platform/users', { data: { ...account, displayName: '同名新账号' } })
    expect(replacementResponse.ok()).toBeTruthy()
    const replacement = await replacementResponse.json() as { user: { id: number } }
    expect(replacement.user.id).not.toBe(created.user.id)
    replacementID = replacement.user.id
  } finally {
    await target.close()
    if (replacementID) await deletePlatformUser(request, replacementID, account.username)
    else await deletePlatformUser(request, created.user.id, account.username)
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

async function setSyntheticVoiceConnection(page: Page) {
  await page.evaluate(() => {
    type VoiceStoreTestState = {
      status: 'connected'
      connectedServerName: string
      connectedChannelName: string
    }
    type PiniaTestState = { _s: Map<string, VoiceStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const voice = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('voice')
    if (!voice) throw new Error('未找到语音 store')
    voice.status = 'connected'
    voice.connectedServerName = '测试服务器'
    voice.connectedChannelName = '测试语音频道'
  })
}

test('管理控制台成员列表和详情分别滚动', async ({ page, isMobile }) => {
  await page.route('**/api/servers/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const members = [
      ...payload.members,
      ...Array.from({ length: 40 }, (_, index) => ({
        userId: 10_000 + index,
        username: `scroll-member-${index + 1}`,
        displayName: `滚动测试成员 ${String(index + 1).padStart(2, '0')}`,
        role: 'member',
        voiceMuted: false,
        textMuted: false,
        permanentlyBanned: false,
        joinedAt: new Date().toISOString(),
      })),
    ]
    await route.fulfill({ response, json: { ...payload, members } })
  })

  await page.setViewportSize({ width: isMobile ? 412 : 1200, height: 500 })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  await openServerAdmin(page)
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

  await page.route('**/api/platform/invites**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'DELETE') {
      expect(url.pathname).toBe(`/api/platform/invites/${activeInvite.id}/permanent`)
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

  await openPlatformAccounts(page)
  await page.getByRole('button', { name: '创建与邀请', exact: true }).click()

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
  await page.route('**/api/platform/invites**', (route) => route.fulfill({
    json: { invites: null, hasMore: false, nextCursor: '' },
  }))

  await openPlatformAccounts(page)
  await page.getByRole('button', { name: '创建与邀请', exact: true }).click()

  await expect(page.getByText('暂无邀请码', { exact: true })).toBeVisible()
  await expect(page.locator('.invite-row')).toHaveCount(0)
})

test('窄屏频道与成员抽屉不溢出', async ({ page, isMobile }) => {
  test.skip(!isMobile, '仅在移动端项目运行')
  await page.getByTitle('频道', { exact: true }).click()
  await expect(page.locator('.server-title strong')).toHaveText('Celery Web Speak')
  await page.getByTitle('关闭').click()
  await page.getByRole('button', { name: /成员列表/ }).click()
  await expect(page.locator('.drawer-header strong')).toHaveText('成员')
  const viewport = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(viewport.width).toBeLessThanOrEqual(viewport.client)
})
