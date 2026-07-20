# Celery Web Speak 技术架构

> 当前实现基线：v0.0.2。系统面向单机、单 Go 进程和单 LiveKit 节点部署，不具备水平扩展的一致性设计。

## 总体结构

```text
Browser (Vue 3)
  | HTTPS: 页面与 /api/*       | WSS: /api/ws
  v                            v
Nginx ----------------------> Go Application ------> SQLite (/data/celery.db)
  |                              |
  | WSS: /rtc                    | HTTP: RoomService API
  v                              v
LiveKit Server <----------- internal Docker network
  ^
  | WebRTC: 7882/UDP, 7881/TCP, 3478/UDP, 30000-30099/UDP
Browser
```

Nginx 位于 Compose 外部，终止 HTTPS，并代理应用 HTTP、业务 WebSocket 与 LiveKit 信令。WebRTC 媒体不经过 Go 或 Nginx，而是由浏览器直接连接 LiveKit 暴露的媒体与 TURN 端口。

Go 应用提供嵌入式前端、认证与管理 API、文字聊天 WebSocket、LiveKit 访问令牌和房间管理。SQLite 只保存业务数据；在线状态、发送限流和 WebSocket 客户端集合保存在 Go 进程内存中，LiveKit 房间状态保存在媒体服务内存中。

## 技术组件

- 前端：Vue 3、TypeScript、Vite、Pinia、Lucide、TanStack Virtual、LiveKit Client SDK；当前没有引入 Vue Router。
- 后端：Go 1.26、标准 `net/http`、Gorilla WebSocket、LiveKit Server SDK。
- 数据库：`modernc.org/sqlite` pure Go 驱动；构建时使用 `CGO_ENABLED=0`。
- 密码：bcrypt 默认成本哈希，不保存明文密码。
- 会话与邀请码：随机不透明令牌；匹配时使用 SHA-256 哈希。新邀请码额外保存仅服务器管理员可读取的原码，旧记录不补造原码。
- 部署：Go 应用镜像、LiveKit 官方镜像和 `app-data` 持久卷组成 Docker Compose；Nginx 与证书由部署方管理。

## 前端结构

前端没有多页面路由，登录态决定根组件显示认证界面或主应用界面。三个 Pinia Store 分担主要状态：

- `app`：当前用户、全量成员资料、最近消息、频道设置、在线用户 ID 和业务 WebSocket；断线后每 2.5 秒尝试重连。
- `voice`：LiveKit Room、音频设备、静音/耳机静音、参与者状态和本地音量；LiveKit 初次连接最多重试 5 次，之后使用 SDK 自动重连。
- `sounds`：加入、退出和新消息提示音开关、音量、输出设备与 300ms 同类限流。

文字列表使用 TanStack Virtual 只渲染视口附近的不等高消息。历史记录以消息 ID 为游标每页读取 50 条，加载后修正滚动位置；前端内存最多保留管理员配置的消息保留数量。

音频处理分为三层：

- 本地麦克风轨道通过自定义 LiveKit Track Processor 接入 Web Audio GainNode，实现 0%-300% 麦克风增益。
- 远端用户音量与全局扬声器音量在客户端相乘，最终限制在 0%-300%，通过 LiveKit 参与者音量接口应用。
- 操作提示音由 Web Audio Oscillator/GainNode 本地合成，不加载外部音频文件；优先通过 `setSinkId` 路由到所选输出设备，不支持时使用系统默认设备。

麦克风增益、扬声器音量、按用户音量和提示音设置保存在浏览器 `localStorage`。账号资料、权限、禁言与频道设置由服务端持久化，不在不同浏览器间同步本地音频偏好。

## HTTP 与实时接口

Go 使用 `http.ServeMux` 的方法路由，接口按职责分组：

- 公开接口：健康检查、登录、邀请码注册。
- 已登录接口：退出、个人资料、启动数据、消息分页与发送、业务 WebSocket、LiveKit Token。
- 频道管理员接口：删除消息、更新频道设置、语音/文字禁言、临时封禁与解除。
- 服务器管理员接口：邀请码分页/创建/撤销/永久删除、预建账号、角色、密码重置和永久封禁。

`GET /api/bootstrap` 一次返回当前用户、成员资料、频道设置、最新 50 条消息、是否还有历史消息以及当前业务在线 ID。成员资料在预期不超过 10 人的产品边界内全量返回；消息和邀请码使用游标分页避免长期运行后全量传输。

业务 WebSocket 广播以下事件：在线状态、消息创建/删除、频道设置更新、用户资料或权限更新、会话撤销。服务端每 25 秒发送 Ping，读超时为 60 秒，单客户端发送队列容量为 64；队列已满时跳过该次广播，连接错误或会话撤销时关闭连接。

## LiveKit 边界

