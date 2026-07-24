# 受控多服务器改动深入审查记录

> - 审查日期：2026-07-24
> - 审查范围：`f1aa4d3cd54de1a680ed8b4fa5bf6ff4c0719834` 至 `3db7b7fd4fa1e872276b78508d8238479063dd0a`
> - 审查对象：数据迁移、平台与服务器权限、HTTP API、业务 WebSocket、LiveKit、前端切服与管理流程
> - 文档状态：问题已确认，尚未修复

## 1. 结论摘要

本轮审查确认 6 个需要修复的问题，其中 2 个为 P1，4 个为 P2：

| 编号 | 优先级 | 问题 | 主要风险 |
| --- | --- | --- | --- |
| MMS-R01 | P1 | 所有权可转让给已删除或已停用账号 | 服务器失去有效所有者，破坏核心数据不变量 |
| MMS-R02 | P1 | 临时封禁的平台管理员可重新订阅服务器实时事件 | 被封禁账号仍可接收消息、成员和语音状态 |
| MMS-R03 | P2 | 创建服务器和转让所有权后未同步在线客户端 | 在线所有者和成员权限状态持续陈旧，必须刷新 |
| MMS-R04 | P2 | 前端丢弃临时封禁截止时间 | 管理界面无法提前解除临时封禁 |
| MMS-R05 | P2 | 临时封禁到期恢复依赖进程内定时器 | 服务重启后在线用户不会按时恢复服务器 |
| MMS-R06 | P2 | WebSocket 重同步和语音加入未绑定请求服务器 | 切服竞态可用旧服务器响应覆盖当前状态 |

这些问题不会被当前 happy-path 测试稳定触发。现有单元测试、竞态检测、前端构建和非 LiveKit E2E 均通过，因此修复时必须增加针对状态转换和并发时序的回归用例，不能只依赖现有测试集。

## 2. 审查基准与系统不变量

本轮判断以 `docs/managed-multi-server-design.md`、`docs/product-spec.md` 和当前实现共同定义的行为为基准。以下不变量直接影响问题优先级：

1. 每个服务器必须恰好有一名有效所有者。
2. 所有者必须是该服务器的有效成员，且对应平台账号未删除、未停用。
3. 被服务器临时或永久封禁的账号不能读取内容，也不能订阅该服务器的实时事件。
4. `server_added` 和 `server_removed` 必须同步更新在线账号的 Hub 订阅集合。
5. 创建服务器、转让所有权和成员角色变化必须让相关在线客户端收敛到权威状态。
6. 临时封禁到期后，成员应在到期事件或下一次权威快照后恢复原成员关系和角色。
7. 异步请求的响应只能写入其发起时对应的服务器状态，不能污染后来选择的服务器。

## 3. MMS-R01：所有权可转让给已删除或已停用账号

**优先级：P1**

### 3.1 当前行为

`Store.DeleteUser` 使用软删除保留 `users` 墓碑，同时保留该账号原有的 `guild_members` 记录。该行为可以保留历史消息关联，但也使已删除账号继续满足单纯的成员表查询。

`Store.TransferGuildOwnership` 判断新所有者是否“活跃”时只查询 `guild_members`：

- 成员记录存在；
- `permanently_banned = 0`；
- 临时封禁为空或已经到期。

查询没有联接 `users`，因此不会检查：

- `users.deleted_at IS NULL`；
- `users.suspended_at IS NULL`；
- 平台级 `users.permanently_banned = 0`。

涉及代码：

- `internal/store/admin.go`：`DeleteUser`
- `internal/store/guilds.go`：`TransferGuildOwnership`
- `internal/httpapi/guild_api.go`：`handlePlatformServerOwner`

### 3.2 已确认复现

在独立临时数据库中执行以下流程：

