# 账户入口与语音控制区重构执行计划

> 对应设计：`docs/account-rail-voice-controls-design.md`

## 目标

将用户头像和账号操作迁移到服务器栏底部，在移动端保留持续可见的服务器栏；把频道栏底部重构为纯语音控制区，并增加全局持久化的 Opus DTX 模式切换。

## 实施原则

- 先完成结构与响应式布局，再接入账户菜单和语音状态，避免同时调试多个浮层。
- 账户菜单复用服务器操作菜单已经验证的键盘、视口限制和焦点恢复模式。
- DTX 只有一个状态源；房间默认参数、麦克风重新启用和频道设置热更新都读取该状态。
- 每个实现阶段补充对应测试并单独提交，最后统一构建前端产物。

## 阶段一：服务器栏与移动端导航

### 变更文件

- `web/src/components/AppShell.vue`
- `web/src/components/ChatPane.vue`（仅在现有事件不足时调整）
- `web/src/styles.css`
- `web/e2e/smoke.spec.ts`

### 工作项

1. 在服务器栏底部增加独立账户槽位，服务器列表继续独立滚动。
2. 移动端网格改为 `56px minmax(0, 1fr)`，不再隐藏服务器栏。
3. 删除移动端服务器下拉框及其事件处理。
4. 调整服务器图标点击：其他服务器切换后打开频道抽屉，当前服务器切换抽屉。
5. 频道抽屉从 56px 后开始，遮罩不覆盖服务器栏；修正宽度和层级。
6. 保留聊天标题栏频道按钮、标题服务器操作菜单和移动端关闭按钮。
7. 添加窄屏、抽屉连续切换和服务器栏固定可见的 E2E 覆盖。

### 验证

- `npm run typecheck`
- Playwright 定向运行移动端服务器/频道导航用例。

### 提交

`feat: 重构移动端服务器与频道导航`

## 阶段二：账户菜单

### 变更文件

- `web/src/components/AccountMenu.vue`（新增）
- `web/src/components/AppShell.vue`
- `web/src/components/UserControls.vue`
- `web/src/components/UserAvatar.vue`（仅在边框上下文需要显式参数时调整）
- `web/src/styles.css`
- `web/e2e/smoke.spec.ts`

### 工作项

1. 将当前用户头像从 `UserControls` 移到服务器栏底部。
2. 实现账户菜单的只读摘要、用户设置和危险色退出登录菜单项。
3. 将退出确认的状态与对话框从 `UserControls` 移到合适的账户层级，保留语音提示、加载和失败行为。
4. 打开账户菜单时关闭移动端频道抽屉；设置和退出确认接管焦点。
5. 支持外部点击、Escape、方向键、Home/End、Enter/空格与焦点恢复。
6. 头像仅保留绿色在线状态点，并修正其在服务器栏背景上的描边。
7. 更新设置与退出登录 E2E 选择器和新增账户菜单交互覆盖。

### 验证

- `npm run typecheck`
- Playwright 定向运行用户设置、退出确认和键盘菜单用例。

### 提交

`feat: 将账户操作迁移到服务器栏头像菜单`

## 阶段三：纯语音工具栏

### 变更文件

- `web/src/components/UserControls.vue`
- `web/src/components/AppShell.vue`
- `web/src/styles.css`
- `web/e2e/voice.spec.ts`

### 工作项

1. 从 `UserControls` 删除用户摘要、设置和退出登录职责。
2. 未加入语音时隐藏连接信息与工具栏。
3. 连接信息行移除 `X` 按钮，只显示服务器、频道和连接状态。
4. 工具栏右侧靠右排列麦克风、耳机静音、背景音和断开语音。
5. 断开语音使用危险色 `PhoneOff` 图标并保持单击执行。
6. 调整背景音弹层锚点和窄屏布局，保证按钮数量变化时不移位或溢出。
7. 增加断开语音与退出登录语义分离、未连接隐藏和窄屏布局测试。

### 验证

- `npm run typecheck`
- Playwright 定向运行语音控制和应用背景音用例。

### 提交

`feat: 将频道底部重构为纯语音控制区`

## 阶段四：DTX 模式切换

### 变更文件

