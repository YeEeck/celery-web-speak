import { expect, test, type Page } from '@playwright/test'

const username = process.env.E2E_USERNAME ?? 'admin'
const password = process.env.E2E_PASSWORD ?? 'admin-password-123'

async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('登录名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
}

async function openGuildAdmin(page: Page) {
  const trigger = page.getByTitle('服务器操作')
  if (!(await trigger.isVisible())) await page.getByTitle('频道', { exact: true }).click()
  await trigger.click()
  const menu = page.getByRole('menu', { name: /的服务器操作$/ })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '管理控制台', exact: true }).click()
  await expect(page.getByRole('heading', { name: '服务器管理' })).toBeVisible()
}

async function joinedGuildID(page: Page) {
  const response = await page.request.get('/api/bootstrap')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { guilds: Array<{ id: number; joined: boolean }> }
  const guild = payload.guilds.find((item) => item.joined)
  if (!guild) throw new Error('test account has no joined guild')
  return guild.id
}

test.beforeEach(async ({ page }) => {
  await login(page)
})

test('文字频道详情显示消息占用统计，语音频道不显示', async ({ page }) => {
  const guildID = await joinedGuildID(page)
  const channelName = `统计测试${Date.now().toString(36)}`
  const create = await page.request.post(`/api/guilds/${guildID}/channels`, { data: { type: 'text', name: channelName } })
  expect(create.ok()).toBeTruthy()
  const channelID = ((await create.json()) as { channel: { id: number } }).channel.id
  try {
    // 单条 1200 字符消息即可断言条数与字节数（1200 B → 1.2 KB），且发送总量低于接口限流
    const send = await page.request.post(`/api/guilds/${guildID}/channels/${channelID}/messages`, { data: { content: 'A'.repeat(1200) } })
    expect(send.ok()).toBeTruthy()

    await openGuildAdmin(page)
    await page.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true }).click()
    const detail = page.locator('.channel-admin-detail')
    await page.locator('.channel-admin-list').getByRole('button', { name: channelName, exact: true }).click()
    await expect(detail.locator('header h3')).toHaveText(channelName)
    await expect(detail.locator('.guild-metadata > div').filter({ hasText: '消息占用' }).locator('dd')).toHaveText('1 条消息 · 1.2 KB')

    // 语音频道不显示占用空间
    await page.locator('.channel-admin-list .channel-admin-item').first().click()
    await expect(detail.locator('.guild-metadata > div').filter({ hasText: '消息占用' })).toHaveCount(0)

    // API 契约：语音频道与不存在频道统计返回 404，清空语音频道同样 404
    const guildBootstrap = await (await page.request.get(`/api/guilds/${guildID}/bootstrap`)).json() as { channels: Array<{ id: number; type: string }> }
    const voiceChannelID = guildBootstrap.channels.find((channel) => channel.type === 'voice')!.id
    expect((await page.request.get(`/api/guilds/${guildID}/channels/${voiceChannelID}/stats`)).status()).toBe(404)
    expect((await page.request.get(`/api/guilds/${guildID}/channels/99999999/stats`)).status()).toBe(404)
    expect((await page.request.delete(`/api/guilds/${guildID}/channels/${voiceChannelID}/messages`)).status()).toBe(404)
  } finally {
    await page.request.delete(`/api/guilds/${guildID}/channels/${channelID}`)
  }
})

test('清空频道消息：两段式确认、频道与保留设置保留、成员端实时同步', async ({ page, isMobile }) => {
  const guildID = await joinedGuildID(page)
  const channelName = `清空测试${Date.now().toString(36)}`
  const create = await page.request.post(`/api/guilds/${guildID}/channels`, { data: { type: 'text', name: channelName } })
  expect(create.ok()).toBeTruthy()
  const channelID = ((await create.json()) as { channel: { id: number } }).channel.id
  const viewer = await page.context().newPage()
  try {
    const send = await page.request.post(`/api/guilds/${guildID}/channels/${channelID}/messages`, { data: { content: '清空验证消息' } })
    expect(send.ok()).toBeTruthy()

    // 第二客户端（同账号新页面）正在查看该频道
    await viewer.goto('/')
    await expect(viewer.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    if (isMobile) await viewer.getByTitle('频道', { exact: true }).click()
    await viewer.locator('.channel-row').filter({ hasText: channelName }).click()
    await expect(viewer.locator('.message-row').filter({ hasText: '清空验证消息' })).toHaveCount(1)

    // 管理员两段式清空
    await openGuildAdmin(page)
    await page.locator('.admin-tabs').getByRole('button', { name: '频道', exact: true }).click()
    const detail = page.locator('.channel-admin-detail')
    await page.locator('.channel-admin-list').getByRole('button', { name: channelName, exact: true }).click()
    await expect(detail.locator('header h3')).toHaveText(channelName)
    await detail.getByRole('button', { name: '清空消息', exact: true }).click()
    await expect(detail.getByText(/将永久删除 1 条消息/)).toBeVisible()
    await detail.getByRole('button', { name: '确认清空', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '频道消息已清空' })).toBeVisible()

    // 成员端消息立即消失，显示频道开始占位
    await expect(viewer.locator('.message-row')).toHaveCount(0)
    await expect(viewer.getByText(`这是 #${channelName} 的开始。`)).toBeVisible()

    // 频道与保留设置保留，统计归零
    await expect(page.locator('.channel-admin-list').getByRole('button', { name: channelName, exact: true })).toBeVisible()
    await expect(detail.getByLabel('保留消息数量')).toHaveValue('500')
    await expect(detail.locator('.guild-metadata > div').filter({ hasText: '消息占用' }).locator('dd')).toHaveText('0 条消息 · 0 B')

    // 第二阶段：成员离开目标频道后新消息产生未读，清空后未读清零
    if (isMobile) await viewer.getByTitle('频道', { exact: true }).click()
    await viewer.locator('.channel-row').filter({ hasText: /最近/ }).filter({ hasNotText: channelName }).first().click()
    await expect(viewer.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
    const sendMore = await page.request.post(`/api/guilds/${guildID}/channels/${channelID}/messages`, { data: { content: '清空验证消息' } })
    expect(sendMore.ok()).toBeTruthy()
    const targetRow = viewer.locator('.channel-row').filter({ hasText: channelName })
    if (isMobile) await viewer.getByTitle('频道', { exact: true }).click()
    await expect(targetRow.locator('.channel-unread')).toHaveText('1')
    await detail.getByRole('button', { name: '清空消息', exact: true }).click()
    await expect(detail.getByText(/将永久删除 1 条消息/)).toBeVisible()
    await detail.getByRole('button', { name: '确认清空', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '频道消息已清空' }).first()).toBeVisible()
    await expect(targetRow.locator('.channel-unread')).toHaveCount(0)
  } finally {
    await viewer.close()
    await page.request.delete(`/api/guilds/${guildID}/channels/${channelID}`)
  }
})
