import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

test('两个独立账号可建立并接收语音轨道', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
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
      accountIds.set(account.username, (await createGuildMember(request, guildID, account)).id)
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
      await expect(page.locator('.voice-connection-bitrate')).toHaveText(/· \d+ kbps/)
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
    const promoteResponse = await request.patch(`/api/guilds/${guildID}/members/${secondAccountId}/role`, { data: { role: 'admin' } })
    expect(promoteResponse.ok()).toBeTruthy()
    await expectVoiceOrder(contexts.map(({ page }) => page), [accounts[1].displayName, accounts[0].displayName])

    const demoteResponse = await request.patch(`/api/guilds/${guildID}/members/${secondAccountId}/role`, { data: { role: 'member' } })
    expect(demoteResponse.ok()).toBeTruthy()
    await expectVoiceOrder(contexts.map(({ page }) => page), accounts.map(({ displayName }) => displayName))

    const firstAccountRows = contexts.map(({ page }) => page.locator('.voice-member').filter({ hasText: accounts[0].displayName }))
    await contexts[0].page.getByTitle(/^耳机静音/).click()
    await expect(contexts[0].page.getByTitle(/^取消耳机静音/)).toBeEnabled()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toBeVisible()
      await expect(row.getByTitle('耳机已静音', { exact: true })).toBeVisible()
    }

    await contexts[0].page.getByTitle(/^取消耳机静音/).click()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toHaveCount(0)
      await expect(row.getByTitle('耳机已静音', { exact: true })).toHaveCount(0)
    }

    await contexts[0].page.getByTitle(/^麦克风静音/).click()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toBeVisible()
    }
    await contexts[0].page.getByTitle(/^耳机静音/).click()
    await contexts[0].page.getByTitle(/^取消耳机静音/).click()
    for (const row of firstAccountRows) {
      await expect(row.getByTitle('麦克风已静音', { exact: true })).toBeVisible()
      await expect(row.getByTitle('耳机已静音', { exact: true })).toHaveCount(0)
    }
    await contexts[0].page.getByTitle(/^取消静音/).click()

    const remoteMember = contexts[0].page.locator('.voice-member').filter({ hasText: accounts[1].displayName })
    await remoteMember.locator('.voice-member-main').click({ button: 'right' })
    const participantPanel = contexts[0].page.getByRole('dialog', { name: `${accounts[1].displayName}的语音参与者操作` })
    await expect(participantPanel).toBeVisible()
    await expect(remoteMember.getByLabel('麦克风音量')).toHaveCount(0)
    const remoteMicrophoneVolume = participantPanel.getByLabel('麦克风音量')
    await expect(remoteMicrophoneVolume).toHaveValue('1')
    await expect(remoteMicrophoneVolume).toHaveAttribute('max', '3')
    await remoteMicrophoneVolume.fill('3')
    await expect(participantPanel.getByText('300%', { exact: true })).toBeVisible()
    await expect.poll(() => contexts[0].page.evaluate((userId) => localStorage.getItem(`cws.volume.${userId}`), secondAccountId)).toBe('3')

    const beforeRemoteLeave = await toneCount(contexts[0].page)
    const beforeOwnLeave = await toneCount(contexts[1].page)
    await contexts[1].page.getByTitle('断开语音').click()
    await expect.poll(() => toneCount(contexts[0].page)).toBeGreaterThanOrEqual(beforeRemoteLeave + 2)
    await expect.poll(() => toneCount(contexts[1].page)).toBeGreaterThanOrEqual(beforeOwnLeave + 2)
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    for (const account of accounts) {
      const accountID = accountIds.get(account.username)
      if (accountID) await deletePlatformUser(request, accountID, account.username)
    }
  }
})