- `web/src/stores/voice.ts`
- `web/src/components/UserControls.vue`
- `web/src/styles.css`
- `web/src/stores/voice.test.ts` 或现有前端单元测试位置（若项目没有单元测试基础则以 E2E 覆盖）
- `web/e2e/voice.spec.ts`

### 工作项

1. 增加 `voiceTransmissionMode`、持久化键、默认读取和派生 DTX 值。
2. 将房间 `publishDefaults` 和所有 `publishOptions()` 调用改为读取当前 DTX 值。
3. 实现切换方法：静音/耳机静音/管理员禁言时只保存；正在发布时重新应用发布参数。
4. 切换期间暴露 changing 状态，失败时回滚模式和存储值并设置错误。
5. 确保频道码率与 RED 热更新重新发布时保留当前 DTX。
6. 工具栏左侧增加图标加文本的模式按钮，右侧控制组保持靠右。
7. 测试默认开启、持久化、跨频道复用、静音延迟应用、在线重应用和失败回滚。

### 验证

- `npm run typecheck`
- 项目现有前端测试命令。
- Playwright 定向运行 DTX 与静音组合用例。

### 提交

`feat: 增加语音 DTX 模式切换`

## 阶段五：规范同步、全量验证与产物

### 变更文件

- `docs/product-spec.md`
- `docs/background-audio-design.md`
- `web/dist/**` 或仓库当前构建产物目录
- 必要的测试修正文件

### 工作项

1. 将服务器栏、账户菜单、移动端抽屉、纯语音工具栏和 DTX 规则同步到产品规范。
2. 修正背景音设计中关于底部控制区的描述。
3. 运行格式检查、类型检查、构建、Go 测试和完整 Playwright 测试。
4. 检查桌面、Android 常用视口和 320px 窄视口截图，确认无重叠、截断和空白画布。
5. 重新构建并提交前端静态产物。

### 验证

- `go test ./...`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e`（按仓库脚本实际名称执行）
- `git status --short`

### 提交

- `test: 覆盖账户菜单与语音控制交互`
- `docs: 同步账户入口与语音控制产品规则`
- `chore: 重新构建前端产物`

## 阶段六：传输模式按钮视觉语义修正

### 变更文件

- `web/src/components/UserControls.vue`
- `web/src/styles.css`
- `web/e2e/smoke.spec.ts`
- `web/e2e/voice.spec.ts`
- `docs/account-rail-voice-controls-design.md`
- `docs/superpowers/plans/2026-07-25-account-rail-voice-controls.md`
- `web/dist/**`

### 工作项

1. 将“语音感应”和“持续传输”定义为平级模式，移除绿色选中态和 `aria-pressed` 开关语义。
2. 两种模式统一使用白色图标与文字，保留现有波形和发射图标。
3. 将按钮从固定宽度改为内容自适应宽度，设置约 `8px` 横向内边距和约 `44px` 可点击高度；右侧按钮组继续独立靠右。
4. 静止态不显示背景，hover、键盘聚焦、按下和切换中使用中性的交互反馈。
5. 增加指向目标模式的 tooltip，并让无障碍名称同时说明当前模式和切换目标。
6. 测试两种模式颜色一致、按钮尺寸随内容变化、右侧控件位置稳定、tooltip 与无障碍名称正确，保持原有 DTX 行为测试不变。

### 验证

- `npm run typecheck`
- Playwright 定向运行语音工具栏与真实 LiveKit DTX 用例。
- 桌面、移动端和窄视口截图检查。
- `npm run build`
- `go test ./...`

### 提交

- `docs: 修正传输模式按钮视觉语义`
- `fix: 统一传输模式按钮视觉与交互`
- `test: 覆盖传输模式按钮布局与提示`
- `chore: 重新构建前端产物`

## 完成标准

- 桌面与移动端服务器栏底部都存在持续可见、可访问的头像入口。
- 移动端无需打开频道抽屉即可切换服务器，抽屉不覆盖服务器栏。
- 用户设置和退出登录只存在于头像菜单，退出登录仍有二次确认。
- 频道栏底部在已连接时只展示语音信息和语音操作，未连接时不留禁用工具栏。
- 断开语音和退出登录在位置、图标、文案、颜色及确认流程上均不可混淆。
- DTX 默认开启、全局持久化，并在所有麦克风发布与重新发布路径中一致应用。
- 全量测试通过，工作区中的实现和构建产物均已提交。