- 所有用户加入固定房间 `main`，identity 为 `user-{数字用户ID}`；显示名称和角色等资料写入参与者名称与属性。
- Go 签发有效期 15 分钟的加入令牌，只授予订阅和麦克风发布能力，禁止 LiveKit DataChannel 发布。
- 语音禁言会同时更新 SQLite 状态与 LiveKit 发布权限；临时封禁、永久封禁和管理员重置密码会撤销会话并从房间移除参与者。
- 显示名称更新会同步到在线 LiveKit 参与者。客户端角色排序优先使用业务 WebSocket 的最新用户资料。
- LiveKit 仅承担媒体和连接质量，不保存账号、消息、权限或提示音设置。

## 数据模型

SQLite 在应用启动时执行幂等建表和兼容迁移，主要实体为：

- `users`：登录名、显示名称、bcrypt 密码哈希、角色、语音/文字禁言和永久封禁状态。
- `sessions`：会话令牌 SHA-256 哈希、用户、30 天过期时间。
- `invites`：邀请码 SHA-256 哈希、可选原码、最大/已使用次数、过期与撤销时间。
- `messages`：用户、纯文本内容和发送时间。
- `settings`：单例频道码率与消息保留数量。
- `temporary_bans`：用户、截止时间、操作人和原因。
- `audit_logs`：重要管理操作的操作者、可选目标、动作、详情和时间；目前没有审计日志查询界面。

SQLite 启用 WAL、外键和 5 秒 busy timeout，并将连接池限制为单连接。消息写入与超额清理在同一事务完成；频道保留数量降低时也会立即事务性删除超额旧消息。

## 邀请码与消息分页

- 注册校验始终使用邀请码哈希，不使用可回查原码进行匹配。邀请码消费和用户创建位于同一事务。
- 邀请码管理列表每页最多 30 条，使用 Base64URL 编码的不透明游标。有效记录按到期时间升序，其余记录按创建时间降序。
- 邀请码响应在空列表时返回 `[]`；前端仍将非数组值兼容为空数组。撤销保持记录，永久删除移除记录，两者均写入审计日志。
- 消息列表接受 `before` 消息 ID 与最多 100 条的 `limit`，前端固定使用 50 条。查询多取一条判断 `hasMore`，返回结果按时间正序排列。
- 单条消息限制 1-2,000 个字符；进程内限流器允许每名用户 10 秒内发送 8 条。限流状态不写入 SQLite。

## 认证与安全边界

- 登录会话通过 30 天有效的 HttpOnly Cookie 传递，生产默认启用 Secure，SameSite 为 Lax；服务端只保存令牌哈希。
- WebSocket 必须携带有效会话，并校验 `Origin` 是否命中 `TRUSTED_ORIGINS`；未配置列表时仅接受同主机来源。
- JSON 请求体上限 64 KiB，拒绝未知字段和同一请求体中的额外 JSON 对象。
- HTTP 服务配置请求头、读写和空闲超时，并设置 CSP、Permissions-Policy、Referrer-Policy 与 `X-Content-Type-Options`。
- 日志使用 Go `slog` JSON 输出；应用不记录密码、会话原始令牌或邀请码哈希。

## 构建、发布与部署

Dockerfile 使用 Node 22 构建 Vue 产物，再使用 Go 1.26 将 `internal/webui/dist` 嵌入单个 Go 可执行文件，最终运行层为 Alpine 3.23 非 root 用户。应用镜像包含 `/api/health` 健康检查。

推送 `v*` Git 标签或手动运行 GitHub Actions 会使用 Buildx 构建 `linux/amd64` 镜像，并向 GHCR 同时推送版本标签和 `latest`。生产 `compose.yml` 只拉取预构建镜像；`compose.build.yml` 仅用于开发机现场构建。

生产 Compose 只持久化 `/data` 下的 SQLite 数据。LiveKit 配置由环境变量注入且房间状态是临时的，不挂载持久卷。应用和 LiveKit 信令分别仅绑定到宿主机 `127.0.0.1:8080` 与 `127.0.0.1:7880`，媒体和 TURN 端口直接对外开放。

## 稳定性与扩展限制

- 应用容器提供健康检查并配置 `restart: unless-stopped`；LiveKit 使用官方镜像和相同重启策略，Compose 只等待其进程启动，不执行媒体可用性探测。
- Go HTTP 服务支持 15 秒优雅关闭。业务 WebSocket 有心跳、读写超时和有界发送队列；LiveKit Client 开启自动重连。
- LiveKit 使用 Opus 单声道、DTX、RED、回声消除、噪声抑制与浏览器自动增益控制；管理员修改码率后客户端重新发布本地音轨。
- UDP receive buffer 通过仓库提供的 sysctl 配置提升；媒体优先使用 7882/UDP，7881/TCP 为回退，TURN 使用 3478/UDP 和 30000-30099/UDP 中继范围。
- 在线状态、WebSocket Hub、消息限流和 LiveKit 房间均为单实例内存状态。增加多个 Go 或 LiveKit 实例前，必须引入共享协调与状态层，不能直接复制当前 Compose。
- 当前备份范围只需覆盖 `app-data` SQLite 卷；证书、Nginx 和主机防火墙由部署方独立管理。
