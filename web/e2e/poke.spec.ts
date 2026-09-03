import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'

// 卡片戳一下主路径：两个独立账号同服登录，从成员名单打开对方个人信息卡片
// 后点「戳一下」。不依赖 LiveKit，不覆盖提及补全/高亮。
test('同服成员卡片戳一下后对端出现提示', async ({ browser, request }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('android'), '本用例只覆盖桌面端布局')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const accounts = [
    { username: `poke_a_${suffix}`, displayName: `戳甲${suffix.slice(-6)}`, password: 'poke-member-password-a' },
    { username: `poke_b_${suffix}`, displayName: `戳乙${suffix.slice(-6)}`, password: 'poke-member-password-b' },
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
      await loginPokePage(page, account)
    }

    const initiatorPage = contexts[0].page
    const targetPage = contexts[1].page
    const initiatorName = accounts[0].displayName
    const targetName = accounts[1].displayName

    await expect(initiatorPage.locator('.member-row', { hasText: targetName })).toBeVisible()
    await expect(targetPage.locator('.member-row', { hasText: initiatorName })).toBeVisible()

    await openProfileCard(initiatorPage, targetName)
    const profileCard = initiatorPage.getByRole('dialog', { name: `${targetName}的个人信息卡片` })
    const pokeButton = profileCard.getByRole('button', { name: '戳一下' })
    await expect(pokeButton).toBeVisible()
    await pokeButton.click()

    await expect(profileCard.getByRole('button', { name: '已戳' })).toBeDisabled()
    await expect(profileCard).toBeVisible()

    const pokePrompt = targetPage.getByRole('region', { name: '戳一下提示' })
    await expect(pokePrompt).toBeVisible()
    await expect(pokePrompt.getByRole('status', { name: `${initiatorName} 戳了你一下`, exact: true })).toBeVisible()
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (const account of accounts) {
      const accountID = accountIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

async function loginPokePage(page: Page, account: { username: string; password: string }) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
  await page.getByText('实时连接正常', { exact: true }).waitFor()
}

async function openProfileCard(page: Page, displayName: string) {
  const memberRow = page.locator('.member-row', { hasText: displayName })
  await memberRow.click()
  const profileCard = page.getByRole('dialog', { name: `${displayName}的个人信息卡片` })
  await expect(profileCard).toBeVisible()
}
