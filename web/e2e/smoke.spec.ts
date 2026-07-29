import { expect, request as createRequestContext, test, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

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

async function openCurrentGuildActions(page: Page) {
  const trigger = page.getByTitle('服务器操作')
  if (!(await trigger.isVisible())) await page.getByTitle('频道', { exact: true }).click()
  await trigger.click()
  const menu = page.getByRole('menu', { name: /的服务器操作$/ })
  await expect(menu).toBeVisible()
  return menu
}

async function openGuildAdmin(page: Page) {
  const menu = await openCurrentGuildActions(page)
  await menu.getByRole('menuitem', { name: '管理控制台', exact: true }).click()
  await expect(page.getByRole('heading', { name: '服务器管理' })).toBeVisible()
}

async function openPlatformAccounts(page: Page) {
  const platformButton = page.locator('button[title="平台服务器管理"]:visible')
  if (!(await platformButton.isVisible()) && await page.getByTitle('频道', { exact: true }).isVisible()) await page.getByTitle('频道', { exact: true }).click()
  if (await platformButton.isVisible()) await platformButton.click()
  else {
    const menu = await openCurrentGuildActions(page)
    await menu.getByRole('menuitem', { name: '平台服务器管理', exact: true }).click()
  }
  await page.getByTitle('平台账号与邀请码').click()
  await expect(page.getByRole('heading', { name: '平台管理' })).toBeVisible()
  await expect(page.locator('.admin-panel .panel-header p')).toHaveText('平台管理员')
}

async function mockActiveGuildRole(
  page: Page,
  options: { actorRole: 'owner' | 'admin'; isPlatformAdmin?: boolean },
) {
  await page.routeWebSocket(/\/api\/ws\?/, () => {})
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({
      response,
      json: {
        ...payload,
        user: options.isPlatformAdmin === undefined
          ? payload.user
          : { ...payload.user, isPlatformAdmin: options.isPlatformAdmin },
        guilds: payload.guilds.map((guild: { joined: boolean }) => guild.joined ? { ...guild, role: options.actorRole } : guild),
      },
    })
  })
}

async function mockMemberModerationRoles(
  page: Page,
  options: { actorRole: 'owner' | 'admin'; isPlatformAdmin: boolean },
) {
  await mockActiveGuildRole(page, options)
  await page.route('**/api/guilds/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const joinedAt = new Date().toISOString()
    const memberState = {
      voiceMuted: false,
      textMuted: false,
      permanentlyBanned: false,
      joinedAt,
    }
    await route.fulfill({
      response,
      json: {
        ...payload,
        membership: { ...payload.membership, role: options.actorRole },
        members: [
          ...payload.members,
          { guildId: payload.membership.guildId, userId: 90_001, username: 'permission-owner', displayName: '权限测试所有者', role: 'owner', ...memberState },
          { guildId: payload.membership.guildId, userId: 90_002, username: 'permission-admin', displayName: '权限测试管理员', role: 'admin', ...memberState },
          { guildId: payload.membership.guildId, userId: 90_003, username: 'permission-member', displayName: '权限测试成员', role: 'member', ...memberState },
        ],
      },
    })
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  await openGuildAdmin(page)
  await page.getByRole('button', { name: '成员', exact: true }).click()
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

test('WebUI 仅在有效原生场景保留鼠标右键菜单', async ({ page, isMobile }) => {
  const result = await page.evaluate(() => {
    const dispatch = (target: Element, init: PointerEventInit = {}) => {
      const event = new PointerEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 1,
        clientY: 1,
        pointerType: 'mouse',
        ...init,
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }

    const fixture = document.createElement('div')
    fixture.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;width:420px;padding:12px;background:white;color:black'
    fixture.innerHTML = `
      <button data-target="button">普通操作</button>
      <input data-target="text" value="可编辑文本">
      <input data-target="readonly" value="只读文本" readonly>
      <input data-target="disabled" value="禁用文本" disabled>
      <input data-target="range" type="range">
      <div data-target="editable" contenteditable="true">可编辑区域</div>
      <div contenteditable="true"><span data-target="editable-off" contenteditable="false">不可编辑子区</span></div>
      <a data-target="link" href="/help"><span>真实链接</span></a>
      <img data-target="chrome-image" alt="界面素材">
      <img data-target="user-media" data-native-context-menu alt="用户内容">
      <p data-target="selection">选中的只读文本和选区外文本</p>
    `
    document.body.append(fixture)

    const find = (name: string) => fixture.querySelector(`[data-target="${name}"]`)!
    const paragraph = find('selection')
    const text = paragraph.firstChild!
    const selection = document.getSelection()!
    const selectedRange = document.createRange()
    selectedRange.setStart(text, 0)
    selectedRange.setEnd(text, 7)
    selection.removeAllRanges()
    selection.addRange(selectedRange)
    const selectedBounds = selectedRange.getBoundingClientRect()

    const outsideRange = document.createRange()
    outsideRange.setStart(text, 10)
    outsideRange.setEnd(text, 11)
    const outsideBounds = outsideRange.getBoundingClientRect()

    const checks = {
      button: dispatch(find('button')),
      text: dispatch(find('text')),
      readonly: dispatch(find('readonly')),
      disabled: dispatch(find('disabled')),
      range: dispatch(find('range')),
      editable: dispatch(find('editable')),
      editableOff: dispatch(find('editable-off')),
      linkChild: dispatch(find('link').firstElementChild!),
      chromeImage: dispatch(find('chrome-image')),
      userMedia: dispatch(find('user-media')),
      selectedText: dispatch(paragraph, {
        clientX: selectedBounds.left + selectedBounds.width / 2,
        clientY: selectedBounds.top + selectedBounds.height / 2,
      }),
      outsideSelection: dispatch(paragraph, {
        clientX: outsideBounds.left + outsideBounds.width / 2,
        clientY: outsideBounds.top + outsideBounds.height / 2,
      }),
      touch: dispatch(find('button'), { pointerType: 'touch', button: 0 }),
      pen: dispatch(find('button'), { pointerType: 'pen', button: 2 }),
    }

    const keyboardEvent = new PointerEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse',
    })
    find('button').dispatchEvent(keyboardEvent)
    selection.removeAllRanges()
    fixture.remove()

    return { ...checks, keyboard: keyboardEvent.defaultPrevented }
  })

  expect(result).toEqual({
    button: true,
    text: false,
    readonly: false,
    disabled: false,
    range: true,
    editable: false,
    editableOff: true,
    linkChild: false,
    chromeImage: true,
    userMedia: false,
    selectedText: false,
    outsideSelection: true,
    touch: false,
    pen: false,
    keyboard: false,
  })

  if (!isMobile) {
    const channel = page.locator('.channel-scroll > .channel-row').first()
    await channel.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: /的频道操作$/ })).toBeVisible()
  }

  await page.request.post('/api/auth/logout')
  await page.reload()
  await expect(page.getByLabel('密码')).toBeVisible()
  const authResult = await page.evaluate(() => {
    const dispatch = (target: Element) => {
      const event = new PointerEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        pointerType: 'mouse',
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    return {
      submit: dispatch(document.querySelector('.submit-button')!),
      password: dispatch(document.querySelector('input[type="password"]')!),
    }
  })
  expect(authResult).toEqual({ submit: true, password: false })

  const keyboardResult = page.evaluate(() => new Promise<boolean>((resolve) => {
    document.addEventListener('contextmenu', (event) => {
      window.setTimeout(() => resolve(event.defaultPrevented), 0)
    }, { once: true })
  }))
  await page.locator('.submit-button').focus()
  await page.keyboard.press('Shift+F10')
  expect(await keyboardResult).toBe(false)
})

test('WebUI 仅在用户内容与可编辑控件上允许文本选区', async ({ page }) => {
  const result = await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999'
    fixture.innerHTML = `
      <div data-target="chrome">界面文本</div>
      <div data-target="user-content" data-user-content>消息正文</div>
      <input data-target="text-input" value="可编辑">
      <textarea data-target="textarea">可编辑</textarea>
      <div data-target="editable" contenteditable="true">可编辑区</div>
      <a data-target="link" href="/help">链接</a>
      <button data-target="button">按钮文本</button>
    `
    document.body.append(fixture)
    const styleOf = (name: string) => getComputedStyle(fixture.querySelector(`[data-target="${name}"]`) as HTMLElement).userSelect
    const value = {
      body: getComputedStyle(document.body).userSelect,
      chrome: styleOf('chrome'),
      userContent: styleOf('user-content'),
      textInput: styleOf('text-input'),
      textarea: styleOf('textarea'),
      editable: styleOf('editable'),
      link: styleOf('link'),
      button: styleOf('button'),
    }
    fixture.remove()
    return value
  })

  expect(result).toEqual({
    body: 'none',
    chrome: 'none',
    userContent: 'text',
    textInput: 'text',
    textarea: 'text',
    editable: 'text',
    link: 'text',
    button: 'none',
  })
})

