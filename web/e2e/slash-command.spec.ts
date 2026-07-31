import { expect, test } from '@playwright/test'

const username = process.env.E2E_USERNAME ?? 'admin'
const password = process.env.E2E_PASSWORD ?? 'admin-password-123'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('登录名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '文字聊天', exact: true })).toBeVisible()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
})

test('斜杠指令查询自己的服务器语音经验并保持私有', async ({ page }) => {
  const input = page.getByPlaceholder('发送消息到 #文字聊天')
  await input.fill('/xp get')
  await input.press('Enter')

  const feedback = page.locator('.command-feedback').last()
  await expect(feedback).toBeVisible()
  await expect(feedback).toContainText('仅你可见')
  await expect(feedback).toContainText('服务器语音经验')
  await expect(page.getByText('/xp get', { exact: true })).toHaveCount(0)
})

test('双斜杠转义为普通消息，未知单斜杠不公开发送', async ({ page }) => {
  const input = page.getByPlaceholder('发送消息到 #文字聊天')
  const escaped = `//普通斜杠消息 ${Date.now()}`
  await input.fill(escaped)
  await input.press('Enter')
  await expect(page.getByText(escaped.slice(1), { exact: true })).toBeVisible()

  await input.fill('/unknown-command')
  await input.press('Enter')
  await expect(page.locator('.command-feedback').last()).toContainText('未知指令')
  await expect(page.getByText('/unknown-command', { exact: true })).toHaveCount(0)
})

test('管理员可以通过斜杠指令绝对设置自己的服务器语音经验', async ({ page }) => {
  const input = page.getByPlaceholder('发送消息到 #文字聊天')
  await input.fill(`/xp set @${username} 120`)
  await input.press('Enter')

  const feedback = page.locator('.command-feedback').last()
  await expect(feedback).toBeVisible()
  await expect(feedback).toContainText('服务器语音经验已设置')
  await expect(feedback).toContainText('修改后：120 XP')
})

test('斜杠输入提供可键盘关闭的命令建议', async ({ page }) => {
  const input = page.getByPlaceholder('发送消息到 #文字聊天')
  await input.fill('/')
  const suggestions = page.getByRole('listbox', { name: '斜杠指令建议' })
  await expect(suggestions).toBeVisible()
  await expect(suggestions.getByRole('option').first()).toContainText('/xp')
  await input.press('Tab')
  await expect(input).toHaveValue('/xp ')
  await expect(suggestions.getByRole('option')).toHaveCount(2)
  await input.press('Escape')
  await expect(suggestions).toBeHidden()
})
