import { expect, test } from '@playwright/test'

const username = process.env.E2E_USERNAME ?? 'admin'
const password = process.env.E2E_PASSWORD ?? 'admin-password-123'

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

  await expect(permanentList).toBeVisible()
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
  await page.setViewportSize({ width: 900, height: 800 })
  await expect(page.locator('.app-shell > .channel-sidebar')).toBeVisible()
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
