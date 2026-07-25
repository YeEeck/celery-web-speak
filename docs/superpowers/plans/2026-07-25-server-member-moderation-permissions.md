# 服务器成员审核权限提示修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正服务器管理员对所有者和其他管理员的前端审核权限展示，并为每个禁止场景显示准确原因。

**Architecture:** 保持后端现有 `guildCanManageTarget` 授权不变，在 `AdminPanel.vue` 内用一个响应式权限结果统一控制审核控件和提示文案。Playwright 通过拦截 bootstrap 响应构造操作者与目标角色矩阵，不修改共享测试服务器的所有权。

**Tech Stack:** Vue 3、TypeScript、Pinia、Playwright、Vite、Go embed

---

## 文件结构

- 修改 `web/e2e/smoke.spec.ts`：增加成员审核角色矩阵的浏览器回归测试和测试数据注入辅助函数。
- 修改 `web/src/components/AdminPanel.vue`：集中计算当前所选成员的审核权限及禁止原因。
- 更新 `internal/webui/dist/**`：通过 Vite 重新生成 Go 服务嵌入的前端静态产物。

### Task 1: 用浏览器测试复现权限判断与提示错误

**Files:**
- Modify: `web/e2e/smoke.spec.ts`

- [ ] **Step 1: 增加角色矩阵测试数据辅助函数**

在 `openPlatformAccounts` 后增加辅助函数。它保留真实 bootstrap 的频道等数据，只替换当前服务器身份和成员角色：

```ts
async function mockMemberModerationRoles(
  page: Page,
  options: { actorRole: 'owner' | 'admin'; isPlatformAdmin: boolean },
) {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({
      response,
      json: {
        ...payload,
        user: { ...payload.user, isPlatformAdmin: options.isPlatformAdmin },
      },
    })
  })
  await page.route('**/api/servers/*/bootstrap', async (route) => {
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
  await openServerAdmin(page)
  await page.getByRole('button', { name: '成员', exact: true }).click()
}
```

- [ ] **Step 2: 增加服务器管理员权限回归测试**

```ts
test('服务器管理员只能审核普通成员并按目标角色显示原因', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'admin', isPlatformAdmin: false })
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
```

- [ ] **Step 3: 增加服务器所有者和平台管理员回归测试**

```ts
test('服务器所有者仍可审核管理员', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'owner', isPlatformAdmin: false })
  const detail = page.locator('.user-admin-detail')
  await page.locator('.admin-user-list button').filter({ hasText: '权限测试管理员' }).click()
  await expect(detail.getByText('语音禁言', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toBeVisible()
  await expect(detail.locator('.permission-note')).toHaveCount(0)
})

test('平台管理员可审核管理员但不能审核服务器所有者', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'admin', isPlatformAdmin: true })
  const detail = page.locator('.user-admin-detail')

  await page.locator('.admin-user-list button').filter({ hasText: '权限测试管理员' }).click()
  await expect(detail.getByText('语音禁言', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toBeVisible()

  await page.locator('.admin-user-list button').filter({ hasText: '权限测试所有者' }).click()
  await expect(detail.getByText('服务器所有者不能在成员管理中被审核；如需更换所有者，请使用所有权转让。', { exact: true })).toBeVisible()
  await expect(detail.getByText('语音禁言', { exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '移出服务器', exact: true })).toHaveCount(0)
})
```

- [ ] **Step 4: 运行定向测试并确认 RED**

Run:

```bash
cd web
npx playwright test e2e/smoke.spec.ts --project=desktop-chromium --grep '服务器管理员只能审核普通成员|服务器所有者仍可审核管理员|平台管理员可审核管理员'
```

Expected: 服务器所有者审核管理员用例通过；服务器管理员选择管理员时因仍显示审核控件而失败；所有者提示和平台管理员提示因仍显示旧文案而失败。

- [ ] **Step 5: 提交失败测试**

```bash
git add web/e2e/smoke.spec.ts
git commit -m "test: 覆盖服务器成员审核权限矩阵"
```

