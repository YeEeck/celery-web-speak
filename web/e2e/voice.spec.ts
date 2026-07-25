import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createServerMember, deletePlatformUser, firstJoinedServerID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

test('两个独立账号可建立并接收语音轨道', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const displaySuffix = suffix.slice(-6)
  const accounts = [
    { username: `voice_a_${suffix}`, displayName: `语音甲${displaySuffix}`, password: 'voice-member-password-a' },
    { username: `voice_b_${suffix}`, displayName: `语音乙${displaySuffix}`, password: 'voice-member-password-b' },
  ]
  const accountIds = new Map<string, number>()
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of accounts) {
      accountIds.set(account.username, (await createServerMember(request, serverID, account)).id)
    }
    for (const account of accounts) {
      const context = await browser.newContext({ permissions: ['microphone'] })
      await context.grantPermissions(['microphone'], { origin: baseURL })
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
      await installToneCounter(page)
      const tonesBeforeJoin = await toneCount(page)
      await page.getByRole('button', { name: /语音频道/ }).click()
      await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
      await expect(page.getByTitle('共享应用背景音', { exact: true })).toHaveCount(0)
      await expect.poll(() => toneCount(page)).toBeGreaterThanOrEqual(tonesBeforeJoin + 2)
    }

    await expect.poll(() => toneCount(contexts[0].page)).toBeGreaterThanOrEqual(4)
    for (const { page } of contexts) {
      await expect(page.locator('.voice-member').filter({ hasText: accounts[0].displayName })).toBeVisible()
      await expect(page.locator('.voice-member').filter({ hasText: accounts[1].displayName })).toBeVisible()
      await expect.poll(() => page.locator('#voice-audio-root audio').count()).toBeGreaterThanOrEqual(1)
    }

    await expectVoiceOrder(contexts.map(({ page }) => page), accounts.map(({ displayName }) => displayName))

    const secondAccountId = accountIds.get(accounts[1].username)!
    const promoteResponse = await request.patch(`/api/servers/${serverID}/members/${secondAccountId}/role`, { data: { role: 'admin' } })
    expect(promoteResponse.ok()).toBeTruthy()
    await expectVoiceOrder(contexts.map(({ page }) => page), [accounts[1].displayName, accounts[0].displayName])

    const demoteResponse = await request.patch(`/api/servers/${serverID}/members/${secondAccountId}/role`, { data: { role: 'member' } })
    expect(demoteResponse.ok()).toBeTruthy()
    await expectVoiceOrder(contexts.map(({ page }) => page), accounts.map(({ displayName }) => displayName))

    const firstAccountRows = contexts.map(({ page }) => page.locator('.voice-member').filter({ hasText: accounts[0].displayName }))
    await contexts[0].page.getByTitle('耳机静音', { exact: true }).click()
    await expect(contexts[0].page.getByTitle('耳机静音中', { exact: true })).toBeDisabled()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toBeVisible()
      await expect(row.getByTitle('耳机已静音', { exact: true })).toBeVisible()
    }

    await contexts[0].page.getByTitle('取消耳机静音', { exact: true }).click()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toHaveCount(0)
      await expect(row.getByTitle('耳机已静音', { exact: true })).toHaveCount(0)
    }

    await contexts[0].page.getByTitle('麦克风静音', { exact: true }).click()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toBeVisible()
    }
    await contexts[0].page.getByTitle('耳机静音', { exact: true }).click()
    await contexts[0].page.getByTitle('取消耳机静音', { exact: true }).click()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toBeVisible()
      await expect(row.getByTitle('耳机已静音', { exact: true })).toHaveCount(0)
    }
    await contexts[0].page.getByTitle('取消静音', { exact: true }).click()

    const remoteMember = contexts[0].page.locator('.voice-member').filter({ hasText: accounts[1].displayName })
    await remoteMember.locator('.voice-member-main').click()
    const remoteMicrophoneVolume = remoteMember.getByLabel('麦克风音量')
    await expect(remoteMicrophoneVolume).toHaveValue('1')
    await expect(remoteMicrophoneVolume).toHaveAttribute('max', '3')
    await remoteMicrophoneVolume.fill('3')
    await expect(remoteMember.getByText('300%', { exact: true })).toBeVisible()
    await expect.poll(() => contexts[0].page.evaluate((userId) => localStorage.getItem(`cws.volume.${userId}`), secondAccountId)).toBe('3')

    const beforeRemoteLeave = await toneCount(contexts[0].page)
    await contexts[1].page.getByTitle('断开语音').click()
    await expect.poll(() => toneCount(contexts[0].page)).toBeGreaterThanOrEqual(beforeRemoteLeave + 2)
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (const account of accounts) {
      const accountID = accountIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

test('DTX 模式在线重发布并在静音期间延迟应用', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `dtx_${suffix}`,
    displayName: `DTX测试${suffix.slice(-5)}`,
    password: 'dtx-member-password',
  }
  const accountID = (await createServerMember(request, serverID, account)).id
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.grantPermissions(['microphone'], { origin: baseURL })
  const page = await context.newPage()

  try {
    await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
    await expect(page.locator('.user-controls')).toHaveCount(0)
    await page.getByRole('button', { name: /^语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })

    let modeButton = page.getByRole('button', { name: '语音感应', exact: true })
    await expect(modeButton).toHaveAttribute('aria-pressed', 'true')
    await modeButton.click()
    modeButton = page.getByRole('button', { name: '持续传输', exact: true })
    await expect(modeButton).toBeEnabled()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('continuous')

    await modeButton.click()
    modeButton = page.getByRole('button', { name: '语音感应', exact: true })
    await expect(modeButton).toBeEnabled()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('voice-activity')

    await page.getByTitle('麦克风静音', { exact: true }).click()
    await expect(page.getByTitle('取消静音', { exact: true })).toBeVisible()
    await modeButton.click()
    modeButton = page.getByRole('button', { name: '持续传输', exact: true })
    await expect(modeButton).toBeEnabled()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('continuous')
    await page.getByTitle('取消静音', { exact: true }).click()
    await expect(page.getByTitle('麦克风静音', { exact: true })).toBeVisible()

    await page.getByTitle('断开语音', { exact: true }).click()
    await expect(page.locator('.user-controls')).toHaveCount(0)
  } finally {
    await context.close()
    await deletePlatformUser(request, accountID, account.username)
  }
})