test('浏览器图标与服务器切换栏可用', async ({ page, isMobile }) => {
  const favicon = page.locator('link[rel="icon"]')
  await expect(favicon).toHaveAttribute('href', '/favicon.svg')
  await expect(favicon).toHaveAttribute('sizes', 'any')

  const guildButton = page.locator('.guild-button').filter({ has: page.locator('.guild-initial') }).first()
  await expect(guildButton).toBeVisible()
  const bounds = await guildButton.boundingBox()
  expect(bounds?.width).toBe(46)
  expect(bounds?.height).toBe(46)

  if (isMobile) {
    await expect(page.getByLabel('切换服务器')).toHaveCount(0)
    await expect.poll(() => page.locator('.guild-rail').evaluate((element) => element.getBoundingClientRect().width)).toBe(56)
    await guildButton.click()
    const drawer = page.locator('.channel-sidebar.mobile-drawer-open')
    await expect(drawer).toBeVisible()
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left)).toBe(56)
    await guildButton.click()
    await expect(drawer).toHaveCount(0)
    await page.getByTitle('频道', { exact: true }).click()
    await expect(drawer).toBeVisible()
    await expect.poll(() => page.locator('.drawer-scrim').evaluate((element) => element.getBoundingClientRect().left)).toBe(56)
  }
})

test('频道右键菜单支持复制、键盘操作和定向编辑', async ({ page, isMobile }) => {
  test.skip(isMobile, '频道右键菜单仅在桌面布局验证')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

  const voiceRow = page.locator('.voice-channel-block > .channel-row').first()
  const voiceName = (await voiceRow.locator('.channel-label strong').textContent())?.trim() ?? ''
  await voiceRow.click({ button: 'right' })
  let menu = page.getByRole('menu', { name: `${voiceName}的频道操作` })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '复制频道名称', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '标记为已读', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: '编辑频道', exact: true })).toBeVisible()
  await expect(menu.getByText(/加入|断开|切换|删除/)).toHaveCount(0)

  await menu.getByRole('menuitem', { name: '复制频道名称', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '频道名称已复制' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(voiceName)
  await expect(menu).toHaveCount(0)

  await voiceRow.focus()
  await page.keyboard.press('Shift+F10')
  menu = page.getByRole('menu', { name: `${voiceName}的频道操作` })
  await expect(menu.getByRole('menuitem', { name: '复制频道名称', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(voiceRow).toBeFocused()

  await voiceRow.click({ button: 'right' })
  await page.getByRole('menu', { name: `${voiceName}的频道操作` }).getByRole('menuitem', { name: '编辑频道', exact: true }).click()
  const admin = page.getByRole('dialog', { name: '服务器管理' })
  await expect(admin).toBeVisible()
  await expect(admin.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true })).toHaveClass(/active/)
  await expect(admin.locator('.channel-admin-detail > header h3')).toHaveText(voiceName)
})

test('平台管理员作为服务器普通成员时没有频道编辑入口', async ({ page, isMobile }) => {
  test.skip(isMobile, '频道右键菜单仅在桌面布局验证')
  await page.routeWebSocket(/\/api\/ws\?/, () => {})
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({
      response,
      json: {
        ...payload,
        user: { ...payload.user, isPlatformAdmin: true },
        guilds: payload.guilds.map((guild: { joined: boolean }) => guild.joined ? { ...guild, role: 'member' } : guild),
      },
    })
  })
  await page.route('**/api/guilds/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({ response, json: { ...payload, membership: { ...payload.membership, role: 'member' } } })
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()

  const voiceRow = page.locator('.voice-channel-block > .channel-row').first()
  const voiceName = (await voiceRow.locator('.channel-label strong').textContent())?.trim() ?? ''
  await voiceRow.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: `${voiceName}的频道操作` })
  await expect(menu.getByRole('menuitem', { name: '复制频道名称', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '编辑频道', exact: true })).toHaveCount(0)
})

test('文字频道菜单保持已读项并可在不切换频道时清除未读', async ({ page, isMobile }) => {
  test.skip(isMobile, '频道右键菜单仅在桌面布局验证')
  const channelID = 9_900_001
  const channelName = '右键未读测试频道'
  let markReadRequests = 0
  await page.routeWebSocket(/\/api\/ws\?/, () => {})
  await page.route('**/api/guilds/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const template = payload.channels.find((channel: { type: string }) => channel.type === 'text')
    await route.fulfill({
      response,
      json: {
        ...payload,
        channels: [...payload.channels, { ...template, id: channelID, name: channelName }],
        channelReadStates: [
          ...payload.channelReadStates,
          { channelId: channelID, lastReadMessageId: 10, latestMessageId: 12, unreadCount: 2 },
        ],
      },
    })
  })
  await page.route(`**/api/guilds/*/channels/${channelID}/read`, async (route) => {
    markReadRequests += 1
    await route.fulfill({
      status: 200,
      json: { readState: { channelId: channelID, lastReadMessageId: 12, latestMessageId: 12, unreadCount: 0 } },
    })
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()

  const originalHeading = await page.locator('.channel-title').textContent()
  const targetRow = page.locator('.channel-scroll > .channel-row').filter({ hasText: channelName })
  await expect(targetRow.locator('.channel-unread')).toHaveText('2')
  await targetRow.click({ button: 'right' })
  let menu = page.getByRole('menu', { name: `${channelName}的频道操作` })
  const markRead = menu.getByRole('menuitem', { name: '标记为已读', exact: true })
  await expect(markRead).toBeEnabled()
  await markRead.click()
  await expect.poll(() => markReadRequests).toBe(1)
  await expect(page.locator('.channel-title')).toHaveText(originalHeading ?? '')
  await expect(targetRow.locator('.channel-unread')).toHaveCount(0)

  await targetRow.click({ button: 'right' })
  menu = page.getByRole('menu', { name: `${channelName}的频道操作` })
  await expect(menu.getByRole('menuitem', { name: '标记为已读', exact: true })).toBeDisabled()
})

test('移动端切换其他服务器后自动打开频道抽屉', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, '仅在移动端项目运行')
  await request.post('/api/auth/login', { data: { username, password } })
  const guildName = `移动切换${Date.now().toString(36).slice(-5)}`
  const createResponse = await request.post('/api/platform/guilds', { data: { name: guildName, ownerUsername: username } })
  expect(createResponse.ok()).toBeTruthy()
  const guild = (await createResponse.json() as { guild: { id: number } }).guild

  try {
    await page.reload()
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    const changelog = page.getByRole('dialog', { name: '更新日志' })
    if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
    const guildButton = page.getByTitle(guildName, { exact: true })
    await expect(guildButton).toBeVisible()
    await guildButton.click()
    const drawer = page.locator('.channel-sidebar.mobile-drawer-open')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.guild-title strong')).toHaveText(guildName)
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left)).toBe(56)
    await guildButton.click()
    await expect(drawer).toHaveCount(0)
  } finally {
    const response = await request.delete(`/api/platform/guilds/${guild.id}`)
    expect(response.ok()).toBeTruthy()
  }
})

test('语音工具栏按职责分栏并持久化 DTX 模式', async ({ page, isMobile }) => {
  const toolbar = page.locator('.user-controls')
  await expect(toolbar).toHaveCount(1)
  await expect(page.locator('.voice-connection-panel')).toHaveCount(0)
  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await expect(toolbar.getByTitle('麦克风静音', { exact: true })).toBeEnabled()
  await expect(toolbar.getByTitle('耳机静音', { exact: true })).toBeEnabled()
  await setSyntheticVoiceConnection(page, { status: 'connecting' })

  const connectionPanel = page.locator('.voice-connection-panel')
  const modeButton = toolbar.locator('.transmission-mode-button')
  const modeTooltip = toolbar.locator('.transmission-mode-tooltip')
  const controlButtons = toolbar.locator('.control-buttons')
  const connectionLocation = connectionPanel.locator('.voice-connection-location')
  const connectionBitrate = connectionPanel.locator('.voice-connection-bitrate')
  await expect(connectionPanel).toBeVisible()
  await expect(connectionPanel.getByText('正在连接', { exact: true })).toBeVisible()
  await expect(connectionPanel.getByTitle('取消语音连接', { exact: true })).toBeVisible()
  await setSyntheticVoiceConnection(page)
  await expect(connectionPanel.getByText('语音已连接', { exact: true })).toBeVisible()
  await expect(connectionPanel.getByTitle('断开语音', { exact: true })).toHaveClass(/danger/)
  await expect(connectionLocation).toHaveText('测试服务器 / 测试语音频道')
  await expect(connectionBitrate).toHaveText('· 64 kbps')
  await expect(connectionBitrate).not.toHaveAttribute('title')
  await expect(toolbar).toBeVisible()
  await expect(modeButton).toHaveAccessibleName('当前模式：语音感应；切换为持续传输')
  await expect(modeButton).not.toHaveAttribute('aria-pressed')
  await expect(modeButton).not.toHaveAttribute('title')
  await expect(modeTooltip).toHaveText('切换为持续传输')
  await expect(modeTooltip).toHaveCSS('visibility', 'hidden')
  await expect(toolbar.getByTitle('断开语音', { exact: true })).toHaveCount(0)

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

  const initialConnectionHeight = await connectionPanel.evaluate((element) => element.getBoundingClientRect().height)
  await setSyntheticVoiceConnection(page, {
    status: 'reconnecting',
    guildName: '很长的测试服务器名称'.repeat(8),
    channelName: '很长的测试语音频道名称'.repeat(8),
    audioBitrateKbps: 96,
  })
  await expect(connectionPanel.getByText('正在重连', { exact: true })).toBeVisible()
  await expect(connectionBitrate).toHaveText('· 96 kbps')
  const connectionLayout = await connectionPanel.evaluate((element) => {
    const detail = element.querySelector('.voice-connection-detail')!.getBoundingClientRect()
    const locationElement = element.querySelector('.voice-connection-location') as HTMLElement
    const location = locationElement.getBoundingClientRect()
    const bitrate = element.querySelector('.voice-connection-bitrate')!.getBoundingClientRect()
    return {
      panelHeight: element.getBoundingClientRect().height,
      locationTruncated: locationElement.scrollWidth > locationElement.clientWidth,
      locationBeforeBitrate: location.right <= bitrate.left,
      bitrateInsideDetail: bitrate.right <= detail.right + 0.5,
      sameColor: getComputedStyle(locationElement).color === getComputedStyle(element.querySelector('.voice-connection-bitrate')!).color,
    }
  })
  expect(connectionLayout.panelHeight).toBe(initialConnectionHeight)
  expect(connectionLayout.locationTruncated).toBe(true)
  expect(connectionLayout.locationBeforeBitrate).toBe(true)
  expect(connectionLayout.bitrateInsideDetail).toBe(true)
  expect(connectionLayout.sameColor).toBe(true)
  await setSyntheticVoiceConnection(page, { audioBitrateKbps: 96 })

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
  await expect(page.locator('.user-controls')).toHaveCount(1)
  await expect(page.locator('.voice-connection-panel')).toHaveCount(0)
})

