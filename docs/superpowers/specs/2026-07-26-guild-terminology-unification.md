# 全栈 Guild 术语统一重构

## Problem Statement

项目中核心业务实体（用户组成的多频道群组）存在命名分裂：后端 DB/Go 层使用 `Guild`，而 API 路由、JSON 字段、前端代码使用 `Server`。这导致：

- `httpapi/server.go` 中的 `Server` struct（HTTP 服务器）与 `/api/servers/` 路由（业务实体）语义撞名，阅读代码时频繁混淆
- `Channel.GuildID` 序列化为 `"serverId"` 而 `GuildMember.GuildID` 序列化为 `"guildId"`，JSON 协议自相矛盾
- 前端 `ServerSummary`、`activeServerId` 等命名与后端 `Guild` 类型脱节

## Solution

将 API 层和前端代码层全部对齐到后端已有的 `Guild` 术语，实现全栈代码命名统一。UI 中文文案保留"服务器"（Discord 既有用户认知，零学习成本）。采用 hard-cut 策略，不保留旧路由兼容。

## User Stories

1. As a backend developer, I want `/api/guilds/` routes instead of `/api/servers/`, so that route paths match the `Guild` domain model and don't collide with the HTTP `Server` struct.
2. As a backend developer, I want handler functions named `handleGuildBootstrap` instead of `handleServerBootstrap`, so that grep/IDE navigation finds business logic without HTTP server noise.
3. As a backend developer, I want the WS event struct field to be `GuildID json:"guildId"`, so that the wire protocol is internally consistent.
4. As a backend developer, I want WS event types `guild_added`/`guild_removed` instead of `server_added`/`server_removed`, so that event names match the domain vocabulary.
5. As a frontend developer, I want `GuildSummary` instead of `ServerSummary` in types.ts, so that frontend types mirror backend JSON serialization exactly.
6. As a frontend developer, I want `activeGuildId` instead of `activeServerId` in stores, so that state variables align with the API field names.
7. As a frontend developer, I want component files named `PlatformGuildsPanel.vue` and `GuildActionMenu.vue`, so that file search matches the domain term.
8. As a frontend developer, I want CSS classes like `.guild-rail`, `.guild-button` instead of `.server-rail`, `.server-button`, so that styling code uses consistent vocabulary.
9. As a frontend developer, I want API call paths `/api/guilds/${id}/...` in fetch calls, so that frontend matches backend routes after hard-cut.
10. As an E2E test author, I want helper functions named `firstJoinedGuildID` and `createGuildMember`, so that test code reads consistently with the app domain.
11. As an end user, I want the UI to still say "服务器" in Chinese text, so that my existing mental model is not disrupted.
12. As a developer reviewing diffs, I want the rename split into layer-based commits, so that each commit is reviewable in isolation.

## Implementation Decisions

### 命名映射表

| 旧 | 新 | 层 |
|---|---|---|
| `/api/servers/{serverID}` | `/api/guilds/{guildID}` | API 路由 |
| `/api/platform/servers` | `/api/platform/guilds` | API 路由 |
| `"serverId"` (Channel JSON) | `"guildId"` | JSON 字段 |
| `event.ServerID` / `"serverId"` | `event.GuildID` / `"guildId"` | WS 协议 |
| `"server_added"` / `"server_removed"` | `"guild_added"` / `"guild_removed"` | WS 事件类型 |
| `handleServerBootstrap` 等 | `handleGuildBootstrap` 等 | Go handler |
| `handlePlatformServers` 等 | `handlePlatformGuilds` 等 | Go handler |
| `renameServer` | `renameGuild` | Go 内部方法 |
| `ServerSummary` | `GuildSummary` | TS 类型 |
| `ServerBootstrapData` | `GuildBootstrapData` | TS 类型 |
| `activeServerId` | `activeGuildId` | TS 状态 |
| `connectedServerId` | `connectedGuildId` | TS 状态 |
| `serverMuted` | `guildMuted` | TS 状态 |
| `PlatformServersPanel.vue` | `PlatformGuildsPanel.vue` | 组件文件 |
| `ServerActionMenu.vue` | `GuildActionMenu.vue` | 组件文件 |
| `LeaveServerDialog.vue` | `LeaveGuildDialog.vue` | 组件文件 |
| `.server-rail`, `.server-button` 等 | `.guild-rail`, `.guild-button` 等 | CSS 类名 |
| `.platform-server-*` | `.platform-guild-*` | CSS 类名 |
| `firstJoinedServerID` | `firstJoinedGuildID` | E2E helper |
| `createServerMember` | `createGuildMember` | E2E helper |

