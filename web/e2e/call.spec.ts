import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

// 1:1 临时语音通话（票 03）：两个标签页互拨、接听、通话、挂断。通话房间
// 依赖真实 LiveKit（call-<callID> ad-hoc 房间），故与 voice.spec.ts 一样在该
// 环境变量下才运行。会话本身不要求频道在通话前已加入（通话与频道叠加并存）。
test('两个独立账号可互拨、接听、通话并挂断', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const displaySuffix = suffix.slice(-6)
  const accounts = [
    { username: `call_a_${suffix}`, displayName: `通话甲${displaySuffix}`, password: 'call-member-password-a' },
    { username: `call_b_${suffix}`, displayName: `通话乙${displaySuffix}`, password: 'call-member-password-b' },
  ]
  const accountIds = new Map<string, number>()
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of accounts) {
      accountIds.set(account.username, (await createGuildMember(request, guildID, account)).id)
    }
    for (const account of accounts) {
      const context = await browser.newContext({ permissions: ['microphone'] })
      await context.grantPermissions(['microphone'], { origin: baseURL })
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
    }

    const callerPage = contexts[0].page
    const calleePage = contexts[1].page
    const calleeName = accounts[1].displayName

    // 移动端：登录后频道抽屉已打开且成员名单在抽屉内，先关抽屉再开成员列表
    // （与 online-status.spec 的移动端成员名单交互保持一致）。
    if (testInfo.project.name.startsWith('android')) {
      await callerPage.getByTitle('关闭', { exact: true }).click()
      await callerPage.getByTitle('显示成员列表').click()
    }

    // 主叫从成员名单打开被叫的个人信息卡片，点击「语音通话」发起。
    // 移动端成员名单在抽屉实例（.member-list.drawer）里，inline 实例被 CSS 隐藏
    // 但仍在 DOM 中，需按实例分派避免 strict mode 双命中。
    const memberRow = testInfo.project.name.startsWith('android')
      ? callerPage.locator('.member-list.drawer .member-row', { hasText: calleeName })
      : callerPage.locator('.member-row', { hasText: calleeName })
    await memberRow.click()
    const profileCard = callerPage.getByRole('dialog', { name: `${calleeName}的个人信息卡片` })
    await expect(profileCard).toBeVisible()
    await expect(profileCard.getByRole('button', { name: '语音通话' })).toBeVisible()
    await profileCard.getByRole('button', { name: '语音通话' }).click()

    // 主叫进入呼出中，被叫看到来电。
    await expect(callerPage.getByRole('dialog', { name: '通话浮层' })).toBeVisible()
    await expect(callerPage.getByText('正在呼叫…', { exact: true })).toBeVisible()
    const calleeOverlay = calleePage.getByRole('dialog', { name: '通话浮层' })
    await expect(calleeOverlay).toBeVisible()
    await expect(calleeOverlay.getByText('来电', { exact: true })).toBeVisible()

    // 被叫接听，双方进入通话中。
    await calleeOverlay.getByRole('button', { name: '接听' }).click()
    const callerOverlay = callerPage.getByRole('dialog', { name: '通话浮层' })
    await expect(callerOverlay.getByText(/^\d{2}:\d{2}$/)).toBeVisible({ timeout: 20_000 })
    await expect(calleeOverlay.getByText(/^\d{2}:\d{2}$/)).toBeVisible({ timeout: 20_000 })

    // 通话中：麦克风静音切换，然后主叫挂断。
    const callerMuteButton = callerOverlay.getByRole('button', { name: '麦克风静音' })
    await expect(callerMuteButton).toBeVisible()
    await callerMuteButton.click()
    await expect(callerOverlay.getByRole('button', { name: '取消麦克风静音' })).toBeVisible()

    await callerOverlay.getByRole('button', { name: '挂断' }).click()

    // 挂断后双方浮层关闭。
    await expect(callerOverlay).toHaveCount(0)
    await expect(calleeOverlay).toHaveCount(0)
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (const account of accounts) {
      const accountID = accountIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

async function loginVoicePage(page: Page, account: { username: string; password: string }, mobile: boolean) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
  if (mobile) await page.getByTitle('频道', { exact: true }).click()
}