test('离线语音快捷控制可调音量、选择设备并直达设置', async ({ page, isMobile }) => {
  test.skip(isMobile, '快捷浮层与右键菜单仅增强桌面鼠标和键盘')

  const toolbar = page.locator('.user-controls')
  const microphone = toolbar.getByTitle('麦克风静音', { exact: true })
  const headphones = toolbar.getByTitle('耳机静音', { exact: true })
  expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(true)
  await expect(page.locator('.voice-connection-panel')).toHaveCount(0)

  await microphone.click()
  await expect(toolbar.getByTitle('取消静音', { exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.microphoneEnabled'))).toBe('false')
  await toolbar.getByTitle('取消静音', { exact: true }).click()

  await microphone.hover()
  const microphoneVolume = toolbar.getByRole('slider', { name: '麦克风增益', exact: true })
  await expect(microphoneVolume).toBeVisible()
  const microphonePopover = toolbar.locator('#microphone-volume-popover')
  await expect(microphonePopover.locator(':scope > svg')).toHaveCount(0)
  const popoverLayout = await microphonePopover.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const output = element.querySelector('output')!.getBoundingClientRect()
    const slider = element.querySelector('input')!.getBoundingClientRect()
    return {
      width: bounds.width,
      valueGap: slider.top - output.bottom,
      bottomGap: bounds.bottom - slider.bottom,
      tail: getComputedStyle(element, '::after').content,
    }
  })
  expect(popoverLayout).toEqual({ width: 44, valueGap: 3, bottomGap: 17, tail: 'none' })
  await microphoneVolume.fill('2.25')
  await expect(toolbar.getByText('225%', { exact: true })).toBeVisible()
  await expect.poll(() => microphoneVolume.evaluate((element) => getComputedStyle(element).getPropertyValue('--range-progress'))).toBe('75%')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.microphoneGain'))).toBe('2.25')

  await microphone.click({ button: 'right', position: { x: 2, y: 2 } })
  await expect(microphoneVolume).toHaveCount(0)
  const inputMenu = page.getByRole('menu', { name: '输入设备', exact: true })
  await expect(inputMenu).toBeVisible()
  const [inputMenuBounds, microphoneBounds] = await Promise.all([inputMenu.boundingBox(), microphone.boundingBox()])
  if (!inputMenuBounds || !microphoneBounds) throw new Error('无法测量输入设备菜单锚点')
  const viewportWidth = page.viewportSize()?.width ?? 0
  const expectedInputMenuLeft = Math.min(
    Math.max(8, microphoneBounds.x + (microphoneBounds.width - inputMenuBounds.width) / 2),
    viewportWidth - inputMenuBounds.width - 8,
  )
  expect(inputMenuBounds.x).toBeCloseTo(expectedInputMenuLeft, 0)
  expect(microphoneBounds.y - inputMenuBounds.y - inputMenuBounds.height).toBeCloseTo(8, 0)
  const defaultInput = inputMenu.getByRole('menuitemradio', { name: /系统默认/ })
  await setSyntheticDeviceChange(page, 'input', 'default')
  await expect(defaultInput).toBeDisabled()
  await setSyntheticDeviceChange(page, null, '')
  await expect(defaultInput).toBeEnabled()
  await defaultInput.click()
  await expect(inputMenu).toBeVisible()
  await inputMenu.getByRole('menuitem', { name: '语音设置', exact: true }).click()

  let settings = page.getByRole('dialog', { name: '用户设置' })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('button', { name: '输入', exact: true })).toHaveClass(/active/)
  await settings.getByTitle('关闭').click()
  await expect(microphone).toBeFocused()

  await microphone.press('Shift+F10')
  await expect(inputMenu).toBeVisible()
  const keyboardInputMenuBounds = await inputMenu.boundingBox()
  if (!keyboardInputMenuBounds) throw new Error('无法测量键盘打开的输入设备菜单锚点')
  expect(keyboardInputMenuBounds.x).toBeCloseTo(inputMenuBounds.x, 0)
  expect(keyboardInputMenuBounds.y).toBeCloseTo(inputMenuBounds.y, 0)
  await expect(inputMenu.getByRole('menuitemradio', { name: /系统默认/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(inputMenu).toBeHidden()
  await expect(microphone).toBeFocused()

  await headphones.hover()
  const outputVolume = toolbar.getByRole('slider', { name: '扬声器音量', exact: true })
  await expect(outputVolume).toBeVisible()
  await expect(toolbar.locator('#output-volume-popover > svg')).toHaveCount(0)

  await headphones.click({ button: 'right' })
  const outputMenu = page.getByRole('menu', { name: '输出设备', exact: true })
  await expect(outputMenu).toBeVisible()
  await outputMenu.getByRole('menuitemradio', { name: /系统默认/ }).click()
  await expect(outputMenu).toBeVisible()
  await expect(outputMenu.getByText('当前浏览器不支持选择输出设备')).toHaveCount(0)
  await outputMenu.getByRole('menuitem', { name: '语音设置', exact: true }).click()

  settings = page.getByRole('dialog', { name: '用户设置' })
  await expect(settings.getByRole('button', { name: '输出', exact: true })).toHaveClass(/active/)
  await settings.getByTitle('关闭').click()
  await expect(headphones).toBeFocused()
})

test('静音时音量滑块保留数值并弱化当前无效的控制', async ({ page, isMobile }) => {
  test.skip(isMobile, '快捷浮层仅增强桌面鼠标和键盘')

  const toolbar = page.locator('.user-controls')
  const microphonePopover = toolbar.locator('#microphone-volume-popover')
  const outputPopover = toolbar.locator('#output-volume-popover')

  await toolbar.getByTitle('麦克风静音', { exact: true }).hover()
  const microphoneVolume = microphonePopover.getByRole('slider', { name: '麦克风增益', exact: true })
  await microphoneVolume.fill('0')
  await expect(microphonePopover).not.toHaveClass(/is-muted/)
  const normalAccent = await microphoneVolume.evaluate((element) => getComputedStyle(element).accentColor)

  await toolbar.getByTitle('麦克风静音', { exact: true }).click()
  await expect(microphonePopover).toBeVisible()
  await expect(microphonePopover).toHaveClass(/is-muted/)
  const mutedMicrophoneVolume = microphonePopover.getByRole('slider', { name: '麦克风增益，当前静音', exact: true })
  await expect(mutedMicrophoneVolume).toHaveValue('0')
  await expect(microphonePopover.getByText('0%', { exact: true })).toBeVisible()
  await expect.poll(() => mutedMicrophoneVolume.evaluate((element) => (
    getComputedStyle(element).accentColor
      === getComputedStyle(element.closest('section')!.querySelector('output')!).color
  ))).toBe(true)
  expect(await mutedMicrophoneVolume.evaluate((element) => getComputedStyle(element).accentColor)).not.toBe(normalAccent)

  await toolbar.getByTitle('取消静音', { exact: true }).click()
  await expect(microphonePopover).not.toHaveClass(/is-muted/)

  await toolbar.getByTitle('耳机静音', { exact: true }).hover()
  const outputVolume = outputPopover.getByRole('slider', { name: '扬声器音量', exact: true })
  await expect(outputPopover).not.toHaveClass(/is-muted/)
  const outputValue = await outputVolume.inputValue()
  await toolbar.getByTitle('耳机静音', { exact: true }).click()
  await expect(outputPopover).toBeVisible()
  await expect(outputPopover).toHaveClass(/is-muted/)
  await expect(outputPopover.getByRole('slider', { name: '扬声器音量，当前静音', exact: true })).toHaveValue(outputValue)

  await toolbar.getByTitle('取消耳机静音', { exact: true }).hover()
  await toolbar.getByTitle('取消静音', { exact: true }).hover()
  await expect(microphonePopover).toHaveClass(/is-muted/)
  await expect(microphonePopover.getByRole('slider', { name: '麦克风增益，当前静音', exact: true })).toHaveValue('0')
})

test('语音工具栏在 320px 窄视口内不溢出', async ({ page, isMobile }) => {
  test.skip(isMobile, '使用桌面浏览器精确覆盖 320px 视口')
  await page.setViewportSize({ width: 320, height: 640 })
  await page.getByTitle('频道', { exact: true }).click()

  const sidebar = page.locator('.channel-sidebar.mobile-drawer-open')
  const toolbar = sidebar.locator('.user-controls')
  await expect(toolbar).toBeVisible()
  const layout = await toolbar.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const mode = element.querySelector('.transmission-mode-button')!.getBoundingClientRect()
    const controls = element.querySelector('.control-buttons')!.getBoundingClientRect()
    return {
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      modeBeforeControls: mode.right <= controls.left,
      controlsInside: controls.right <= bounds.right,
    }
  })
  expect(layout).toEqual({ noHorizontalOverflow: true, modeBeforeControls: true, controlsInside: true })
})

test('服务器操作菜单集中展示当前角色可用操作', async ({ page, isMobile }) => {
  await mockActiveGuildRole(page, { actorRole: 'owner' })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()

  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  const guildTitle = page.locator('.guild-title')
  await expect(guildTitle.locator('small')).toHaveCount(0)
  const guildTitleLayout = await guildTitle.evaluate((element) => {
    const titleBounds = element.getBoundingClientRect()
    const textBounds = element.querySelector('strong')!.getBoundingClientRect()
    return {
      fontSize: getComputedStyle(element.querySelector('strong')!).fontSize,
      verticallyCentered: Math.abs(
        (textBounds.top + textBounds.bottom) / 2 - (titleBounds.top + titleBounds.bottom) / 2,
      ) < 1,
    }
  })
  expect(guildTitleLayout).toEqual({ fontSize: '16px', verticallyCentered: true })
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
    const guildButton = page.locator('.guild-button').filter({ has: page.locator('.guild-initial') }).first()
    await guildButton.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await guildButton.focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
  } else {
    await expect(page.locator('.guild-rail button[title="平台服务器管理"]')).toBeVisible()
    await expect(page.getByLabel('切换服务器')).toHaveCount(0)
    const titleLayout = await page.locator('.guild-title').evaluate((element) => {
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
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `leave_${suffix}`,
    displayName: `离开菜单成员${suffix.slice(-3)}`,
    password: 'leave-member-password',
  }
  const member = await createGuildMember(request, guildID, account)
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

    const menu = await openCurrentGuildActions(targetPage)
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
    await targetPage.route(`**/api/guilds/${guildID}/leave`, (route) => route.fulfill({
      status: 500,
      json: { error: 'test_failure', message: '测试离开失败' },
    }))
    await leaveButton.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveText('测试离开失败')
    await expect.poll(async () => {
      const response = await target.request.get('/api/bootstrap')
      const payload = await response.json() as { guilds: Array<{ id: number; joined: boolean }> }
      return payload.guilds.some((guild) => guild.id === guildID && guild.joined)
    }).toBe(true)

    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toBeHidden()
    await targetPage.unroute(`**/api/guilds/${guildID}/leave`)
    const reopenedMenu = await openCurrentGuildActions(targetPage)
    await reopenedMenu.getByRole('menuitem', { name: '离开服务器', exact: true }).click()
    await targetPage.getByRole('alertdialog').getByRole('button', { name: '离开服务器', exact: true }).click()
    await expect(targetPage.getByRole('alertdialog')).toBeHidden()
    await expect(targetPage.getByTitle('服务器操作')).toHaveCount(0)
    const bootstrapResponse = await target.request.get('/api/bootstrap')
    const bootstrap = await bootstrapResponse.json() as { guilds: Array<{ joined: boolean }> }
    expect(bootstrap.guilds.some((guild) => guild.joined)).toBe(false)
  } finally {
    await target.close()
    const response = await deletePlatformUser(request, member.id, account.username)
    expect(response.ok()).toBeTruthy()
  }
})

test('右键离开非当前服务器后保持当前服务器', async ({ request, browser }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('android'), '服务器栏右键菜单仅在桌面布局显示')
  await request.post('/api/auth/login', { data: { username, password } })
  const firstGuildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.workerIndex}`
  const account = {
    username: `leave_other_${suffix}`,
    displayName: `非当前离开成员${suffix.slice(-3)}`,
    password: 'leave-other-password',
  }
  const member = await createGuildMember(request, firstGuildID, account)
  const guildName = `非当前服务器${suffix.slice(-5)}`
  const createResponse = await request.post('/api/platform/guilds', { data: { name: guildName, ownerUsername: username } })
  expect(createResponse.ok()).toBeTruthy()
  const secondGuild = (await createResponse.json() as { guild: { id: number } }).guild
  const addResponse = await request.post(`/api/guilds/${secondGuild.id}/members`, { data: { username: account.username } })
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
    const originalGuildName = await targetPage.locator('.guild-title strong').textContent()

    await targetPage.getByTitle(guildName).click({ button: 'right' })
    const menu = targetPage.getByRole('menu', { name: `${guildName}的服务器操作` })
    await menu.getByRole('menuitem', { name: '离开服务器', exact: true }).click()
    const dialog = targetPage.getByRole('alertdialog', { name: `离开“${guildName}”？` })
    await dialog.getByRole('button', { name: '离开服务器', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(targetPage.locator('.guild-title strong')).toHaveText(originalGuildName ?? '')
    await expect(targetPage.getByTitle(guildName)).toHaveCount(0)
  } finally {
    await target.close()
    const deleteGuildResponse = await request.delete(`/api/platform/guilds/${secondGuild.id}`)
    expect(deleteGuildResponse.ok()).toBeTruthy()
    const deleteUserResponse = await deletePlatformUser(request, member.id, account.username)
    expect(deleteUserResponse.ok()).toBeTruthy()
  }
})

test('登录、聊天和管理员设置可用', async ({ page }) => {
  const message = `端到端检查 ${Date.now()}`
  await page.getByPlaceholder('发送消息到 #文字聊天').fill(message)
  await page.getByTitle('发送消息').click()
  await expect(page.getByText(message)).toBeVisible()

  await openGuildAdmin(page)
  await page.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true }).click()
  await page.locator('.channel-admin-list').getByRole('button', { name: '语音频道', exact: true }).click()
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

test('消息编辑器使用全宽文本区和底部操作行', async ({ page, isMobile }) => {
  const textarea = page.getByPlaceholder('发送消息到 #文字聊天')
  const multiline = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行`).join('\n')
  await textarea.fill(multiline)

  const layout = await page.locator('.composer').evaluate((element) => {
    const composer = element.getBoundingClientRect()
    const input = element.querySelector('textarea')!.getBoundingClientRect()
    const actions = element.querySelector('.composer-actions')!.getBoundingClientRect()
    const send = element.querySelector('.send-button')!.getBoundingClientRect()
    const textarea = element.querySelector('textarea')!
    const inputStyle = getComputedStyle(textarea)
    const messageList = document.querySelector('.message-list')!
    const verticalTrackRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.endsWith('::-webkit-scrollbar-track:vertical'))
    return {
      composerRight: composer.right,
      composerBottom: composer.bottom,
      inputRight: input.right,
      inputBottom: input.bottom,
      inputHeight: input.height,
      inputClientHeight: (element.querySelector('textarea') as HTMLTextAreaElement).clientHeight,
      inputScrollHeight: (element.querySelector('textarea') as HTMLTextAreaElement).scrollHeight,
      actionsTop: actions.top,
      sendBottom: send.bottom,
      overflowY: inputStyle.overflowY,
      scrollbarGutter: inputStyle.scrollbarGutter,
      standardScrollbarWidth: inputStyle.scrollbarWidth,
      standardScrollbarColor: inputStyle.scrollbarColor,
      globalWebkitScrollbarWidth: getComputedStyle(messageList, '::-webkit-scrollbar').width,
      webkitScrollbarWidth: getComputedStyle(textarea, '::-webkit-scrollbar').width,
      scrollbarTrack: getComputedStyle(textarea, '::-webkit-scrollbar-track').backgroundColor,
      verticalTrackMargin: verticalTrackRule?.style.marginBlock,
      scrollbarButton: getComputedStyle(textarea, '::-webkit-scrollbar-button').display,
    }
  })

  expect(layout.inputHeight).toBeLessThanOrEqual(144)
  expect(layout.inputScrollHeight).toBeGreaterThan(layout.inputClientHeight)
  expect(layout.overflowY).toBe('auto')
  expect(layout.scrollbarGutter).toContain('stable')
  expect(layout.standardScrollbarWidth).toBe('auto')
  expect(layout.standardScrollbarColor).toBe('auto')
  expect(layout.globalWebkitScrollbarWidth).toBe('6px')
  expect(layout.webkitScrollbarWidth).toBe('4px')
  expect(layout.scrollbarTrack).toBe('rgba(0, 0, 0, 0)')
  expect(layout.verticalTrackMargin).toBe('4px')
  expect(layout.scrollbarButton).toBe('none')
  expect(layout.composerRight - layout.inputRight).toBeCloseTo(4, 0)
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.inputBottom)
  expect(layout.composerBottom - layout.sendBottom).toBeCloseTo(2, 0)

  const characterCount = page.locator('.character-count')
  if (isMobile) await expect(characterCount).toBeHidden()
  else await expect(characterCount).toBeVisible()
})