1. 平台管理员创建普通平台账号。
2. 将该账号加入默认服务器，使其拥有 `guild_members` 记录。
3. 删除该平台账号，接口返回 `204`。
4. 调用 `PATCH /api/platform/servers/{serverID}/owner`，将 `userId` 设置为已删除账号 ID。
5. 接口返回 `200`，响应中的 `ownerUserId` 已变为该墓碑账号 ID。

等价请求示例：

```http
PATCH /api/platform/servers/1/owner
Content-Type: application/json

{"userId": 10}
```

实际结果：

```json
{
  "server": {
    "id": 1,
    "ownerUserId": 10
  }
}
```

此时账号 10 已被软删除。

### 3.3 影响

- 服务器的有效所有者不变量被破坏。
- `GuildMembership` 联接有效用户时无法返回该所有者，服务器成员视图中没有可用所有者。
- 原所有者被降为管理员，但新所有者无法登录或执行所有者操作。
- 后续平台操作只能再次转让或删除服务器；普通服务器管理流程无法自行恢复。
- `ListGuildsForUser` 中基于 `guild_members` 的成员数量还会包含软删除墓碑，造成平台元数据长期偏大。
- 同一缺口允许把所有权转给平台级停用账号，虽然该账号仍不能登录。

### 3.4 建议修复

1. 在 `TransferGuildOwnership` 的同一事务中联接 `users`，要求目标账号未删除、未停用且未被平台级永久停用。
2. 将“有效所有者候选”收口为 Store 层查询，避免 HTTP 和前端各自实现不完整判断。
3. 删除账号时删除其非所有者 `guild_members` 记录，或明确把所有涉及成员统计和所有权候选的查询限制为有效用户。删除成员关系不会影响历史消息，因为消息仍引用用户墓碑。
4. 保持 `DeleteUser` 对当前所有者的前置拒绝，但不能依赖该检查阻止删除之后的反向转让。

建议的目标查询条件：

```sql
SELECT COUNT(*)
FROM guild_members gm
JOIN users u ON u.id = gm.user_id
WHERE gm.guild_id = ?
  AND gm.user_id = ?
  AND gm.permanently_banned = 0
  AND (gm.temporary_ban_until IS NULL OR gm.temporary_ban_until <= ?)
  AND u.deleted_at IS NULL
  AND u.suspended_at IS NULL
  AND u.permanently_banned = 0;
```

### 3.5 必需回归测试

- 拒绝转让给已删除成员。
- 拒绝转让给平台级停用成员。
- 拒绝转让给服务器临时封禁或永久封禁成员。
- 允许转让给普通有效成员，并保留旧所有者的管理员成员关系。
- 删除非所有者账号后，服务器成员数量不再包含该墓碑账号。
- 直接构造 API 请求时也不能绕过前端候选列表限制。

## 4. MMS-R02：临时封禁的平台管理员可重新订阅实时事件

**优先级：P1**

### 4.1 当前行为

平台管理员显式加入服务器时，调用链为：

```text
POST /api/platform/servers/{serverID}/join
  -> handlePlatformJoinServer
  -> Store.JoinGuildAsAdmin
  -> Hub.AddUserGuild
```

`JoinGuildAsAdmin` 的冲突更新仅要求 `guild_members.permanently_banned = 0`，没有拒绝尚未到期的 `temporary_ban_until`。Store 返回成员后，Handler 无条件调用 `Hub.AddUserGuild`。

结果是：

- `requireGuildMember` 仍会拒绝该账号的服务器 HTTP 内容请求；
- Hub 已经把该账号加入服务器订阅集合；
- 该账号仍可被动收到该服务器的消息、成员、频道、在线和语音事件。

另一个防御缺口位于 `handleServerClearTemporaryBan`：清除临时封禁后无条件调用 `Hub.AddUserGuild`。当前 UI 通常不会同时提交永久封禁和临时封禁，但 API 允许构造二者同时存在的状态；此时仅清除临时封禁也会把仍被永久封禁的账号加入 Hub。

涉及代码：

