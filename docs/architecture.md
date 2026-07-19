# Celery Web Speak 技术架构

## 总体结构

```text
Browser (Vue 3)
  | HTTPS / WSS                 | WebRTC
  v                             v
Nginx --------------------> LiveKit Server
  |
  v
Go Application
  |
  v
SQLite
```

Go 应用提供静态前端、认证与管理 API、聊天 WebSocket、LiveKit 访问令牌和房间管理。LiveKit 使用官方预构建镜像承担 SFU 与 UDP TURN。SQLite 只保存业务数据，LiveKit 房间状态保持在媒体服务内。

## 组件选择

- 前端：Vue 3、TypeScript、Vite、Pinia、Vue Router、LiveKit Client SDK
- 后端：Go、标准 `net/http`、SQLite、WebSocket、LiveKit Server SDK
- 数据库驱动：pure Go SQLite 驱动，避免 CGO 和服务器原生编译依赖
- 密码：Argon2id 或 bcrypt 哈希，不保存明文密码
- 会话：随机不透明令牌，服务端保存哈希，使用 HttpOnly/Secure/SameSite Cookie
- 部署：应用镜像、LiveKit 官方镜像和持久卷组成 Docker Compose；Nginx 位于 Compose 外部

## 数据模型

主要实体：

- `users`：登录名、显示名称、密码哈希、角色、禁言和封禁状态
- `sessions`：会话令牌哈希、用户、30 天过期时间
- `invites`：邀请码哈希、最大使用次数、已使用次数、过期时间和撤销状态
- `messages`：用户、纯文本内容和发送时间
- `settings`：频道码率、消息保留数量等单频道设置
- `temporary_bans`：用户、截止时间、操作人和原因
- `audit_logs`：重要管理操作的操作者、目标和时间

## 实时边界

- 语音、发言者和网络质量由 LiveKit SDK 提供。
- 文字消息使用 Go 应用的 WebSocket，并在写入 SQLite 后广播。
- 管理操作由 HTTP API 持久化，再通过 WebSocket 通知在线客户端。
- LiveKit Token 仅由已登录且未被封禁的用户向 Go 应用获取。
- 语音禁言状态由业务数据库判定，并通过 LiveKit RoomService 对在线音轨执行静音。

## 部署边界

- Nginx 终止 HTTPS，并代理应用 HTTP/WebSocket 与 LiveKit WebSocket。
- LiveKit 媒体 UDP 和 TURN UDP 端口直接通过防火墙开放。
- 应用不申请、读取或续期 TLS 证书。
- 生产 Compose 引用 CI 发布的 amd64 预构建镜像；另提供仅用于开发机的本地构建方式。
- SQLite、应用数据和 LiveKit 配置挂载到明确的持久化路径。

## 稳定性策略

- 限制请求体、聊天长度和消息发送频率。
- SQLite 使用 WAL、busy timeout 和单实例写入。
- WebSocket 使用心跳、写超时和有界发送队列，慢客户端会被断开。
- 客户端对业务 WebSocket 和 LiveKit 连接显示独立状态，并采用有上限的退避重连。
- 所有容器提供健康检查，服务端输出结构化日志。
- 音质变更通过设置事件下发，客户端短暂重新发布本地音轨。