test('频道 master-detail 联动展示元数据并丢弃未保存修改', async ({ page }) => {
  const createdAt = '2026-07-27T01:02:03.000Z'
  let voiceChannelName = ''
  let textChannelName = ''
  await page.routeWebSocket(/\/api\/ws\?/, () => {})
  await page.route('**/api/guilds/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const voiceChannel = payload.channels.find((channel: { type: string }) => channel.type === 'voice')
    const textChannel = payload.channels.find((channel: { type: string }) => channel.type === 'text')
    voiceChannelName = voiceChannel.name
    textChannelName = textChannel.name
    const channels = payload.channels.map((channel: { id: number }) => {
      if (channel.id === voiceChannel.id) {
        return {
          ...channel,
          createdAt,
          audioBitrateKbps: 96,
          backgroundAudioBitrateKbps: 192,
          audioRedEnabled: false,
          backgroundAudioRedEnabled: true,
        }
      }
      return channel.id === textChannel.id ? { ...channel, messageRetention: 900 } : channel
    })
    const voiceRooms = [
      ...payload.voiceRooms.filter((room: { channelId: number }) => room.channelId !== voiceChannel.id),
      { channelId: voiceChannel.id, participants: [{ userId: 90_101 }, { userId: 90_102 }] },
    ]
    await route.fulfill({ response, json: { ...payload, channels, voiceRooms } })
  })

  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  await openGuildAdmin(page)
  await page.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true }).click()

  const list = page.locator('.channel-admin-list')
  const detail = page.locator('.channel-admin-detail')
  await list.getByRole('button', { name: voiceChannelName, exact: true }).click()
  await expect(detail.locator('header h3')).toHaveText(voiceChannelName)
  const metadataRows = detail.locator('.guild-metadata > div')
  await expect(metadataRows.nth(0).locator('dt')).toHaveText('频道类型')
  await expect(metadataRows.nth(0).locator('dd')).toHaveText('语音频道')
  const localizedCreatedAt = await page.evaluate((value) => new Date(value).toLocaleString('zh-CN'), createdAt)
  await expect(metadataRows.nth(1).locator('dt')).toHaveText('创建时间')
  await expect(metadataRows.nth(1).locator('dd')).toHaveText(localizedCreatedAt)
  await expect(metadataRows.nth(2).locator('dt')).toHaveText('语音在线')
  await expect(metadataRows.nth(2).locator('dd')).toHaveText('2 人')
  await expect(detail.getByLabel('频道名称')).toHaveValue(voiceChannelName)
  await expect(detail.getByRole('slider').nth(0)).toHaveValue('96')
  await expect(detail.getByRole('slider').nth(1)).toHaveValue('192')
  await expect(detail.getByLabel('语音 RED 丢包冗余')).not.toBeChecked()
  await expect(detail.getByLabel('背景音 RED 丢包冗余')).toBeChecked()

  await detail.getByLabel('频道名称').fill('未保存的频道名')
  await list.getByRole('button', { name: textChannelName, exact: true }).click()
  await expect(detail.getByLabel('保留消息数量')).toHaveValue('900')
  await list.getByRole('button', { name: voiceChannelName, exact: true }).click()
  await expect(detail.getByLabel('频道名称')).toHaveValue(voiceChannelName)
})