test('语音参与者菜单支持播放控制与服务器管理操作', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')
  test.setTimeout(60_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const member = {
    username: `participant_menu_${suffix}`,
    displayName: `菜单成员${suffix.slice(-5)}`,
    password: 'participant-menu-password',
  }
  const memberID = (await createGuildMember(request, guildID, member)).id
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of [{ username: adminUsername, password: adminPassword }, member]) {
      const context = await browser.newContext({ permissions: ['microphone'] })
      await context.grantPermissions(['microphone'], { origin: baseURL })
      const page = await context.newPage()
      contexts.push({ context, page })
      await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
      await installToneCounter(page)
      await page.getByRole('button', { name: /^语音频道/ }).click()
      await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    }

    const adminPage = contexts[0].page
    const memberPage = contexts[1].page
    const localRow = adminPage.locator('.voice-member').filter({ hasText: '你' })
    await localRow.locator('.voice-member-main').click()
    await expect(adminPage.getByRole('dialog', { name: /语音参与者操作/ })).toHaveCount(0)

    const remoteRow = adminPage.locator('.voice-member').filter({ hasText: member.displayName })
    const remoteTrigger = remoteRow.locator('.voice-member-main')
    await remoteTrigger.click({ button: 'right' })
    let panel = adminPage.getByRole('dialog', { name: `${member.displayName}的语音参与者操作` })
    await expect(panel.getByLabel('麦克风音量')).toHaveAttribute('step', '0.05')
    await expect(panel.getByRole('button', { name: '服务器语音禁言' })).toBeVisible()
    await adminPage.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(remoteTrigger).toBeFocused()

    await remoteTrigger.press('Shift+F10')
    panel = adminPage.getByRole('dialog', { name: `${member.displayName}的语音参与者操作` })
    await panel.getByRole('button', { name: '服务器语音禁言' }).click()
    await expect(adminPage.getByText(`已对 ${member.displayName} 启用服务器语音禁言`, { exact: true })).toBeVisible()
    await expect(remoteRow.getByText('已禁言', { exact: true })).toBeVisible()

    await remoteTrigger.click()
    panel = adminPage.getByRole('dialog', { name: `${member.displayName}的语音参与者操作` })
    await panel.getByRole('button', { name: '解除服务器语音禁言' }).click()
    await expect(adminPage.getByText(`已解除 ${member.displayName} 的服务器语音禁言`, { exact: true })).toBeVisible()

    const tonesBeforeDisconnect = await toneCount(memberPage)
    await remoteTrigger.click()
    panel = adminPage.getByRole('dialog', { name: `${member.displayName}的语音参与者操作` })
    await panel.getByRole('button', { name: '断开语音', exact: true }).click()
    await expect(memberPage.getByText('你已被服务器管理员断开语音', { exact: true })).toBeVisible()
    await expect(memberPage.locator('.voice-connection-panel')).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => toneCount(memberPage)).toBeGreaterThanOrEqual(tonesBeforeDisconnect + 2)

    await memberPage.getByRole('button', { name: /^语音频道/ }).click()
    await memberPage.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
  } finally {
    await Promise.allSettled(contexts.map(({ context }) => context.close()))
    await deletePlatformUser(request, memberID, member.username)
  }
})