### 不动的部分

- **DB 表名和 Go 领域模型**：已经是 `guilds`/`Guild`，无需迁移
- **UI 中文文案**：保留"服务器"（如"只有服务器所有者可以重命名"、"未选择服务器"）
- **localStorage 键名**：`cws.volume.${userId}` 等按用户存储，不涉及此实体
- **LiveKit room 命名**：`guild-{id}-channel-{id}` 已是 Guild 前缀
- **HTTP `Server` struct**：这是 HTTP 基础设施，保留不动

### 提交策略（按层拆）

1. `refactor: 后端 API 路由与 handler 统一 Guild 术语`
   - server.go 路由注册：`/api/servers/` → `/api/guilds/`，`/api/platform/servers` → `/api/platform/guilds`
   - guild_api.go handler 函数重命名
   - hub.go WS event struct 和事件类型重命名
   - websocket.go 局部变量 `servers` → `guilds`
   - Go 测试适配

2. `refactor: 前端类型、状态与 API 调用统一 Guild 术语`
   - types.ts 接口重命名
   - stores（app.ts, app-socket.ts, voice.ts）变量和 API 路径
   - api 调用路径全部 `/api/guilds/`
   - Channel.serverId → Channel.guildId

3. `refactor: 前端组件、文件名与 CSS 类名统一 Guild 术语`
   - 组件文件重命名（PlatformServersPanel → PlatformGuildsPanel 等）
   - CSS 文件和类名重命名
   - E2E 测试 helper 和 spec 适配
   - import 路径更新

### 约束

- `Server` struct（httpapi/server.go）保留——它是 HTTP 服务器本身
- `ServerCog` 等 lucide 图标名保留——那是第三方库 API
- 错误提示中的中文"服务器"保留（UI 文案层）
- 不引入 API 版本化或双路由兼容

## Testing Decisions

### 什么是好的测试

纯重命名重构不引入新行为。好的测试 = 现有测试在重命名后仍然通过，证明行为未变。

### 测试覆盖

- **Go HTTP 测试**（`guild_http_test.go`）：路由路径和 JSON 字段重命名后，所有现有断言仍 pass
- **Go Store 测试**（`guilds_test.go`）：不涉及，DB 层不动
- **Go Hub 测试**（`hub_test.go`）：WS 事件类型和字段重命名后 pass
- **Playwright E2E**（`smoke.spec.ts`, `voice.spec.ts`, `presence.spec.ts`）：完整用户流程仍可用

### Prior Art

- `guild_http_test.go` 已有完整的 HTTP 级别测试（创建/重命名/加入/离开/成员管理）
- E2E `api-helpers.ts` 封装了 bootstrap + 成员创建流程

## Out of Scope

- 数据库 schema 迁移（已是 Guild）
- 用户可见文案变更（保留"服务器"）
- API 版本化或向后兼容路由
- Electron 桌面端或 Android 客户端代码适配（它们消费同一 Web bundle，自动跟随）
- 第三方服务集成命名（LiveKit room 已是 `guild-*`）
- 文档更新（docs/ 中的设计文档可在后续独立更新）

## Further Notes

- 当前版本 v0.4.2，此重构预计随下一个 minor 版本发布
- 重构完成后应执行一次全量 `go test ./...` + `npx playwright test` 验证
- CSS 类名重命名需同步检查 `responsive.css` 中的媒体查询引用
- `AppShell.vue` 中 `ServerCog` 图标导入来自 lucide，是第三方 API 名称，不改