test('临时封禁状态在刷新后可见并可提前解除', async ({ page, request }, testInfo) => {
  await request.post('/api/auth/login', { data: { username, password } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `temporary_ban_${suffix}`,
    displayName: `临时封禁成员${suffix.slice(-3)}`,
    password: 'member-password-123',
  }
  const member = await createGuildMember(request, guildID, account)
  try {
    const banResponse = await request.patch(`/api/guilds/${guildID}/members/${member.id}/ban`, {
      data: { banned: false, temporaryBanUntil: new Date(Date.now() + 30 * 60_000).toISOString() },
    })
    expect(banResponse.ok()).toBeTruthy()

    await page.reload()
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    await openGuildAdmin(page)
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

test('服务器管理员只能审核普通成员并按目标角色显示原因', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'admin', isPlatformAdmin: false })
  await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器管理员')
  const list = page.locator('.admin-user-list')
  const detail = page.locator('.user-admin-detail')

  await list.getByRole('button').filter({ hasText: '权限测试成员' }).click()
  await expect(detail.getByText('语音禁言', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toBeVisible()
  await expect(detail.locator('.permission-note')).toHaveCount(0)

  await list.getByRole('button').filter({ hasText: '权限测试管理员' }).click()
  await expect(detail.getByText('服务器管理员不能管理其他管理员。', { exact: true })).toBeVisible()
  await expect(detail.getByText('语音禁言', { exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toHaveCount(0)

  await list.getByRole('button').filter({ hasText: '权限测试所有者' }).click()
  await expect(detail.getByText('服务器管理员不能管理服务器所有者。', { exact: true })).toBeVisible()
  await expect(detail.getByText('语音禁言', { exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toHaveCount(0)
})

test('服务器所有者仍可审核管理员', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'owner', isPlatformAdmin: false })
  await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器所有者')
  const detail = page.locator('.user-admin-detail')
  await page.locator('.admin-user-list button').filter({ hasText: '权限测试管理员' }).click()
  await expect(detail.getByText('语音禁言', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toBeVisible()
  await expect(detail.locator('.permission-note')).toHaveCount(0)
})

test('平台管理员可审核管理员但不能审核服务器所有者', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'admin', isPlatformAdmin: true })
  await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器管理员 · 平台管理员')
  const detail = page.locator('.user-admin-detail')

  await page.locator('.admin-user-list button').filter({ hasText: '权限测试管理员' }).click()
  await expect(detail.getByText('语音禁言', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toBeVisible()

  await page.locator('.admin-user-list button').filter({ hasText: '权限测试所有者' }).click()
  await expect(detail.getByText('服务器所有者不能在成员管理中被审核；如需更换所有者，请使用所有权转让。', { exact: true })).toBeVisible()
  await expect(detail.getByText('语音禁言', { exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toHaveCount(0)
})

test('服务器所有者兼平台管理员显示双重角色副标题', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'owner', isPlatformAdmin: true })
  await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器所有者 · 平台管理员')
})

test('服务器 Tab 仅所有者可见且为默认页签', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面项目覆盖 Tab 可见性逻辑')
  await openGuildAdmin(page)
  await expect(page.getByRole('button', { name: '服务器', exact: true })).toHaveClass(/active/)
  await expect(page.getByRole('button', { name: '频道', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '成员', exact: true })).toBeVisible()
  await expect(page.getByLabel('服务器名称')).toBeVisible()
  await page.getByTitle('关闭').last().click()

  await mockActiveGuildRole(page, { actorRole: 'admin', isPlatformAdmin: false })
  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  await openGuildAdmin(page)
  await expect(page.getByRole('button', { name: '服务器', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '频道', exact: true })).toHaveClass(/active/)
  await expect(page.locator('.channel-admin-list')).toBeVisible()
})

test('服务器 Tab 重命名后同步更新主界面', async ({ page, request }, testInfo) => {
  await request.post('/api/auth/login', { data: { username, password } })
  const guildID = await firstJoinedGuildID(request)
  const bootstrapResponse = await request.get('/api/bootstrap')
  const bootstrap = await bootstrapResponse.json() as { guilds: Array<{ id: number; name: string }> }
  const originalName = bootstrap.guilds.find((guild) => guild.id === guildID)?.name
  expect(originalName).toBeTruthy()
  const projectSuffix = testInfo.project.name.startsWith('android') ? 'M' : 'D'
  const nextName = `重命名验收${Date.now().toString(36)}${projectSuffix}`

  try {
    await openGuildAdmin(page)
    await page.getByLabel('服务器名称').fill(nextName)
    await page.getByRole('button', { name: '保存名称', exact: true }).click()
    await expect(page.getByText('服务器名称已更新', { exact: true })).toBeVisible()
    await page.getByTitle('关闭').last().click()
    await expect(page.locator('.guild-title strong')).toHaveText(nextName)
  } finally {
    const restoreResponse = await request.patch(`/api/guilds/${guildID}`, { data: { name: originalName } })
    expect(restoreResponse.ok()).toBeTruthy()
  }
})

test('WebSocket 重同步的旧响应不会覆盖同一服务器的新状态', async ({ page, request, isMobile }) => {
  test.skip(isMobile, '桌面项目覆盖服务器切换的可控乱序响应')
  await request.post('/api/auth/login', { data: { username, password } })
  const firstGuildID = await firstJoinedGuildID(request)
  const secondGuildName = `重同步服务器${Date.now().toString(36).slice(-5)}`
  const createResponse = await request.post('/api/platform/guilds', { data: { name: secondGuildName, ownerUsername: username } })
  expect(createResponse.ok()).toBeTruthy()
  const secondGuild = (await createResponse.json() as { guild: { id: number } }).guild
  let releaseDelayedResponse = () => {}
  try {
    await expect(page.getByTitle(secondGuildName)).toBeVisible()
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
    const firstGuildName = await page.locator('.guild-title strong').innerText()

    let markDelayedRequest = () => {}
    const delayedRequest = new Promise<void>((resolve) => { markDelayedRequest = resolve })
    const release = new Promise<void>((resolve) => { releaseDelayedResponse = resolve })
    let markDelayedResponseComplete = () => {}
    const delayedResponseComplete = new Promise<void>((resolve) => { markDelayedResponseComplete = resolve })
    let delayNextBootstrap = true
    await page.route(`**/api/guilds/${firstGuildID}/bootstrap`, async (route) => {
      if (!delayNextBootstrap) {
        await route.continue()
        return
      }
      delayNextBootstrap = false
      const response = await route.fetch()
      const stalePayload = await response.json()
      markDelayedRequest()
      await release
      await route.fulfill({ response, json: { ...stalePayload, channels: [] } })
      markDelayedResponseComplete()
    })

    await page.evaluate(() => {
      const sockets = (window as typeof window & { __cwsSockets?: WebSocket[] }).__cwsSockets ?? []
      sockets.at(-1)?.close(4000, 'test resynchronization')
    })
    await delayedRequest
    await page.getByTitle(secondGuildName).click()
    await expect(page.locator('.guild-title strong')).toHaveText(secondGuildName)
    await page.getByRole('button', { name: firstGuildName, exact: true }).click()
    await expect(page.locator('.guild-title strong')).toHaveText(firstGuildName)
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    releaseDelayedResponse()
    await delayedResponseComplete
    await expect(page.locator('.guild-title strong')).toHaveText(firstGuildName)
    await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  } finally {
    releaseDelayedResponse()
    const response = await request.delete(`/api/platform/guilds/${secondGuild.id}`)
    expect(response.ok()).toBeTruthy()
  }
})

test('管理员可创建和删除独立文字频道', async ({ page, isMobile }) => {
  const channelName = `项目频道${Date.now().toString(36).slice(-5)}`
  const channelMessage = `频道隔离检查 ${Date.now()}`
  await openGuildAdmin(page)
  await page.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true }).click()
  await page.getByRole('button', { name: '创建频道', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '创建频道' })
  await expect(createDialog).toBeVisible()
  await createDialog.getByLabel('新频道名称').fill(channelName)
  await createDialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(createDialog).toBeHidden()
  await expect(page.locator('.channel-admin-detail > header h3')).toHaveText(channelName)
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

  await openGuildAdmin(page)
  await page.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true }).click()
  await page.locator('.channel-admin-list').getByRole('button', { name: channelName, exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const confirmDelete = page.getByRole('button', { name: '确认删除', exact: true })
  await expect(confirmDelete).toBeDisabled()
  await page.getByLabel('输入频道名称确认删除').fill(`${channelName}_wrong`)
  await expect(confirmDelete).toBeDisabled()
  await page.getByLabel('输入频道名称确认删除').fill(channelName)
  await expect(confirmDelete).toBeEnabled()
  await confirmDelete.click()
  await expect(page.getByText('频道已永久删除')).toBeVisible()
  await expect(page.locator('.channel-admin-list').getByRole('button', { name: channelName, exact: true })).toHaveCount(0)
  const firstChannelName = (await page.locator('.channel-admin-list > button').nth(1).locator('span').textContent()) ?? ''
  await expect(page.locator('.channel-admin-detail > header h3')).toHaveText(firstChannelName)
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
  const joinSwitch = page.getByRole('checkbox', { name: '加入语音' })
  const leaveSwitch = page.getByRole('checkbox', { name: '退出语音' })
  const messageSwitch = page.getByRole('checkbox', { name: '新文字消息' })
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
  await expect(page.getByRole('checkbox', { name: '加入语音' })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: '新文字消息' })).not.toBeChecked()
})

test('主动退出提示音绕过同类限流但仍遵守耳机静音', async ({ page }) => {
  await installToneCounter(page)
  await page.locator('body').click({ position: { x: 10, y: 10 } })

  const initialCount = await toneCount(page)
  await playSoundThroughStore(page, false)
  await playSoundThroughStore(page, false)
  await expect.poll(() => toneCount(page)).toBe(initialCount + 2)

  await page.waitForTimeout(350)
  const beforeBypass = await toneCount(page)
  await playSoundThroughStore(page, false)
  await playSoundThroughStore(page, true)
  await expect.poll(() => toneCount(page)).toBe(beforeBypass + 4)

  await setSoundSuppressedThroughStore(page, true)
  const beforeSuppressed = await toneCount(page)
  await playSoundThroughStore(page, true)
  await page.waitForTimeout(150)
  expect(await toneCount(page)).toBe(beforeSuppressed)
  await setSoundSuppressedThroughStore(page, false)
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

test('音频处理与静音说话提醒开关持久化到浏览器', async ({ page, isMobile }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音频', exact: true }).click()

  const echoToggle = page.getByLabel('回声抑制')
  const noiseToggle = page.getByLabel('降噪')
  const reminderToggle = page.getByLabel('静音时说话提醒')
  await expect(echoToggle).toBeChecked()
  await expect(noiseToggle).toBeChecked()
  await expect(reminderToggle).toBeChecked()

  await echoToggle.uncheck()
  await noiseToggle.uncheck()
  await reminderToggle.uncheck()
  await expect.poll(() => page.evaluate(() => ({
    echo: localStorage.getItem('cws.echoCancellation'),
    noise: localStorage.getItem('cws.noiseSuppression'),
    mutedSpeakingReminder: localStorage.getItem('cws.mutedSpeakingReminder.enabled'),
  }))).toEqual({ echo: 'false', noise: 'false', mutedSpeakingReminder: 'false' })

  await page.reload()
  await openUserSettings(page)
  await page.getByRole('button', { name: '音频', exact: true }).click()
  await expect(page.getByLabel('静音时说话提醒')).not.toBeChecked()
})

test('静音说话提醒使用固定双音并遵守提示音总开关', async ({ page }) => {
  await installToneCounter(page)
  await page.locator('body').click({ position: { x: 10, y: 10 } })

  const initialCount = await toneCount(page)
  await playMutedSpeakingReminderThroughStore(page)
  await expect.poll(() => toneCount(page)).toBe(initialCount + 2)

  await setSoundEnabledThroughStore(page, false)
  await playMutedSpeakingReminderThroughStore(page)
  await page.waitForTimeout(150)
  expect(await toneCount(page)).toBe(initialCount + 2)
})

test('静音说话提醒高亮麦克风按钮并显示状态提示', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道', { exact: true }).click()
  await page.getByTitle('麦克风静音').click()
  await setMutedSpeakingReminderVisible(page, true)

  const microphoneButton = page.getByTitle('取消静音')
  const reminderTooltip = page.locator('.muted-speaking-reminder-tooltip')
  await expect(microphoneButton).toHaveClass(/muted-speaking-reminder/)
  await expect(reminderTooltip).toBeVisible()
  await expect(reminderTooltip).toHaveText('你正在静音时说话')

  await setMutedSpeakingReminderVisible(page, false)
  await expect(microphoneButton).not.toHaveClass(/muted-speaking-reminder/)
  await expect(reminderTooltip).toHaveCount(0)
})

test('他人的新消息播放提示音，自己的消息不播放', async ({ page, request, isMobile }, testInfo) => {
  await installToneCounter(page)
  await expect(page.locator('.rail-status.online')).toBeAttached()

  await request.post('/api/auth/login', { data: { username, password } })
  const guildID = await firstJoinedGuildID(request)
  const bootstrapResponse = await request.get(`/api/guilds/${guildID}/bootstrap`)
  const bootstrap = await bootstrapResponse.json() as { channels: Array<{ id: number; type: string; name: string }> }
  const activeTextChannel = bootstrap.channels.find((channel) => channel.type === 'text')!
  const extraChannelName = `静默频道${Date.now().toString(36).slice(-5)}`
  const channelResponse = await request.post(`/api/guilds/${guildID}/channels`, { data: { type: 'text', name: extraChannelName } })
  expect(channelResponse.ok()).toBeTruthy()
  const extraChannel = (await channelResponse.json() as { channel: { id: number } }).channel
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `sound_${suffix}`,
    displayName: `提示音测试${suffix.slice(-3)}`,
    password: 'sound-member-password',
    role: 'member',
  }
  await createGuildMember(request, guildID, account)

  const other = await createRequestContext.newContext({ baseURL })
  try {
    const loginResponse = await other.post('/api/auth/login', { data: { username: account.username, password: account.password } })
    expect(loginResponse.ok()).toBeTruthy()
    if (isMobile) await page.waitForTimeout(700)
    if (isMobile) await page.getByTitle('频道', { exact: true }).click()
    await expect(page.getByRole('button', { name: new RegExp(extraChannelName) })).toBeAttached()
    const beforeInactiveMessage = await toneCount(page)
    const inactiveMessage = `非当前频道静默检查 ${Date.now()}`
    const inactiveResponse = await other.post(`/api/guilds/${guildID}/channels/${extraChannel.id}/messages`, { data: { content: inactiveMessage } })
    expect(inactiveResponse.ok()).toBeTruthy()
    await expect(page.getByRole('button', { name: new RegExp(extraChannelName) }).locator('.channel-unread')).toHaveText('1')
    await page.waitForTimeout(150)
    expect(await toneCount(page)).toBe(beforeInactiveMessage)
    if (isMobile) await page.getByRole('button', { name: /文字聊天.*最近/ }).click()

    const beforeOtherMessage = await toneCount(page)
    const otherMessage = `他人提示音检查 ${Date.now()}`
    const sendResponse = await other.post(`/api/guilds/${guildID}/channels/${activeTextChannel.id}/messages`, { data: { content: otherMessage } })
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
    await request.delete(`/api/guilds/${guildID}/channels/${extraChannel.id}`)
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
  const messageBaseTime = new Date()
  messageBaseTime.setHours(12, 0, 0, 0)
  const makeMessage = (id: number, content: string) => ({
    id,
    channelId: channelID,
    userId: currentUser.id,
    username: currentUser.username,
    displayName: currentUser.displayName,
    role: currentUser.role,
    content,
    createdAt: new Date(messageBaseTime.getTime() - (newestID - id) * 1000).toISOString(),
  })

  await page.route('**/api/guilds/*/bootstrap', async (route) => {
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
  await page.route('**/api/guilds/*/channels/*/messages?**', async (route) => {
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
  await expect(page.locator('.message-date-divider')).toHaveCount(1)
  const anchor = page.getByText(`虚拟消息 ${newestID - 49}`, { exact: true })
  const anchorTop = await anchor.evaluate((element) => element.getBoundingClientRect().top)
  await loadEarlier.click()
  await expect(anchor).toBeVisible()
  await expect.poll(() => anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(anchorTop, 0)
  await expect.poll(() => page.locator('.message-row').count()).toBeLessThan(40)

  await messageList.evaluate((element) => { element.scrollTop = 0 })
  await expect(page.getByText('这是 #文字聊天 的开始。')).toBeVisible()
  await expect(page.locator('.message-date-divider')).toHaveCount(1)
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

test('消息按本地自然日显示日期分隔线并在零点更新', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-07-25T12:00:00Z') })
  const dates = await page.evaluate(() => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const sameYear = new Date(now.getFullYear(), 0, 15, 9)
    const previousYear = new Date(now.getFullYear() - 1, 11, 31, 9)
    const monthDay = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
    const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    const nextMidnight = new Date(now)
    nextMidnight.setHours(24, 0, 0, 0)
    return {
      today: today.toISOString(),
      yesterdayMorning: yesterday.toISOString(),
      yesterdayAfternoon: new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 15).toISOString(),
      sameYear: sameYear.toISOString(),
      previousYear: previousYear.toISOString(),
      sameYearLabel: monthDay.format(sameYear),
      previousYearLabel: fullDate.format(previousYear),
      yesterdayAfterMidnightLabel: monthDay.format(yesterday),
      millisecondsToMidnight: nextMidnight.getTime() - now.getTime(),
    }
  })
  let channelID = 0
  let currentUser = { id: 0, username: '', displayName: '', role: 'member' }

  await page.routeWebSocket(/\/api\/ws\?/, () => {})
  await page.route('**/api/guilds/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    currentUser = {
      id: payload.membership.userId,
      username: payload.membership.username,
      displayName: payload.membership.displayName,
      role: payload.membership.role,
    }
    channelID = payload.channels.find((channel: { type: string }) => channel.type === 'text').id
    await route.fulfill({ response, json: payload })
  })
  await page.route('**/api/guilds/*/channels/*/messages?**', async (route) => {
    const timestamps = [dates.previousYear, dates.sameYear, dates.yesterdayMorning, dates.yesterdayAfternoon, dates.today]
    const messages = timestamps.map((createdAt, index) => ({
      id: 20_000 + index,
      channelId: channelID,
      userId: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      role: currentUser.role,
      content: `日期消息 ${index + 1}`,
      createdAt,
    }))
    await route.fulfill({ json: { messages, hasMore: false } })
  })

  await page.reload()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  await expect(page.locator('.message-date-divider')).toHaveText([
    dates.previousYearLabel,
    dates.sameYearLabel,
    '昨天',
    '今天',
  ])

  await page.clock.fastForward(dates.millisecondsToMidnight + 200)
  await expect(page.getByRole('separator', { name: '今天' })).toHaveCount(0)
  await expect(page.getByRole('separator', { name: '昨天' })).toHaveCount(1)
  await expect(page.getByRole('separator', { name: dates.yesterdayAfterMidnightLabel })).toHaveCount(1)
})

test('成员列表按钮在桌面和中等宽度均可切换面板', async ({ page, isMobile }) => {
  test.skip(isMobile, '由桌面项目覆盖宽屏和中等宽度布局')
  const memberButton = page.getByRole('button', { name: /成员列表/ })
  const permanentList = page.locator('.app-shell > .member-list')
  const channelSidebar = page.locator('.app-shell > .channel-sidebar')

  await expect(permanentList).toBeVisible()
  await expect(channelSidebar).toHaveCSS('width', '300px')
  await expect(channelSidebar.locator('.current-user')).toHaveCount(0)
  await expect(channelSidebar.locator('.user-controls')).toHaveCount(1)
  await expect(page.locator('.guild-rail .account-trigger')).toBeVisible()
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
  await openGuildAdmin(page)

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
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${isMobile ? 'm' : 'd'}_${testInfo.workerIndex}`
  const account = {
    username: `delete_${suffix}`,
    displayName: `待删除账号${suffix.slice(-3)}`,
    password: 'delete-member-password',
    role: 'member',
  }
  const created = { user: await createGuildMember(request, guildID, account) }
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

async function playSoundThroughStore(page: Page, bypassRateLimit: boolean) {
  await page.evaluate((bypass) => {
    type SoundStoreTestState = { play: (sound: 'leave', options?: { bypassRateLimit?: boolean }) => void }
    type PiniaTestState = { _s: Map<string, SoundStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const sounds = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('sounds')
    if (!sounds) throw new Error('未找到提示音 store')
    sounds.play('leave', { bypassRateLimit: bypass })
  }, bypassRateLimit)
}

async function setSoundSuppressedThroughStore(page: Page, suppressed: boolean) {
  await page.evaluate((value) => {
    type SoundStoreTestState = { setSuppressed: (suppressed: boolean) => void }
    type PiniaTestState = { _s: Map<string, SoundStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const sounds = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('sounds')
    if (!sounds) throw new Error('未找到提示音 store')
    sounds.setSuppressed(value)
  }, suppressed)
}

async function playMutedSpeakingReminderThroughStore(page: Page) {
  await page.evaluate(() => {
    type SoundStoreTestState = { playMutedSpeakingReminder: () => void }
    type PiniaTestState = { _s: Map<string, SoundStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const sounds = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('sounds')
    if (!sounds) throw new Error('未找到提示音 store')
    sounds.playMutedSpeakingReminder()
  })
}

async function setSoundEnabledThroughStore(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    type SoundStoreTestState = { setEnabled: (enabled: boolean) => void }
    type PiniaTestState = { _s: Map<string, SoundStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const sounds = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('sounds')
    if (!sounds) throw new Error('未找到提示音 store')
    sounds.setEnabled(value)
  }, enabled)
}

async function setMutedSpeakingReminderVisible(page: Page, visible: boolean) {
  await page.evaluate((value) => {
    type VoiceStoreTestState = { mutedSpeakingReminderVisible: boolean }
    type PiniaTestState = { _s: Map<string, VoiceStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const voice = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('voice')
    if (!voice) throw new Error('未找到语音 store')
    voice.mutedSpeakingReminderVisible = value
  }, visible)
}

async function setSyntheticVoiceConnection(page: Page, options: {
  status?: 'connecting' | 'connected' | 'reconnecting'
  guildName?: string
  channelName?: string
  audioBitrateKbps?: number
} = {}) {
  await page.evaluate((summary) => {
    type VoiceStoreTestState = {
      status: 'connecting' | 'connected' | 'reconnecting'
      connectedChannelId: number | null
      connectedGuildName: string
      connectedChannelName: string
      updateConnectedChannelSettings: (channel: { id: number; audioBitrateKbps?: number }) => unknown
    }
    type PiniaTestState = { _s: Map<string, VoiceStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const voice = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('voice')
    if (!voice) throw new Error('未找到语音 store')
    voice.status = summary.status ?? 'connected'
    voice.connectedGuildName = summary.guildName ?? '测试服务器'
    voice.connectedChannelName = summary.channelName ?? '测试语音频道'
    if (summary.audioBitrateKbps !== undefined) {
      voice.connectedChannelId = 99_999
      voice.updateConnectedChannelSettings({ id: 99_999, audioBitrateKbps: summary.audioBitrateKbps })
    }
  }, options)
}

async function setSyntheticDeviceChange(page: Page, kind: 'input' | 'output' | null, deviceId: string) {
  await page.evaluate(({ nextKind, nextDeviceId }) => {
    type VoiceStoreTestState = {
      deviceChangingKind: 'input' | 'output' | null
      deviceChangingId: string
    }
    type PiniaTestState = { _s: Map<string, VoiceStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const voice = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('voice')
    if (!voice) throw new Error('未找到语音 store')
    voice.deviceChangingKind = nextKind
    voice.deviceChangingId = nextDeviceId
  }, { nextKind: kind, nextDeviceId: deviceId })
}

test('平台账号列表和详情保持独立滚动', async ({ page, isMobile }) => {
  await page.route('**/api/platform/users', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const users = [
      ...payload.users,
      ...Array.from({ length: 40 }, (_, index) => ({
        id: 20_000 + index,
        username: `platform-scroll-${index + 1}`,
        displayName: `平台滚动测试账号 ${String(index + 1).padStart(2, '0')}`,
        role: 'member',
        voiceMuted: false,
        textMuted: false,
        permanentlyBanned: false,
        createdAt: new Date().toISOString(),
      })),
    ]
    await route.fulfill({ response, json: { ...payload, users } })
  })

  await page.setViewportSize({ width: isMobile ? 412 : 1200, height: 500 })
  await openPlatformAccounts(page)
  const panel = page.getByRole('dialog', { name: '平台管理' })
  const content = panel.locator('.admin-content')
  const list = panel.locator('.admin-user-list')
  const detail = panel.locator('.user-admin-detail')
  await expect(list).toBeVisible()
  await expect(detail).toBeVisible()

  const layout = await panel.evaluate((element) => {
    const contentElement = element.querySelector<HTMLElement>('.admin-content')!
    const listElement = element.querySelector<HTMLElement>('.admin-user-list')!
    const detailElement = element.querySelector<HTMLElement>('.user-admin-detail')!
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
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(content).toHaveClass(/contained/)
})

test('管理控制台成员列表和详情分别滚动', async ({ page, isMobile }) => {
  await page.route('**/api/guilds/*/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    const members = [
      ...payload.members.map((member: { userId: number; role: string }) => member.userId === payload.membership.userId ? member : { ...member, role: 'member' }),
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
  await openGuildAdmin(page)
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
  await expect(content).toHaveClass(/contained/)
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
  await expect(page.locator('.guild-title strong')).not.toBeEmpty()
  await page.getByTitle('关闭').click()
  await page.getByRole('button', { name: /成员列表/ }).click()
  await expect(page.locator('.drawer-header strong')).toHaveText('成员')
  const viewport = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(viewport.width).toBeLessThanOrEqual(viewport.client)
})

test('自定义提示音上传成功、可试听并持久化到 IndexedDB', async ({ page }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()

  await installToneCounter(page)
  await installBufferSourceCounter(page)

  const row = page.locator('.sound-event-block[data-sound="join"]')
  const dropdown = row.getByRole('combobox', { name: '加入语音音效' })

  const presetBefore = await toneCount(page)
  await row.getByRole('button', { name: '试听加入语音音效' }).click()
  await expect.poll(() => toneCount(page)).toBe(presetBefore + 2)

  await expect(page.locator('input[data-sound="join"]')).toBeAttached()
  await page.locator('input[data-sound="join"]').setInputFiles({ name: 'custom-join.wav', mimeType: 'audio/wav', buffer: synthWavBuffer(0.2) })
  await expect(dropdown).toHaveValue('__custom__')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.notificationSounds.source.join'))).toBe('custom')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.notificationSounds.preset.join'))).toBe('rise-duo')
  await expect.poll(() => getCustomSoundFromIDB(page, 'join')).toBeTruthy()

  const customBefore = await bufferSourceCount(page)
  await row.getByRole('button', { name: '试听加入语音音效' }).click()
  await expect.poll(() => bufferSourceCount(page)).toBe(customBefore + 1)

  await page.reload()
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()
  await expect(page.locator('.sound-event-block[data-sound="join"]').getByRole('combobox', { name: '加入语音音效' })).toHaveValue('__custom__')
})

test('删除自定义提示音回退到上一次系统预置选择', async ({ page }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()

  const row = page.locator('.sound-event-block[data-sound="join"]')
  const dropdown = row.getByRole('combobox', { name: '加入语音音效' })
  await dropdown.selectOption('gentle-triple')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.notificationSounds.preset.join'))).toBe('gentle-triple')

  await row.locator('input[data-sound="join"]').setInputFiles({ name: 'custom-join.wav', mimeType: 'audio/wav', buffer: synthWavBuffer(0.2) })
  await expect(dropdown).toHaveValue('__custom__')
  await expect.poll(() => page.evaluate(() => ({
    source: localStorage.getItem('cws.notificationSounds.source.join'),
    preset: localStorage.getItem('cws.notificationSounds.preset.join'),
  }))).toEqual({ source: 'custom', preset: 'gentle-triple' })

  await row.getByRole('button', { name: '删除加入语音自定义音效' }).click()
  await expect(dropdown).toHaveValue('gentle-triple')
  await expect.poll(() => page.evaluate(() => ({
    source: localStorage.getItem('cws.notificationSounds.source.join'),
    preset: localStorage.getItem('cws.notificationSounds.preset.join'),
  }))).toEqual({ source: 'preset', preset: 'gentle-triple' })
  await expect.poll(() => getCustomSoundFromIDB(page, 'join')).toBeNull()
})

test('上传校验拒绝过大、非法格式与过长音频的文件', async ({ page }) => {
  await openUserSettings(page)
  await page.getByRole('button', { name: '音效', exact: true }).click()

  const row = page.locator('.sound-event-block[data-sound="leave"]')
  const fileInput = page.locator('input[data-sound="leave"]')

  await fileInput.setInputFiles({ name: 'big.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(600 * 1024) })
  await expect(row.locator('.form-error')).toHaveText('音频大小不能超过 512 KB')

  await fileInput.setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect(row.locator('.form-error')).toHaveText('请选择 MP3、WAV、OGG、M4A 或 WEBM 音频')

  await fileInput.setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: synthWavBuffer(3.5) })
  await expect(row.locator('.form-error')).toHaveText('音频时长不能超过 3 秒')

  await expect.poll(() => getCustomSoundFromIDB(page, 'leave')).toBeNull()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.notificationSounds.source.leave'))).toBe('preset')
})

async function installBufferSourceCounter(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __cwsBufferSourceCount?: number }
    target.__cwsBufferSourceCount = 0
    const original = AudioContext.prototype.createBufferSource
    AudioContext.prototype.createBufferSource = function patchedCreateBufferSource(this: AudioContext) {
      target.__cwsBufferSourceCount = (target.__cwsBufferSourceCount ?? 0) + 1
      return original.call(this)
    }
  })
}

async function bufferSourceCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __cwsBufferSourceCount?: number }).__cwsBufferSourceCount ?? 0)
}

function synthWavBuffer(seconds: number): Buffer {
  const sampleRate = 8000
  const bitDepth = 16
  const channels = 1
  const numSamples = Math.ceil(seconds * sampleRate)
  const dataSize = numSamples * channels * (bitDepth / 8)
  const headerSize = 44
  const buffer = Buffer.alloc(headerSize + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(headerSize + dataSize - 8, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28)
  buffer.writeUInt16LE(channels * (bitDepth / 8), 32)
  buffer.writeUInt16LE(bitDepth, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5 * 32767
    buffer.writeInt16LE(sample | 0, headerSize + i * 2)
  }
  return buffer
}

async function getCustomSoundFromIDB(page: Page, event: string): Promise<unknown> {
  return page.evaluate(async (e) => {
    return new Promise<unknown>((resolve) => {
      const request = indexedDB.open('cws.sounds')
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('customSounds')) {
          db.close()
          resolve(null)
          return
        }
        const tx = db.transaction('customSounds', 'readonly')
        const get = tx.objectStore('customSounds').get(e)
        get.onsuccess = () => resolve(get.result ?? null)
        get.onerror = () => resolve(null)
        tx.oncomplete = () => db.close()
      }
      request.onerror = () => resolve(null)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        resolve(null)
      }
    })
  }, event)
}