- `internal/store/guilds.go`：`JoinGuildAsAdmin`
- `internal/httpapi/guild_api.go`：`handlePlatformJoinServer`
- `internal/httpapi/guild_api.go`：`handleServerClearTemporaryBan`
- `internal/httpapi/hub.go`：`AddUserGuild`

### 4.2 触发场景

正常业务流程即可触发主要问题：

1. 平台管理员已显式加入服务器。
2. 服务器所有者对该平台管理员设置临时封禁。
3. Handler 调用 `RemoveUserGuild`，账号暂时停止接收事件。
4. 被封禁的平台管理员通过平台接口再次执行“加入服务器”。
5. Store 将角色更新为 `admin`，保留未到期临时封禁；Handler 随后重新加入 Hub。

### 4.3 影响

- 服务器封禁不再是完整的实时数据隔离边界。
- 被封禁账号能够继续观察新消息摘要、成员变动、在线状态和语音占用。
- HTTP 返回禁止访问并不能弥补 WebSocket 已经泄露增量事件的问题。
- 平台管理员身份意外成为绕过服务器临时封禁的一条路径。

### 4.4 建议修复

1. `JoinGuildAsAdmin` 必须拒绝所有当前无效的成员记录，包括永久封禁和未到期临时封禁。
2. Handler 在调用 `AddUserGuild` 前必须依据返回成员的完整有效性做防御检查。
3. `ClearGuildMemberTemporaryBan` 后只有在 `PermanentlyBanned == false` 时才能恢复 Hub 订阅。
4. 建议增加统一的 `GuildMember.ActiveAt(now)` 或 Store 查询，避免不同 Handler 分别判断封禁状态。
5. 明确 API 是否允许永久封禁和临时封禁同时存在；若不允许，应在 `SetGuildMemberBan` 验证输入并规范化存储状态。

### 4.5 必需回归测试

- 临时封禁的平台管理员调用平台加入接口返回受控错误。
- 被临时封禁账号不会收到目标服务器的 `message_created`、`member_updated` 或 `voice_rooms`。
- 清除临时封禁但仍永久封禁时，不恢复 Hub 订阅。
- 完全解除封禁后，仅恢复目标服务器订阅，不影响其他服务器。
- 封禁、加入和解封的 HTTP 状态与 Hub 订阅状态始终一致。

## 5. MMS-R03：服务器生命周期变化未同步在线客户端

**优先级：P2**

### 5.1 创建服务器缺少 `server_added`

`handlePlatformCreateServer` 创建数据库记录后直接返回 `201`，没有调用：

```go
s.hub.AddUserGuild(guild.OwnerUserID, guild.ID)
```

因此，当平台管理员把一个当前在线账号指定为所有者时：

- 数据库中已经存在所有者成员关系；
- 所有者当前 WebSocket 的 `client.guilds` 没有新服务器；
- 所有者收不到该服务器事件；
- 左侧服务器栏不会出现新服务器；
- 必须刷新页面或重连 WebSocket 才能恢复。

涉及代码：`internal/httpapi/guild_api.go` 的 `handlePlatformCreateServer`。

### 5.2 转让所有权缺少角色事件

`handlePlatformServerOwner` 完成转让后也只返回 HTTP 响应，没有向服务器成员广播所有权变化。

受影响状态包括：

- 新所有者的 `activeServer.role` 仍为旧角色，无法立即看到所有者管理入口；
- 旧所有者仍显示 `owner`，直到下一次权威 bootstrap；
- 成员列表中的新旧所有者角色不更新；
- 平台管理员发起方会因为界面主动调用 `bootstrap` 而恢复，但其他在线客户端不会恢复。

涉及代码：

- `internal/store/guilds.go`：`TransferGuildOwnership`
- `internal/httpapi/guild_api.go`：`handlePlatformServerOwner`
- `web/src/stores/app.ts`：`server_updated`、`member_updated` 事件处理

### 5.3 建议修复