### Task 2: 集中修正审核权限和提示

**Files:**
- Modify: `web/src/components/AdminPanel.vue`
- Test: `web/e2e/smoke.spec.ts`

- [ ] **Step 1: 用响应式权限结果替换 `canModerate`**

在现有 `canModerate` 位置增加：

```ts
const moderationPermission = computed(() => {
  const target = selectedUser.value
  if (!serverContext.value || !target) return { allowed: false, reason: '' }
  if (target.role === 'owner') {
    return {
      allowed: false,
      reason: app.isPlatformAdmin
        ? '服务器所有者不能在成员管理中被审核；如需更换所有者，请使用所有权转让。'
        : '服务器管理员不能管理服务器所有者。',
    }
  }
  if (target.role === 'admin' && !app.isPlatformAdmin && serverContext.value.role !== 'owner') {
    return { allowed: false, reason: '服务器管理员不能管理其他管理员。' }
  }
  return { allowed: true, reason: '' }
})
```

删除旧的 `canModerate(user)` 函数。

- [ ] **Step 2: 让模板消费同一个权限结果**

将审核区域条件和固定提示替换为：

```vue
<template v-if="serverContext && moderationPermission.allowed">
  <!-- 保留现有审核控件 -->
</template>
<p v-else-if="serverContext && moderationPermission.reason" class="permission-note">
  <ShieldCheck :size="17" />{{ moderationPermission.reason }}
</p>
```

- [ ] **Step 3: 运行定向测试并确认 GREEN**

Run:

```bash
cd web
npx playwright test e2e/smoke.spec.ts --project=desktop-chromium --grep '服务器管理员只能审核普通成员|服务器所有者仍可审核管理员|平台管理员可审核管理员'
```

Expected: `3 passed`。

- [ ] **Step 4: 运行静态检查**

Run:

```bash
cd web
npm run typecheck
```

Expected: exit code 0，无 TypeScript 错误。

- [ ] **Step 5: 提交实现**

```bash
git add web/src/components/AdminPanel.vue
git commit -m "fix: 修正服务器成员审核权限提示"
```

### Task 3: 重建产物并完成全量验证

**Files:**
- Update: `internal/webui/dist/assets/index-*.js`
- Update: `internal/webui/dist/index.html`

- [ ] **Step 1: 构建嵌入式前端产物**

Run:

```bash
cd web
npm run build
```

Expected: `vue-tsc` 与 Vite 构建成功，`internal/webui/dist` 生成新的带哈希 JavaScript 文件及更新后的 `index.html`。

- [ ] **Step 2: 提交生成产物**

```bash
git add internal/webui/dist
git commit -m "chore: 重新构建成员审核前端产物"
```

- [ ] **Step 3: 运行 Go 全量测试**

Run:

```bash
go test ./...
```

Expected: 所有 Go 包通过。

- [ ] **Step 4: 运行前端类型检查与生产构建**

Run:

```bash
cd web
npm run typecheck
npm run build
```

Expected: 两个命令均以 exit code 0 完成，第二次构建不产生新的未提交差异。

- [ ] **Step 5: 运行完整浏览器测试**

Run:

```bash
cd web
npm run test:e2e
```

Expected: 桌面和 Android 项目全部通过，仅保留测试中显式声明的环境性跳过。

- [ ] **Step 6: 检查计划覆盖与工作区状态**

Run:

```bash
git diff --check
git status --short
```

Expected: 无空白错误，工作区为空。

## 完成标准

- 服务器管理员只能审核普通成员。
- 服务器管理员选择管理员或所有者时，审核控件全部隐藏且显示对应提示。
- 服务器所有者和平台管理员仍可审核服务器管理员。
- 平台管理员选择所有者时显示所有权转让指引。
- 无权限目标仍保留在成员列表中并可查看身份信息。
- 后端接口和权限逻辑没有变化。
- 定向测试经历可解释的 RED 到 GREEN，全量验证通过，所有变更均已按粒度提交。