test('远端麦克风与暂停的背景音可独立调节并持久化', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')
  test.setTimeout(60_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const accounts = [
    { username: `volume_a_${suffix}`, displayName: `音量甲${suffix.slice(-6)}`, password: 'volume-member-password-a' },
    { username: `volume_b_${suffix}`, displayName: `音量乙${suffix.slice(-6)}`, password: 'volume-member-password-b' },
  ]
  const accountIds: number[] = []
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of accounts) {
      accountIds.push((await createServerMember(request, serverID, account)).id)

      const context = await browser.newContext({ permissions: ['microphone'] })
      await context.grantPermissions(['microphone'], { origin: baseURL })
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
      await page.getByRole('button', { name: /语音频道/ }).click()
      await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    }

    const listenerPage = contexts[0].page
    const senderId = accountIds[1]
    const remoteMember = listenerPage.locator('.voice-member').filter({ hasText: accounts[1].displayName })
    await expect(remoteMember).toBeVisible()
    await remoteMember.locator('.voice-member-main').click()

    const microphoneVolume = remoteMember.getByLabel('麦克风音量')
    await expect(microphoneVolume).toHaveValue('1')
    await microphoneVolume.fill('2.5')
    await expect.poll(() => listenerPage.evaluate((userId) => localStorage.getItem(`cws.volume.${userId}`), senderId)).toBe('2.5')

    await setRemoteBackgroundAudioAvailable(listenerPage, senderId, true)
    await expect(remoteMember.getByTitle('正在共享背景音', { exact: true })).toHaveCount(0)
    const backgroundAudioVolume = remoteMember.getByLabel('背景音音量')
    await expect(backgroundAudioVolume).toHaveValue('1')
    await expect(backgroundAudioVolume).toHaveAttribute('max', '3')
    await backgroundAudioVolume.fill('1.75')
    await expect.poll(() => listenerPage.evaluate((userId) => localStorage.getItem(`cws.backgroundAudioVolume.${userId}`), senderId)).toBe('1.75')
    await expect.poll(() => listenerPage.evaluate((userId) => localStorage.getItem(`cws.volume.${userId}`), senderId)).toBe('2.5')

    await setRemoteBackgroundAudioAvailable(listenerPage, senderId, false)
    await expect(backgroundAudioVolume).toHaveCount(0)
    await expect.poll(() => listenerPage.evaluate((userId) => localStorage.getItem(`cws.backgroundAudioVolume.${userId}`), senderId)).toBe('1.75')
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (let index = 0; index < accountIds.length; index++) {
      await deletePlatformUser(request, accountIds[index], accounts[index].username)
    }
  }
})