1. 创建服务器事务成功后，对所有者调用 `Hub.AddUserGuild`，使其收到定向 `server_added`。
2. 转让所有权时返回旧所有者 ID 和新旧成员权威快照，或在 Handler 中重新读取二者成员信息。
3. 转让成功后向目标服务器广播足以更新下列状态的事件：
   - 服务器摘要；
   - 旧所有者有效角色；
   - 新所有者有效角色。
4. 若继续复用 `server_updated`，事件数据必须包含接收者自己的有效角色；否则应新增明确的 `server_membership_updated` 或触发客户端重取服务器 bootstrap。

### 5.4 必需回归测试

- 在线账号被指定为新服务器所有者后立即收到 `server_added`。
- 新所有者无需刷新即可看到服务器和所有者管理入口。
- 转让后，新旧所有者和旁观成员的成员列表角色同时更新。
- 旧所有者立即失去所有者专属入口，但保留管理员能力。
- 事件只发给目标服务器成员，不泄露给未加入的平台管理员。

## 6. MMS-R04：前端丢弃临时封禁截止时间

**优先级：P2**

### 6.1 当前行为

后端 `store.GuildMember` 已通过 JSON 返回 `temporaryBanUntil`，但前端在三处丢弃该字段：

1. `web/src/types.ts` 的 `ServerBootstrapData.members` 未声明 `temporaryBanUntil`。
2. `web/src/stores/app.ts` 的 `loadServerBootstrap` 成员映射未复制该字段。
3. 同文件 `synchronizeSocket` 和 `member_added/member_updated` 事件映射也未复制该字段。

`AdminPanel.vue` 仅在 `selectedUser.temporaryBanUntil` 存在时显示“解除临时封禁”按钮。由于 Store 中的成员对象永远没有该字段，该按钮实际上不可达。

### 6.2 影响

- 管理员可以设置临时封禁，但不能从 Web UI 提前解除。
- 即使刷新或 WebSocket 重连，字段仍会在 DTO 映射时再次丢失。
- 实时 `member_updated` 也无法呈现临时封禁的新增、延期或清除。
- 用户只能等待到期或直接调用 API。

### 6.3 建议修复

1. 在 `ServerBootstrapData.members` 和 `membership` 类型中补充可选 `temporaryBanUntil`。
2. 抽取单一的 `mapGuildMember` 函数，供普通 bootstrap、WebSocket 重同步和实时成员事件共用。
3. 映射完整保留服务器成员字段，避免以后新增字段时再次出现多处遗漏。
4. 管理界面显示明确的临时封禁截止时间，并在清除成功后使用响应成员更新本地状态。

建议类型：

```ts
interface GuildMemberPayload {
  guildId: number
  userId: number
  username: string
  displayName: string
  role: GuildRole
  voiceMuted: boolean
  textMuted: boolean
  permanentlyBanned: boolean
  temporaryBanUntil?: string
  joinedAt: string
}
```

### 6.4 必需回归测试

- 设置临时封禁后，管理界面显示截止时间和解除按钮。
- 刷新页面后该状态仍存在。
- WebSocket 重连后该状态仍存在。
- 另一管理员修改或清除临时封禁时，当前页面通过实时事件更新。
- 点击解除后按钮消失，目标成员恢复状态与后端一致。

## 7. MMS-R05：服务重启会丢失临时封禁到期恢复

**优先级：P2**

### 7.1 当前行为

临时封禁时，Handler 调用 `scheduleGuildMembershipRestore` 创建 `time.AfterFunc`。定时器到期后读取成员状态并调用 `Hub.AddUserGuild`。

该机制只存在于 Go 进程内：

- 应用重启会丢失全部待执行定时器；
- 启动时没有扫描未到期临时封禁并重新调度；
- 也没有周期任务扫描已经到期但尚未恢复的 Hub 订阅。

WebSocket 建立时只调用一次 `ListGuildsForUser` 初始化订阅。若用户在封禁期间保持业务连接，而服务端重启并让客户端自动重连，则该连接会在封禁尚未到期时被排除。封禁之后到期时，没有事件再次把它加入 Hub。

