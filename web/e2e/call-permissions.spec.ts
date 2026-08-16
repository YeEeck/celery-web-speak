import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'

// 通话权限设置 e2e：这些流程都在呼入仲裁/设置接口层完成，不加入 LiveKit
// 房间，因此不依赖 E2E_LIVEKIT。
test('可被呼叫设置与来电暂时屏蔽阻止后续呼叫', async ({ browser, request }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('android'), '本用例只覆盖桌面端布局')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const accounts = [
    { username: `perm_a_${suffix}`, displayName: `权限甲${suffix.slice(-6)}`, password: 'perm-member-password-a' },
    { username: `perm_b_${suffix}`, displayName: `权限乙${suffix.slice(-6)}`, password: 'perm-member-password-b' },
  ]
  const accountIds = new Map<string, number>()
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of accounts) {
      accountIds.set(account.username, (await createGuildMember(request, guildID, account)).id)
    }
    for (const account of accounts) {
      const context = await browser.newContext()
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginPermissionPage(page, account)
    }

    const callerPage = contexts[0].page
    const calleePage = contexts[1].page
    const calleeName = accounts[1].displayName

    // 1. 关闭可被呼叫设置：主叫只看到统一隐式文案，被叫不出现来电浮层。
    let settings = await openCallSettings(calleePage)
    const receivingToggle = settings.getByLabel('允许别人发起语音通话给我')
    await receivingToggle.uncheck()
    await expect(receivingToggle).not.toBeChecked()
    await closeSettings(calleePage)

    await startCallFromMemberList(callerPage, calleeName)
    await expect(callerPage.getByText('对方暂时无法接听', { exact: true }).first()).toBeVisible()
    await expect(callerPage.getByRole('dialog', { name: '通话浮层' })).toHaveCount(0)
    await expect(calleePage.getByRole('dialog', { name: '通话浮层' })).toHaveCount(0)

    // 2. 恢复可被呼叫设置后来电；被叫点「暂时屏蔽 24 小时」：当前来电被拒，
    //    且之后再次呼叫被统一拒入。
    settings = await openCallSettings(calleePage)
    await settings.getByLabel('允许别人发起语音通话给我').check()
    await expect(settings.getByLabel('允许别人发起语音通话给我')).toBeChecked()
    await closeSettings(calleePage)

    await startCallFromMemberList(callerPage, calleeName)
    const calleeOverlay = calleePage.getByRole('dialog', { name: '通话浮层' })
    await expect(calleeOverlay).toBeVisible()
    await calleeOverlay.getByRole('button', { name: '暂时屏蔽 24 小时' }).click()
    await expect(calleeOverlay).toHaveCount(0)
    await expect(callerPage.getByRole('dialog', { name: '通话浮层' })).toHaveCount(0)
    await expect(callerPage.getByText('对方已拒绝', { exact: true }).first()).toBeVisible()

    await startCallFromMemberList(callerPage, calleeName)
    await expect(callerPage.getByText('对方暂时无法接听', { exact: true }).first()).toBeVisible()
    await expect(calleeOverlay).toHaveCount(0)

    // 3. 通话设置页能看到该暂时屏蔽，可转为永久并解除。
    settings = await openCallSettings(calleePage)
    await expect(settings.getByText(accounts[0].displayName, { exact: true })).toBeVisible()
    await expect(settings.getByText(/暂时屏蔽/).first()).toBeVisible()
    await settings.getByRole('button', { name: '转为永久屏蔽' }).click()
    await expect(settings.getByText('永久屏蔽', { exact: true })).toBeVisible()
    await settings.getByRole('button', { name: '解除屏蔽' }).click()
    await expect(settings.getByText('你还没有屏蔽任何人的呼叫', { exact: true })).toBeVisible()
    await closeSettings(calleePage)

    // 清理当前振铃（解除后补一次普通呼叫并拒绝，避免超时定时器悬挂）。
    await startCallFromMemberList(callerPage, calleeName)
    await expect(calleeOverlay).toBeVisible()
    await calleeOverlay.getByRole('button', { name: '拒绝' }).click()
    await expect(calleeOverlay).toHaveCount(0)
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (const account of accounts) {
      const accountID = accountIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

test('个人信息卡片永久屏蔽且可在设置页搜索管理', async ({ browser, request }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('android'), '本用例只覆盖桌面端布局')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const accounts = [
    { username: `card_a_${suffix}`, displayName: `卡片甲${suffix.slice(-6)}`, password: 'card-member-password-a' },
    { username: `card_b_${suffix}`, displayName: `卡片乙${suffix.slice(-6)}`, password: 'card-member-password-b' },
  ]
  const accountIds = new Map<string, number>()
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of accounts) {
      accountIds.set(account.username, (await createGuildMember(request, guildID, account)).id)
    }
    for (const account of accounts) {
      const context = await browser.newContext()
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginPermissionPage(page, account)
    }

    const ownerPage = contexts[0].page
    const targetPage = contexts[1].page
    const targetName = accounts[1].displayName

    // 从个人信息卡片永久屏蔽目标。
    await openProfileCard(ownerPage, targetName)
    const profileCard = ownerPage.getByRole('dialog', { name: `${targetName}的个人信息卡片` })
    await profileCard.getByRole('button', { name: '呼叫屏蔽' }).click()
    await profileCard.getByRole('button', { name: '永久屏蔽' }).click()
    // 操作成功后菜单关闭；重新展开验证状态已持久化。
    await profileCard.getByRole('button', { name: '呼叫屏蔽' }).click()
    await expect(profileCard.getByText('永久屏蔽中', { exact: true })).toBeVisible()

    // 对方此时呼叫被拒入。
    await startCallFromMemberList(targetPage, accounts[0].displayName)
    await expect(targetPage.getByText('对方暂时无法接听', { exact: true }).first()).toBeVisible()

    // 设置页列表与搜索都能管理这条屏蔽；搜索展示状态并解除。
    const settings = await openCallSettings(ownerPage)
    await expect(settings.getByText(targetName, { exact: true })).toBeVisible()
    const search = settings.getByLabel('搜索与你共享服务器的用户')
    await search.fill(targetName)
    await expect(settings.getByRole('button', { name: '转为暂时屏蔽 24 小时' })).toBeVisible()
    await settings.getByRole('button', { name: '转为暂时屏蔽 24 小时' }).click()
    await expect(settings.getByText(/暂时屏蔽/).first()).toBeVisible()
    await search.fill('')
    await settings.getByRole('button', { name: '解除屏蔽' }).click()
    await expect(settings.getByText('你还没有屏蔽任何人的呼叫', { exact: true })).toBeVisible()
    await closeSettings(ownerPage)

    // 卡片菜单内再次永久屏蔽并解除：菜单就地更新，解除后对方可再次呼叫。
    await openProfileCard(ownerPage, targetName)
    await profileCard.getByRole('button', { name: '呼叫屏蔽' }).click()
    await profileCard.getByRole('button', { name: '永久屏蔽' }).click()
    await profileCard.getByRole('button', { name: '呼叫屏蔽' }).click()
    await expect(profileCard.getByText('永久屏蔽中', { exact: true })).toBeVisible()
    await profileCard.getByRole('button', { name: '解除屏蔽' }).click()
    await profileCard.getByRole('button', { name: '呼叫屏蔽' }).click()
    await expect(profileCard.getByRole('button', { name: '永久屏蔽' })).toBeVisible()
    await expect(profileCard.getByText('永久屏蔽中', { exact: true })).toHaveCount(0)

    // 解除生效：对方再次呼叫进入振铃，随后拒绝清理当前振铃。
    await startCallFromMemberList(targetPage, accounts[0].displayName)
    const ownerOverlay = ownerPage.getByRole('dialog', { name: '通话浮层' })
    await expect(ownerOverlay).toBeVisible()
    await ownerOverlay.getByRole('button', { name: '拒绝' }).click()
    await expect(ownerOverlay).toHaveCount(0)
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (const account of accounts) {
      const accountID = accountIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

async function loginPermissionPage(page: Page, account: { username: string; password: string }) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
}

async function openCallSettings(page: Page): Promise<Locator> {
  await page.getByTitle('用户设置').click()
  const settings = page.getByRole('dialog', { name: '用户设置' })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '通话' }).click()
  return settings
}

async function closeSettings(page: Page) {
  await page.getByRole('dialog', { name: '用户设置' }).getByTitle('关闭').click()
}

async function openProfileCard(page: Page, displayName: string) {
  const memberRow = page.locator('.member-row', { hasText: displayName })
  await memberRow.click()
  const profileCard = page.getByRole('dialog', { name: `${displayName}的个人信息卡片` })
  await expect(profileCard).toBeVisible()
}

async function startCallFromMemberList(page: Page, displayName: string) {
  await openProfileCard(page, displayName)
  const profileCard = page.getByRole('dialog', { name: `${displayName}的个人信息卡片` })
  await profileCard.getByRole('button', { name: '语音通话' }).click()
}