test('同一账号加入新语音频道会断开旧房间连接', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const serverID = await firstJoinedServerID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const channelName = `语音切换${suffix.slice(-5)}`
  const channelResponse = await request.post(`/api/servers/${serverID}/channels`, { data: { type: 'voice', name: channelName } })
  expect(channelResponse.ok()).toBeTruthy()
  const channel = (await channelResponse.json() as { channel: { id: number } }).channel
  const account = { username: `voice_switch_${suffix}`, displayName: `语音切换用户${suffix.slice(-4)}`, password: 'voice-switch-password' }
  const accountID = (await createServerMember(request, serverID, account)).id

  const contexts: Array<{ context: BrowserContext; page: Page }> = []
  try {
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext({ permissions: ['microphone'] })
      await context.grantPermissions(['microphone'], { origin: baseURL })
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
    }

    await contexts[0].page.getByRole('button', { name: /^语音频道/ }).click()
    await contexts[0].page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    const defaultPreview = contexts[1].page.locator('.voice-channel-block').filter({ hasText: '语音频道' })
    await expect(defaultPreview.locator('.voice-member-name').filter({ hasText: account.displayName })).toBeVisible({ timeout: 20_000 })

    await contexts[1].page.getByRole('button', { name: new RegExp(`^${channelName}`) }).click()
    await contexts[1].page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    await expect(contexts[1].page.locator('.voice-connection-panel')).toContainText(channelName)
    await expect(contexts[0].page.locator('.voice-connection-panel')).toHaveCount(0, { timeout: 20_000 })
    const switchedPreview = contexts[0].page.locator('.voice-channel-block').filter({ hasText: channelName })
    await expect(switchedPreview.locator('.voice-member-name').filter({ hasText: account.displayName })).toBeVisible({ timeout: 20_000 })
    await expect(defaultPreview.locator('.voice-member-name').filter({ hasText: account.displayName })).toHaveCount(0, { timeout: 2_000 })
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    await request.delete(`/api/servers/${serverID}/channels/${channel.id}`)
    await deletePlatformUser(request, accountID, account.username)
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

async function expectVoiceOrder(pages: Page[], expected: string[]) {
  for (const page of pages) {
    await expect.poll(async () => {
      const labels = await page.locator('.voice-member-name').allTextContents()
      return labels.map((label) => label.replace('你', '').trim()).filter((label) => expected.includes(label))
    }).toEqual(expected)
  }
}

async function installToneCounter(page: Page) {
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

async function toneCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __cwsToneCount?: number }).__cwsToneCount ?? 0)
}

async function setRemoteBackgroundAudioAvailable(page: Page, userId: number, available: boolean) {
  await page.evaluate(({ userId, available }) => {
    type VoiceParticipantTestState = { userId: number; backgroundAudioAvailable: boolean }
    type VoiceStoreTestState = { participants: VoiceParticipantTestState[] }
    type PiniaTestState = { _s: Map<string, VoiceStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    type WindowTestState = Window & typeof globalThis & { __cwsBackgroundAudioTimer?: number }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const voice = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('voice')
    if (!voice?.participants.some((item) => item.userId === userId)) throw new Error(`未找到语音参与者 ${userId}`)
    const targetWindow = window as WindowTestState
    if (targetWindow.__cwsBackgroundAudioTimer !== undefined) {
      window.clearInterval(targetWindow.__cwsBackgroundAudioTimer)
      delete targetWindow.__cwsBackgroundAudioTimer
    }
    const applyAvailability = () => {
      const participant = voice.participants.find((item) => item.userId === userId)
      if (participant) participant.backgroundAudioAvailable = available
    }
    applyAvailability()
    if (available) targetWindow.__cwsBackgroundAudioTimer = window.setInterval(applyAvailability, 25)
  }, { userId, available })
}