涉及代码：

- `internal/httpapi/guild_api.go`：`scheduleGuildMembershipRestore`
- `internal/httpapi/websocket.go`：`handleWebSocket`
- `internal/store/guilds.go`：`ListGuildsForUser`

### 7.2 影响

- 临时封禁的实际可见时长可能超过数据库记录的截止时间。
- 用户需要手动刷新或再次断线重连才能看到服务器恢复。
- 数据库权威状态与进程内 Hub 状态长期不一致。
- 部署升级和容器自动重启会稳定触发该边界。

### 7.3 建议修复

优先采用可由数据库重建的恢复机制，不把正确性完全依赖于内存定时器：

1. 启动时扫描未来临时封禁并重新调度，扫描已到期记录并恢复在线账号订阅；或
2. 增加低频数据库协调任务，查找刚到期成员并更新 Hub；或
3. 让客户端在最近临时封禁截止时间到达时主动请求全局 bootstrap，但服务端仍应保留最终一致性兜底。

内存定时器可以继续作为低延迟优化，但数据库扫描必须承担重启后的正确性恢复。

### 7.4 必需回归测试

- 用户临时封禁期间重启服务，封禁到期后无需手动刷新即可收到 `server_added`。
- 重启发生在截止时间之后时，连接建立后立即恢复有效服务器。
- 延长、缩短和提前清除封禁不会被旧定时器错误恢复。
- 临时封禁转为永久封禁后，任何旧定时器都不能恢复订阅。
- 用户已离开服务器或账号已删除时，到期任务不得创建幽灵 Hub 成员关系。

## 8. MMS-R06：异步请求未绑定发起时的服务器

**优先级：P2**

### 8.1 WebSocket 重同步竞态

`web/src/stores/app.ts` 的 `synchronizeSocket` 执行以下流程：

```text
读取全局 bootstrap
  -> 使用当前 activeServerId 请求服务器 bootstrap
  -> 等待响应
  -> 无条件 applyBootstrap
```

它只检查 WebSocket 是否仍是当前连接以及期间是否收到新事件，没有捕获和校验请求发起时的服务器 ID。

竞态时序：

1. 当前服务器为 A，WebSocket 开始重同步并请求 A bootstrap。
2. 用户切换到服务器 B，`selectServer(B)` 正常加载 B。
3. A 的慢响应随后返回。
4. `synchronizeSocket` 把 A 的成员、频道、已读和语音房间覆盖到当前 B 界面。

`loadServerBootstrap` 已有 `serverBootstrapVersion` 和服务器 ID 双重检查，但 `synchronizeSocket` 没有复用该保护。

### 8.2 语音加入竞态

`web/src/stores/voice.ts` 的 `join` 在请求 Token 前读取 `app.activeServerId` 拼接 URL，但请求返回后再次读取当前 `app.activeServerId` 写入：

- `connectedServerId`；
- `connectedServerName`；
- 后续离开与耳机静音请求的服务器作用域。

若 Token 请求期间用户从 A 切到 B，客户端可能拿到 A 的 LiveKit Token，却把连接记为 B。后续影响包括：

- 语音连接面板显示错误服务器名称；
- `voice/leave` 请求发往 B，服务端不会撤销 A 的目标连接；
- `voice/state` 使用 B 的服务器路径和 A 的频道 ID，返回 404；
- 本地状态与 LiveKit 实际房间不一致。

### 8.3 建议修复

1. 所有服务器作用域异步操作在发起前捕获不可变 `serverId`。
2. 响应写入状态前同时验证：
   - 请求版本仍是最新；
   - 当前选择仍等于捕获的 `serverId`；
   - 频道仍属于捕获的服务器。
3. `synchronizeSocket` 应调用已经有版本保护的 `loadServerBootstrap`，或共享同一个请求协调器。
4. 语音连接元数据必须来自捕获的服务器摘要，而不是 Token 返回后的全局活动状态。
5. 用户切服不必强制退出原语音，但原语音的服务器和频道上下文必须保持稳定。

