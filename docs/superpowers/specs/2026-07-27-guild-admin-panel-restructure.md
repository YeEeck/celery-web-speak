# 服务器管理面板重构

日期：2026-07-27
状态：ready-for-agent

## Problem Statement

服务器管理员在「管理控制台」中管理服务器时，服务器级配置（重命名）与频道级配置混杂在同一个「频道」Tab 中，职责边界模糊。同时频道管理界面过于简陋——通过一个下拉框选择频道后平铺表单，缺乏结构化的频道列表、元数据展示和安全删除确认，与「平台服务器管理」页面（左侧列表 + 右侧详情 + 元数据卡片 + 危险区）的品质差距明显。

此外，AdminPanel 组件将 guild 管理和平台账号管理两种完全不同的职责通过 `platformMode` prop 强行复用在一个 575 行的单文件中，导致每段逻辑都需要条件分支，维护成本高。

## Solution

1. 将 AdminPanel 拆分为两个独立组件：GuildAdminPanel（服务器管理）和 PlatformAdminPanel（平台账号管理），仅共享 CSS 样式类
2. GuildAdminPanel 内部拆为三个 Tab 子组件：服务器设置、频道管理、成员管理
3. 频道管理 Tab 采用 master-detail 布局（参照 PlatformGuildsPanel 的设计模式）：左侧按类型分组的频道列表 + 右侧详情区（元数据卡片 + 设置表单 + 危险区）
4. 服务器设置独立为 Tab，当前仅含重命名，预留扩展

## User Stories

1. As a 服务器所有者, I want 服务器级配置（重命名）独占一个「服务器」Tab, so that 我能清晰区分服务器配置与频道配置的职责边界
2. As a 服务器所有者, I want 打开管理控制台时默认落在「服务器」Tab, so that 最高层级的设置第一眼可见
3. As a 服务器管理员, I want 只看到「频道 | 成员」两个 Tab, so that 界面不展示我无权操作的功能
4. As a 服务器管理员, I want 打开管理控制台时默认落在「频道」Tab, so that 直接进入我最常用的管理功能
5. As a 服务器管理员, I want 在左侧列表中按「语音频道」「文字频道」分组浏览所有频道, so that 快速定位目标频道而无需在下拉框中逐项翻找
6. As a 服务器管理员, I want 点击左侧列表中的频道后右侧展示其详情, so that 以 master-detail 模式高效浏览和编辑频道配置
7. As a 服务器管理员, I want 在频道详情中看到频道类型、创建时间和当前语音在线人数, so that 了解频道的使用状况再做管理决策
8. As a 服务器管理员, I want 通过左侧栏顶部按钮弹出小型对话框来创建频道, so that 创建入口明确且不占用列表空间
9. As a 服务器管理员, I want 创建频道成功后自动选中新频道, so that 立即查看或调整其配置而无需手动查找
10. As a 服务器管理员, I want 修改频道设置后通过统一的「保存频道设置」按钮提交, so that 所有变更一次性生效，行为可预期
11. As a 服务器管理员, I want 切换频道时静默丢弃未保存的修改, so that 切换操作流畅无阻断
12. As a 服务器管理员, I want 删除频道时在危险区输入频道名称确认, so that 避免误删导致消息永久丢失
13. As a 服务器管理员, I want 删除频道后自动选中列表中第一个频道, so that 界面不落入无选中状态
14. As a 服务器所有者, I want 「服务器」Tab 的结构预留扩展位, so that 后续新增服务器级功能（描述、图标等）时无需再改架构
15. As a 平台管理员, I want 平台账号管理面板的功能和体验完全不变, so that 本次重构不影响我的日常工作流
16. As a 移动端管理员, I want 频道管理在小屏下自动堆叠为列表在上、详情在下, so that 在手机上也能完成频道管理操作
17. As a 开发者, I want GuildAdminPanel 和 PlatformAdminPanel 完全解耦, so that 修改任一面板不会意外影响另一个

## Implementation Decisions

### 组件架构

- 删除 AdminPanel.vue，拆分为：
  - **GuildAdminPanel.vue** — 模态壳（backdrop + header + tab 栏 + footer 状态栏），组合三个子 Tab
  - **GuildSettingsTab.vue** — 服务器设置（当前仅重命名，owner-only）
  - **ChannelAdminTab.vue** — 频道管理 master-detail + 创建弹窗 + 危险区
  - **MemberAdminTab.vue** — 成员管理（逻辑与 UI 从原 AdminPanel 原样搬迁）
  - **PlatformAdminPanel.vue** — 平台账号 + 创建与邀请两个 Tab（从原 AdminPanel platformMode 原样搬迁）
- 两个面板仅共享 CSS 样式类（panel-header、panel-footer、admin-tabs 等），不共享组件实例或 JS 逻辑
- GuildAdminPanel 的 footer 状态栏（message/errorMessage/busy）由壳持有，通过 provide 或 props/emit 传递给子 Tab

### Tab 规则

- 顺序固定：服务器 | 频道 | 成员
- 可见性跟随内容权限：「服务器」Tab 仅 owner 可见（平台管理员在 guild 管理上下文中沿用现有 canRenameGuild 逻辑）
- 默认 Tab：owner → 服务器；admin → 频道
- 图标：服务器 = Settings，频道 = Gauge（保持），成员 = UserCog（保持）

