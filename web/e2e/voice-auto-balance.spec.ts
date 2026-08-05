// 自动音量平衡 e2e（ADR-0026）：三端真实语音——
// 两个说话端（fixture 确定性音频，麦克风增益 30% vs 300% 制造电平差）
// + 一个收听端（admin）。断言：
//   1. 设置面板"自动音量平衡"开关持久化（localStorage）
//   2. 参与者菜单提示行随开关显隐
//   3. DOM 可观测标记（data-voice-balance-gain）收敛：轻声说话者修正增益 > 大声说话者
//   4. 关闭开关后标记移除
// 仅在 E2E_LIVEKIT=1 且专用 fixture 项目（desktop-chromium-voice-balance）下运行。
import { expect, test, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

test('自动音量平衡：开关持久化、菜单提示行与逐参与者增益收敛', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')
  test.setTimeout(180_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const channelName = `平衡频道${suffix.slice(-6)}`
  const channelRes = await request.post(`/api/guilds/${guildID}/channels`, { data: { type: 'voice', name: channelName } })
  expect(channelRes.ok()).toBeTruthy()
  const channelID = (await channelRes.json() as { channel: { id: number } }).channel.id

  // 轻声说话端（麦克风增益 30%）与大声说话端（300%）：发送电平差 20dB。
  const accounts = [
    { username: `balance_quiet_${suffix}`, displayName: `轻声端${suffix.slice(-4)}`, password: 'balance-quiet-password' },
    { username: `balance_loud_${suffix}`, displayName: `大声端${suffix.slice(-4)}`, password: 'balance-loud-password' },
  ]
  const micGainByUsername = new Map(accounts.map((account, index) => [account.username, index === 0 ? '0.3' : '3']))
  const speakerIds = new Map<string, number>()
  const contexts: Array<{ context: Awaited<ReturnType<typeof browser.newContext>>; page: Page }> = []

  try {
    for (const account of accounts) {
      speakerIds.set(account.username, (await createGuildMember(request, guildID, account)).id)
    }
    const pages: Page[] = []
    // 收听端：admin（真实 app），先设麦克风增益再加入同一语音频道
    const listenerContext = await browser.newContext({ permissions: ['microphone'] })
    await listenerContext.grantPermissions(['microphone'], { origin: baseURL })
    const listenerPage = await listenerContext.newPage()
    contexts.push({ context: listenerContext, page: listenerPage })
    pages.push(listenerPage)
    await loginVoicePage(listenerPage, { username: adminUsername, password: adminPassword })
    await setMicrophoneGain(listenerPage, '1')
    await listenerPage.getByRole('button', { name: new RegExp(channelName) }).click()
    await listenerPage.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })

    // 两个说话端：先设麦克风增益再加入同一语音频道
    for (const account of accounts) {
      const context = await browser.newContext({ permissions: ['microphone'] })
      await context.grantPermissions(['microphone'], { origin: baseURL })
      const page = await context.newPage()
      contexts.push({ context, page })
      pages.push(page)
      await loginVoicePage(page, account)
      await setMicrophoneGain(page, micGainByUsername.get(account.username)!)
      await page.getByRole('button', { name: new RegExp(channelName) }).click()
      await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    }

    const quietId = speakerIds.get(accounts[0].username)!
    const loudId = speakerIds.get(accounts[1].username)!
    await expect(listenerPage.locator('.voice-member').filter({ hasText: accounts[0].displayName })).toBeVisible()
    await expect(listenerPage.locator('.voice-member').filter({ hasText: accounts[1].displayName })).toBeVisible()

    // 1. 开关默认关闭 → 打开并持久化
    let settingsDialog = await openAudioSettings(listenerPage)
    await expect(settingsDialog.getByLabel('自动音量平衡')).not.toBeChecked()
    await settingsDialog.getByLabel('自动音量平衡').check()
    await expect(settingsDialog.getByLabel('自动音量平衡')).toBeChecked()
    await expect.poll(() => listenerPage.evaluate(() => localStorage.getItem('cws.autoVoiceBalance'))).toBe('true')
    await settingsDialog.getByTitle('关闭').click()
    await expect(settingsDialog).toHaveCount(0)

    // 2. 参与者菜单提示行可见
    const quietRow = listenerPage.locator('.voice-member').filter({ hasText: accounts[0].displayName })
    await quietRow.locator('.voice-member-main').click({ button: 'right' })
    const quietPanel = listenerPage.getByRole('dialog', { name: `${accounts[0].displayName}的语音参与者操作` })
    await expect(quietPanel.getByText('自动音量平衡已开启，音量滑杆作为相对偏置')).toBeVisible()
    await listenerPage.keyboard.press('Escape')
    await expect(quietPanel).toHaveCount(0)

    // 3. 增益收敛：轻声说话者修正增益显著大于大声说话者（标记 = 修正 dB）
    await expect.poll(async () => {
      const values = await listenerPage.evaluate(([quiet, loud]) => {
        const read = (userId: number) => {
          const element = document.querySelector<HTMLElement>(`#voice-audio-root audio[data-user-id="${userId}"]`)
          return element?.dataset.voiceBalanceGain ?? null
        }
        return [read(quiet), read(loud)]
      }, [quietId, loudId] as const)
      if (values[0] === null || values[1] === null) return false
      return Number(values[0]) > Number(values[1])
    }).toBe(true)

    const converged = await listenerPage.evaluate(([quiet, loud]) => {
      const read = (userId: number) => Number(document.querySelector<HTMLElement>(`#voice-audio-root audio[data-user-id="${userId}"]`)?.dataset.voiceBalanceGain ?? NaN)
      return { quietGainDb: read(quiet), loudGainDb: read(loud) }
    }, [quietId, loudId] as const)
    console.log(`[e2e] 平衡收敛：轻声端 ${converged.quietGainDb}dB / 大声端 ${converged.loudGainDb}dB`)
    expect(converged.quietGainDb).toBeGreaterThan(converged.loudGainDb)

    // 4. 关闭开关：标记移除、提示行消失（合成回纯手动）
    settingsDialog = await openAudioSettings(listenerPage)
    await settingsDialog.getByLabel('自动音量平衡').uncheck()
    await settingsDialog.getByTitle('关闭').click()
    await expect(settingsDialog).toHaveCount(0)
    await expect.poll(() => listenerPage.evaluate((userId) => {
      const element = document.querySelector<HTMLElement>(`#voice-audio-root audio[data-user-id="${userId}"]`)
      return element?.dataset.voiceBalanceGain ?? null
    }, quietId)).toBeNull()
    await quietRow.locator('.voice-member-main').click({ button: 'right' })
    await expect(quietPanel.getByText('自动音量平衡已开启，音量滑杆作为相对偏置')).toHaveCount(0)
    await listenerPage.keyboard.press('Escape')
    // 关闭态不落键（与 cws.muted 等键的移除惯例一致）
    await expect.poll(() => listenerPage.evaluate(() => localStorage.getItem('cws.autoVoiceBalance'))).toBeNull()
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    await request.delete(`/api/guilds/${guildID}/channels/${channelID}`)
    for (const account of accounts) {
      const accountID = speakerIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

async function loginVoicePage(page: Page, account: { username: string; password: string }) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
}

// 打开设置面板"音频"页，返回设置弹窗。
async function openAudioSettings(page: Page) {
  await page.getByTitle('用户账户').click()
  await page.getByRole('menu', { name: '用户账户操作' }).getByRole('menuitem', { name: '用户设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '用户设置' })
  await dialog.getByRole('button', { name: '音频', exact: true }).click()
  return dialog
}

// 在设置面板"音频"页设置麦克风增益（加入语音前）。
async function setMicrophoneGain(page: Page, gain: string) {
  const dialog = await openAudioSettings(page)
  await dialog.getByLabel('麦克风增益').fill(gain)
  await dialog.getByTitle('关闭').click()
  await expect(dialog).toHaveCount(0)
}