建议模式：

```ts
const serverId = app.activeServerId
const server = app.activeServer
if (serverId === null || !server) return

const credentials = await request<VoiceCredentials>(
  `/api/servers/${serverId}/channels/${channelId}/voice/token`,
  { method: 'POST' },
)

connectedServerId.value = serverId
connectedServerName.value = server.name
```

### 8.4 必需回归测试

- 人为延迟 A bootstrap，在响应前切换 B，最终界面只能保留 B 状态。
- WebSocket 重连同步期间连续切换 A/B，多次响应乱序也不能污染当前服务器。
- 延迟 A 的语音 Token 响应并切换到 B，连接摘要仍显示 A。
- 在浏览 B 时退出 A 的语音，服务端收到 A 的 `voice/leave`。
- 在浏览 B 时修改 A 语音的耳机静音，调用仍使用 A 的服务器和频道路径。

## 9. 修复顺序建议

建议按以下顺序实施，以先恢复安全和数据不变量，再处理状态一致性：

1. **MMS-R01**：收紧所有权候选，并处理软删除成员关系。
2. **MMS-R02**：统一有效成员判断，阻断封禁状态下的 Hub 订阅。
3. **MMS-R03**：补齐创建服务器和所有权转让的实时生命周期事件。
4. **MMS-R05**：让临时封禁恢复可跨进程重启重建。
5. **MMS-R04**：统一前端成员 DTO 映射并恢复管理入口。
6. **MMS-R06**：为切服和语音异步操作增加服务器版本保护。

MMS-R01 与 MMS-R02 应拆成独立提交，便于单独审查权限和数据约束。前端 DTO 修复与异步竞态也应分开提交，避免把字段映射和请求协调混在同一变更中。

## 10. 统一验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 删除普通成员后尝试转让所有权 | 返回受控错误，所有者不变 |
| 停用成员后尝试转让所有权 | 返回受控错误，所有者不变 |
| 在线账号被指定为新服务器所有者 | 立即收到 `server_added` 并看到服务器 |
| 在线状态下转让所有权 | 新旧所有者和成员列表角色立即收敛 |
| 临时封禁的平台管理员再次加入服务器 | 请求被拒绝，且收不到目标服务器事件 |
| 临时与永久封禁同时存在，仅清除临时封禁 | 不恢复 Hub 订阅 |
| 临时封禁到期 | 原成员关系和角色恢复，收到服务器恢复事件 |
| 临时封禁期间重启服务 | 到期恢复仍然生效 |
| 管理员刷新或重连 | 临时封禁截止时间仍可见 |
| WebSocket 同步 A 时切换到 B | A 的迟到响应不得覆盖 B |
| 请求 A 语音 Token 时切换到 B | 语音连接仍稳定记录为 A |
| 浏览 B 时退出 A 语音 | A 房间参与者被正确移除 |

## 11. 已执行验证

审查期间执行了以下验证：

```text
go test ./...
go test -race ./internal/httpapi ./internal/media ./internal/store
go vet ./...
cd web && npm run build
cd web && E2E_BASE_URL=<独立临时后端> npm run test:e2e
```

结果：

- Go 单元测试通过。
- Go 竞态检测通过。
- `go vet` 通过。
- 前端类型检查和生产构建通过。
- 独立临时后端 E2E：37 项通过，11 项按配置跳过。
- 跳过项主要为未设置 `E2E_LIVEKIT=1` 的真实 LiveKit 语音测试，以及按项目条件只在单一视口执行的测试。
- MMS-R01 另通过独立临时数据库和真实 HTTP API 完成定向复现。

现有测试全部通过并不否定上述问题：MMS-R01、MMS-R02、MMS-R03 和 MMS-R05 缺少对应生命周期测试，MMS-R04 缺少临时封禁 UI 测试，MMS-R06 缺少可控延迟和乱序响应测试。
