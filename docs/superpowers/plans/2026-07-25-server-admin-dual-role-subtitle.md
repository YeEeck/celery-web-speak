# 服务器管理双重角色副标题实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在服务器管理面板副标题中同时显示当前服务器角色和平台管理员身份，避免用户误解实际生效的管理权限。

**Architecture:** 保留 `AdminPanel.vue` 作为管理面板身份文案的唯一渲染位置，新增一个小型计算属性组合服务器角色与平台身份。Playwright 复用现有角色矩阵夹具，覆盖普通服务器管理员、普通服务器所有者、服务器管理员兼平台管理员和服务器所有者兼平台管理员四种输出，并在共享平台管理辅助流程中固定原有平台副标题。

**Tech Stack:** Vue 3、TypeScript、Pinia、Playwright、Vite

---

## 文件结构

- 修改 `web/e2e/smoke.spec.ts`：为服务器管理副标题增加四种角色组合的浏览器回归断言，并固定平台管理副标题。
- 修改 `web/src/components/AdminPanel.vue`：集中计算管理面板副标题并替换模板内联三元表达式。
- 更新 `internal/webui/dist/**`：重新生成 Go 服务嵌入的前端静态产物。

### Task 1: 用浏览器测试定义双重角色副标题

**Files:**
- Modify: `web/e2e/smoke.spec.ts:517-559`
- Test: `web/e2e/smoke.spec.ts`

- [ ] **Step 1: 为已有角色场景增加副标题断言**

在 `openPlatformAccounts` 中保留标题可见性断言后增加：

```ts
await expect(page.locator('.admin-panel .panel-header p')).toHaveText('平台管理员')
```

在三个现有权限矩阵用例中，在 `mockMemberModerationRoles` 返回后分别断言：

```ts
await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器管理员')
```

```ts
await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器所有者')
```

```ts
await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器管理员 · 平台管理员')
```

- [ ] **Step 2: 增加服务器所有者兼平台管理员用例**

```ts
test('服务器所有者兼平台管理员显示双重角色副标题', async ({ page }) => {
  await mockMemberModerationRoles(page, { actorRole: 'owner', isPlatformAdmin: true })
  await expect(page.locator('.admin-panel .panel-header p')).toHaveText('服务器所有者 · 平台管理员')
})
```

- [ ] **Step 3: 运行定向测试并确认 RED**

Run:

```bash
cd web
npx playwright test e2e/smoke.spec.ts --project=desktop-chromium --grep '服务器管理员只能审核普通成员|服务器所有者仍可审核管理员|平台管理员可审核管理员|服务器所有者兼平台管理员'
```

Expected: 普通服务器管理员、普通服务器所有者和平台管理模式断言通过；两个平台管理员组合因副标题缺少“· 平台管理员”而失败。

- [ ] **Step 4: 提交失败测试**

```bash
git add web/e2e/smoke.spec.ts
git commit -m "test: 覆盖服务器管理双重角色副标题"
```

### Task 2: 实现组合副标题

**Files:**
- Modify: `web/src/components/AdminPanel.vue:51-56`
- Modify: `web/src/components/AdminPanel.vue:407`
- Test: `web/e2e/smoke.spec.ts`

- [ ] **Step 1: 增加管理面板副标题计算属性**

在 `serverContext` 之后增加：

```ts
const adminSubtitle = computed(() => {
  if (!serverContext.value) return '平台管理员'
  const serverRole = serverContext.value.role === 'owner' ? '服务器所有者' : '服务器管理员'
  return app.isPlatformAdmin ? `${serverRole} · 平台管理员` : serverRole
})
```

- [ ] **Step 2: 让模板使用统一副标题**

将标题栏内联角色判断替换为：

```vue
<div><h2 id="admin-title">{{ serverContext ? '服务器管理' : '平台管理' }}</h2><p>{{ adminSubtitle }}</p></div>
```

- [ ] **Step 3: 运行定向测试并确认 GREEN**

Run:

```bash
cd web
npx playwright test e2e/smoke.spec.ts --project=desktop-chromium --grep '服务器管理员只能审核普通成员|服务器所有者仍可审核管理员|平台管理员可审核管理员|服务器所有者兼平台管理员'
```

Expected: `4 passed`。

- [ ] **Step 4: 运行前端类型检查**

Run:

```bash
cd web
npm run typecheck
```

Expected: exit code 0，无 TypeScript 错误。

- [ ] **Step 5: 提交实现**

```bash
git add web/src/components/AdminPanel.vue
git commit -m "fix: 显示服务器管理双重角色"
```

### Task 3: 重建产物并完成验证

**Files:**
- Update: `internal/webui/dist/assets/index-*.js`
- Update: `internal/webui/dist/index.html`

- [ ] **Step 1: 构建嵌入式前端产物**

Run:

```bash
cd web
npm run build
```

Expected: Vite 构建成功，`internal/webui/dist` 生成新的带哈希 JavaScript 文件并更新 `index.html`。

- [ ] **Step 2: 提交生成产物**

```bash
git add internal/webui/dist
git commit -m "chore: 重建双重角色提示前端产物"
```

- [ ] **Step 3: 运行 Go 全量测试**

Run:

```bash
go test ./...
```

Expected: 所有 Go 包通过。

- [ ] **Step 4: 运行前端静态检查和生产构建**

Run:

```bash
cd web
npm run typecheck
npm run build
```

Expected: 两个命令均成功，第二次构建不产生新的未提交差异。

- [ ] **Step 5: 运行完整浏览器测试**

Run:

```bash
cd web
npm run test:e2e
```

Expected: 桌面和 Android 项目全部通过，仅保留测试中显式声明的跳过项。

- [ ] **Step 6: 检查工作区**

Run:

```bash
git diff --check
git status --short
```

Expected: 无空白错误，工作区为空。

## 完成标准

- 非平台管理员的服务器管理员显示“服务器管理员”。
- 非平台管理员的服务器所有者显示“服务器所有者”。
- 服务器管理员兼平台管理员显示“服务器管理员 · 平台管理员”。
- 服务器所有者兼平台管理员显示“服务器所有者 · 平台管理员”。
- 平台管理面板继续显示“平台管理员”。
- 权限逻辑、接口和数据模型保持不变。
- 定向测试经历可解释的 RED 到 GREEN，全量验证通过，所有变更均已按粒度提交。