test('主动退出语音与被动离开和耳机静音区分', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `leave_sound_${suffix}`,
    displayName: `退出音测试${suffix.slice(-5)}`,
    password: 'leave-sound-password',
  }
  const accountID = (await createGuildMember(request, guildID, account)).id
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.grantPermissions(['microphone'], { origin: baseURL })
  const page = await context.newPage()

  try {
    await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
    await installToneCounter(page)
    await page.getByRole('button', { name: /语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })

    const beforeOwnLeave = await toneCount(page)
    await page.getByTitle('断开语音').click()
    await expect.poll(() => toneCount(page)).toBeGreaterThanOrEqual(beforeOwnLeave + 2)

    await page.getByRole('button', { name: /语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    const beforePassiveLeave = await toneCount(page)
    await leaveVoiceThroughStore(page, false)
    await page.waitForTimeout(150)
    expect(await toneCount(page)).toBe(beforePassiveLeave)

    await page.getByRole('button', { name: /语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    await page.getByTitle(/^耳机静音/).click()
    const deafenedButton = page.getByTitle(/^取消耳机静音/)
    await expect(deafenedButton).toBeVisible()
    const beforeDeafenedLeave = await toneCount(page)
    await deafenedButton.press('Escape')
    await expect(page.locator('#output-volume-popover')).toBeHidden()
    await page.getByTitle('断开语音').click()
    await page.waitForTimeout(150)
    expect(await toneCount(page)).toBe(beforeDeafenedLeave)
  } finally {
    await context.close()
    await deletePlatformUser(request, accountID, account.username)
  }
})

test('DTX 模式在线重发布并在静音期间延迟应用', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `dtx_${suffix}`,
    displayName: `DTX测试${suffix.slice(-5)}`,
    password: 'dtx-member-password',
  }
  const accountID = (await createGuildMember(request, guildID, account)).id
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.grantPermissions(['microphone'], { origin: baseURL })
  const page = await context.newPage()
  const mutedSpeakingWarnings: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('静音说话检测已停用')) {
      mutedSpeakingWarnings.push(message.text())
    }
  })

  try {
    await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
    await expect(page.locator('.user-controls')).toHaveCount(1)
    await page.getByRole('button', { name: /^语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })

    let modeButton = page.locator('.transmission-mode-button')
    await expect(modeButton).toHaveAccessibleName('当前模式：语音感应；切换为持续传输')
    await modeButton.click()
    modeButton = page.locator('.transmission-mode-button')
    await expect(modeButton).toHaveAccessibleName('当前模式：持续传输；切换为语音感应')
    await expect(modeButton).toBeEnabled()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('continuous')

    await modeButton.click()
    modeButton = page.locator('.transmission-mode-button')
    await expect(modeButton).toHaveAccessibleName('当前模式：语音感应；切换为持续传输')
    await expect(modeButton).toBeEnabled()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('voice-activity')

    await page.getByTitle(/^麦克风静音/).click()
    await expect(page.getByTitle(/^取消静音/)).toBeVisible()
    await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('muted-speaking-')))).toBe(true)
    await modeButton.click()
    modeButton = page.locator('.transmission-mode-button')
    await expect(modeButton).toHaveAccessibleName('当前模式：持续传输；切换为语音感应')
    await expect(modeButton).toBeEnabled()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.voiceTransmissionMode'))).toBe('continuous')
    await page.getByTitle(/^取消静音/).click()
    await expect(page.getByTitle(/^麦克风静音/)).toBeVisible()
    expect(mutedSpeakingWarnings).toEqual([])

    await page.getByTitle('断开语音', { exact: true }).click()
    await expect(page.locator('.user-controls')).toHaveCount(1)
  } finally {
    await context.close()
    await deletePlatformUser(request, accountID, account.username)
  }
})

test('语音中切换降噪选项立即更新采集约束', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `noise_option_${suffix}`,
    displayName: `降噪切换测试${suffix.slice(-5)}`,
    password: 'noise-option-password',
  }
  const accountID = (await createGuildMember(request, guildID, account)).id
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.grantPermissions(['microphone'], { origin: baseURL })
  const page = await context.newPage()

  try {
    await loginVoicePage(page, account, testInfo.project.name.startsWith('android'))
    // LiveKit installs browser compatibility shims during app startup. Install
    // the recorder after login so those shims cannot replace the wrapper.
    await installMicrophoneConstraintRecorder(page)
    await page.getByRole('button', { name: /^语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })

    await page.getByTitle('用户账户').click()
    await page.getByRole('menu', { name: '用户账户操作' }).getByRole('menuitem', { name: '用户设置', exact: true }).click()
    await page.getByRole('dialog', { name: '用户设置' }).getByRole('button', { name: '音频', exact: true }).click()
    const noiseSelect = page.getByLabel('降噪选项')

    let constraintCount = (await microphoneNoiseConstraints(page)).length
    await noiseSelect.selectOption('webrtc')
    await expect.poll(async () => {
      const values = await microphoneNoiseConstraints(page)
      return values.length > constraintCount && values.slice(constraintCount).includes(true)
    }).toBe(true)
    await expect(page.locator('.voice-connection-panel')).toContainText('语音已连接')

    constraintCount = (await microphoneNoiseConstraints(page)).length
    await noiseSelect.selectOption('off')
    await expect.poll(async () => {
      const values = await microphoneNoiseConstraints(page)
      return values.length > constraintCount && values.slice(constraintCount).includes(false)
    }).toBe(true)
    await expect(page.locator('.voice-connection-panel')).toContainText('语音已连接')
  } finally {
    await Promise.allSettled([
      page.getByTitle('断开语音', { exact: true }).click(),
      context.close(),
    ])
    await deletePlatformUser(request, accountID, account.username)
  }
})