### 频道管理 master-detail

- 左侧列表：按类型分组（语音频道 / 文字频道），列表项与主界面频道侧栏一致（类型图标 + 名称），顶部「创建频道」按钮
- 同一分组内的相邻频道项保持 4px 纵向间隔，已选中和未选中项遵循同一规则
- 右侧详情区自上而下：
  1. 头部：频道标识 + 名称 + 类型
  2. 元数据卡片（dl 样式）：频道类型、创建时间、当前语音在线人数（仅 voice，数据源 = store voiceRooms）
  3. 频道设置 section：名称 input、Opus 码率 slider（voice）、背景音码率 slider（voice）、RED toggle ×2（voice）、保留消息数量（text）、「保存频道设置」按钮（批量保存）
  4. 危险区 section：「永久删除频道」展开后输入频道名确认（同 PlatformGuildsPanel 删除服务器模式）
- 切换频道时静默丢弃未保存修改（watch selectedChannel 重置表单）
- 删除成功后选中第一个频道
- 创建弹窗：小型居中 dialog（复用 overlay-in-modal 模式），字段仅类型 select + 名称 input，其余用服务端默认值，成功后自动选中新频道

### 消息总数

- 本次不展示（全链路不存在该数据），后续需后端新增 count 接口

### AppShell 集成

- 移除 adminOpen / adminPlatformMode / adminInitialTab 三合一状态
- GuildAdminPanel 由 GuildActionMenu manage 事件打开；PlatformAdminPanel 由 PlatformGuildsPanel accounts 事件打开
- 两者各自独立开关状态

### 后端

- 零变更。频道 CRUD API、voiceRooms 数据均已存在

### 响应式

- 移动端频道 master-detail 遵循既有堆叠约定（同 user-admin-layout / platform-guild-layout：列表在上、详情在下）

### 术语

- 代码层使用 Guild 术语（组件名 GuildAdminPanel、变量 guildName 等），UI 中文文案保留「服务器」

## Testing Decisions

### 测试原则

只测外部行为（用户可见的 UI 状态与交互结果），不测实现细节（组件内部结构、CSS 类名组合）。通过真实 UI 操作驱动，验证用户故事的端到端达成。

### 测试接缝

唯一接缝：Playwright E2E 层（后端零变更，无需新增 Go 测试）。

### 需更新的现有测试

| 测试 | 原因 |
|------|------|
| 管理员可创建和删除独立文字频道 | 旧「选择频道」下拉 + window.confirm 删除流程已不存在 |
| 登录、聊天和管理员设置可用 | 使用 getByLabel('选择频道') 定位旧 UI |
| 管理控制台外框不随页签内容变化 | Tab 结构变化（新增服务器 Tab） |
| 管理控制台成员列表和详情分别滚动 | 选择器可能需微调 |
| mockMemberModerationRoles 辅助函数 | 打开管理面板后的 Tab 导航逻辑变化 |

### 新增测试

1. **频道 master-detail 联动**：选中左侧频道 → 右侧元数据正确（类型/创建时间/语音在线人数）+ 设置表单值与频道属性一致
2. **创建频道弹窗**：按钮打开 dialog → 填写类型+名称 → 提交 → dialog 关闭 + 新频道自动选中 + 左侧列表出现
3. **危险区删除**：展开删除 → 确认按钮 disabled → 输入错误名称仍 disabled → 输入正确名称 → 确认删除 → 频道从列表消失 + 选中回退到第一个
4. **Tab 可见性与默认值**：owner 看到三个 Tab 且默认「服务器」；admin（mock）看到两个 Tab 且默认「频道」
5. **服务器 Tab 重命名**：修改名称 → 保存 → 主界面服务器名称同步更新

### 先例

- `openGuildAdmin()` / `openPlatformAccounts()` 辅助函数（smoke.spec.ts）
- `mockMemberModerationRoles()` — route mock bootstrap 注入角色
- PlatformGuildsPanel 删除服务器测试模式（输入名称确认）

## Out of Scope

- 消息总数展示（需后端 count 接口，后续独立任务）
- 频道排序 / 拖拽重排
- 所有权转让、删除服务器（保留在平台面板，guild 管理面板不新增）
- 成员 Tab 任何功能变更（仅搬迁）
- 频道设置即时保存（保持批量保存模型）
- 服务器 Tab 新增重命名以外的功能
- PlatformGuildsPanel 本身的任何改动

## Further Notes

- AdminPanel.css 需拆分为 GuildAdminPanel 和 PlatformAdminPanel 对应的样式文件（遵循项目既有的 per-component CSS 拆分规范），共享的模态壳样式（panel-header / panel-footer / admin-tabs）保留在公共位置
- responsive.css 中 `.admin-panel` 相关规则需更名适配新组件，并新增频道 master-detail 的堆叠规则
- 现有 E2E 辅助函数 `openGuildAdmin()` 的断言（heading '服务器管理'）应保持不变以兼容
- 本次重构是纯前端变更，不影响 Go 后端和 API 契约，发版无需数据库迁移
