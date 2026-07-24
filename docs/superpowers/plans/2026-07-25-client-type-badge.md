# 成员列表客户端类型徽章

## 背景

频道右侧成员列表目前只展示在线/离线与角色图标，无法看出成员是通过什么客户端接入的。
项目已存在 Web、Electron 桌面端（`celery-web-speak-desktop`）、安卓壳（`celery-web-speak-android-shell`）
三种接入形态，需要在成员列表上直观标识每个在线用户的接入客户端。

## 设计决策

| 项目 | 结论 |
|------|------|
| 展示对象 | 仅在线用户显示，离线用户不显示 |
| 多端在线 | 每行只显示一个，按固定优先级取最高：`electron > android > web` |
| 识别方式 | 客户端自报（不解析 User-Agent），服务器对未知/缺失值归一为 `web` |
| 上报通道 | WebSocket URL query 参数：`/api/ws?client=electron\|android\|web` |
| 徽章性质 | 纯装饰，不参与任何权限/功能逻辑（自报不可信） |
| 图标 | Lucide `Monitor`(electron) / `Smartphone`(android) / `Globe`(web)，统一灰色调，位于角色图标左侧 |
| Electron 检测 | `window.desktopApplicationAudio !== undefined`（该桥在所有平台无条件注入，Electron 工程零改动） |
| 安卓检测 | 壳注入 `window.celeryShell`，网页检测其存在；老版本壳降级显示 `web` |
| 数据模型 | 破坏性替换：`onlineIds: number[]` → `online: {userId, client}[]`（presence 事件 + 服务器 bootstrap） |
| 掉线回退 | 服务器按连接记录 clientType，广播时按存活连接重算每用户最高优先级（electron 断开后回落 android/web） |

## 变更范围

### 后端

- `internal/httpapi/hub.go` — 新增 `ClientKind` 类型与优先级；`client` 增加 `clientType` 字段；
  `OnlineUserIDs`/`OnlineGuildUserIDs` 替换为 `OnlineClients`/`OnlineGuildClients`（返回 `[]OnlineClient`）；
  `BroadcastPresence` 广播 `[]OnlineClient`；移除死代码 `onlineIDsLocked`
- `internal/httpapi/websocket.go` — `handleWebSocket` 解析 `client` query 参数并归一化
- `internal/httpapi/guild_api.go` — 服务器 bootstrap `onlineIds` → `online`
- `internal/httpapi/hub_test.go` — 断言助手改用新结构；新增多端优先级与掉线回退测试

### 前端

- `web/src/types.ts` — 新增 `ClientType`、`OnlineClient`；`BootstrapData`/`ServerBootstrapData` 的 `onlineIds` → `online`
- `web/src/env.d.ts` — 声明 `window.celeryShell`
- `web/src/stores/app.ts` — 新增 `onlineClients` 状态与 `detectClientType()`；WS URL 携带 `client` 参数；
  presence/bootstrap 处理改为解析 `online`；`clearServerState`/`removeUser` 同步清理
- `web/src/components/MemberList.vue` — 在线成员渲染客户端图标（角色图标左侧，灰色）
- `web/src/styles.css` — `.client-type` 样式

### E2E

- `web/e2e/presence.spec.ts` — bootstrap 断言 `onlineIds` → `online`

### 安卓壳（独立仓库 `celery-web-speak-android-shell`）

- `WebViewScreen.kt` — 通过 `addJavascriptInterface` 注入 `window.celeryShell` 标记（竞态安全，页面脚本执行前即可用）

## 兼容性

Web 前端由 Go 服务器同仓同发，Electron/安卓仅为加载服务器页面的薄壳，不存在前后端版本错配，
破坏性协议变更安全。老版本安卓壳在新后端上降级显示 `web`。