test('远端麦克风与暂停的背景音可独立调节并持久化', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')
  test.setTimeout(60_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const accounts = [
    { username: `volume_a_${suffix}`, displayName: `音量甲${suffix.slice(-6)}`, password: 'volume-member-password-a' },
    { username: `volume_b_${suffix}`, displayName: `音量乙${suffix.slice(-6)}`, password: 'volume-member-password-b' },
  ]
  const accountIds: number[] = []
  const contexts: Array<{ context: BrowserContext; page: Page }> = []

  try {
    for (const account of accounts) {
      accountIds.push((await createGuildMember(request, guildID, account)).id)

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
    const participantPanel = listenerPage.getByRole('dialog', { name: `${accounts[1].displayName}的语音参与者操作` })

    const microphoneVolume = participantPanel.getByLabel('麦克风音量')
    await expect(microphoneVolume).toHaveValue('1')
    await microphoneVolume.fill('2.5')
    await expect.poll(() => listenerPage.evaluate((userId) => localStorage.getItem(`cws.volume.${userId}`), senderId)).toBe('2.5')

    await setRemoteBackgroundAudioAvailable(listenerPage, senderId, true)
    await expect(remoteMember.getByTitle('正在共享背景音', { exact: true })).toHaveCount(0)
    const backgroundAudioVolume = participantPanel.getByLabel('背景音音量')
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
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const channelName = `语音切换${suffix.slice(-5)}`
  const channelResponse = await request.post(`/api/guilds/${guildID}/channels`, { data: { type: 'voice', name: channelName } })
  expect(channelResponse.ok()).toBeTruthy()
  const channel = (await channelResponse.json() as { channel: { id: number } }).channel
  const account = { username: `voice_switch_${suffix}`, displayName: `语音切换用户${suffix.slice(-4)}`, password: 'voice-switch-password' }
  const accountID = (await createGuildMember(request, guildID, account)).id

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
    await request.delete(`/api/guilds/${guildID}/channels/${channel.id}`)
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

async function installMicrophoneConstraintRecorder(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __cwsMicrophoneConstraints?: unknown[] }
    target.__cwsMicrophoneConstraints = []
    const mediaDevices = navigator.mediaDevices
    const originalGetUserMedia = mediaDevices.getUserMedia
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value(this: MediaDevices, constraints: MediaStreamConstraints) {
        target.__cwsMicrophoneConstraints?.push(constraints)
        return originalGetUserMedia.call(this, constraints)
      },
    })

    const originalApplyConstraints = MediaStreamTrack.prototype.applyConstraints
    MediaStreamTrack.prototype.applyConstraints = function applyRecordedConstraints(
      constraints?: MediaTrackConstraints,
    ) {
      if (this.kind === 'audio' && constraints) {
        target.__cwsMicrophoneConstraints?.push({ audio: constraints })
      }
      return originalApplyConstraints.call(this, constraints)
    }
  })
}

async function microphoneNoiseConstraints(page: Page) {
  return page.evaluate(() => {
    const values = (window as typeof window & { __cwsMicrophoneConstraints?: unknown[] }).__cwsMicrophoneConstraints ?? []
    return values.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const audio = (value as { audio?: unknown }).audio
      if (!audio || typeof audio !== 'object' || !('noiseSuppression' in audio)) return []
      return [(audio as { noiseSuppression: unknown }).noiseSuppression]
    })
  })
}

async function toneCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __cwsToneCount?: number }).__cwsToneCount ?? 0)
}

async function leaveVoiceThroughStore(page: Page, active: boolean) {
  await page.evaluate(async (isActive) => {
    type VoiceStoreTestState = { leave: (options?: { intent?: 'active' }) => Promise<void> }
    type PiniaTestState = { _s: Map<string, VoiceStoreTestState> }
    type VueAppTestState = { config: { globalProperties: { $pinia?: PiniaTestState } } }
    const root = document.querySelector('#app') as (Element & { __vue_app__?: VueAppTestState }) | null
    const voice = root?.__vue_app__?.config.globalProperties.$pinia?._s.get('voice')
    if (!voice) throw new Error('未找到语音 store')
    await voice.leave(isActive ? { intent: 'active' } : undefined)
  }, active)
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
