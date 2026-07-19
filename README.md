# Celery Web Speak

Celery Web Speak 是一个面向小型固定群体的单频道在线语音与文字聊天工具。前端使用 Vue 3，业务服务使用 Go 与 SQLite，语音通过 LiveKit SFU 和 UDP TURN 集中转发。

## 功能

- 中文 Discord 风格桌面与 Android Chrome 界面
- 可调 32-128 kbps Opus 单声道语音
- 静音、耳机静音、音频设备选择、按用户音量和网络质量提示
- 最近 N 条纯文字消息与实时在线状态
- 邀请码注册、预建账号和 30 天登录会话
- 服务器管理员、频道管理员、语音/文字禁言和临时/永久封禁

完整范围与权限矩阵见 [产品规格](docs/product-spec.md)，服务关系见 [技术架构](docs/architecture.md)。

## 生产部署

服务器只拉取预构建镜像，不进行 Go、Node 或原生模块编译：

```bash
cp .env.example .env
# 修改 .env 中所有 replace 与示例 IP
docker compose pull
docker compose up -d
```

将 [Nginx 示例](deploy/nginx.conf.example) 合并到现有配置，并替换 IP 与证书路径。Nginx 代理应用和 `/rtc` 信令；以下端口直接通过主机防火墙开放：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 7881 | TCP | WebRTC ICE/TCP 回退 |
| 7882 | UDP | WebRTC 媒体 |
| 3478 | UDP | TURN |
| 30000-30099 | UDP | TURN 中继分配 |

应用的 `8080` 和 LiveKit 信令的 `7880` 只绑定 `127.0.0.1`，不应直接暴露公网。证书申请与续期不属于应用部署流程。

LiveKit 启动时会检查主机 UDP socket 缓冲区。可将 [内核参数示例](deploy/99-celery-web-speak.conf) 安装到 `/etc/sysctl.d/` 并由运维执行 `sysctl --system`，避免弱网或突发流量下因缓冲区过小丢包。

首次启动从 `.env` 创建服务器管理员。账号创建成功后可以清空 `BOOTSTRAP_ADMIN_PASSWORD`；后续启动不会用它覆盖数据库密码。

生产更新：

```bash
docker compose pull
docker compose up -d
```

SQLite 数据位于 `app-data` Docker 卷。备份前建议短暂停止 `app` 容器，或使用 SQLite 在线备份工具复制一致快照。

## 本地开发

后端：

```bash
export COOKIE_SECURE=false
export BOOTSTRAP_ADMIN_USERNAME=admin
export BOOTSTRAP_ADMIN_PASSWORD=admin-password-123
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=dev-secret-must-be-at-least-thirty-two-characters
export LIVEKIT_PUBLIC_URL=ws://127.0.0.1:7880
go run ./cmd/server
```

前端开发服务器：

```bash
cd web
npm ci
npm run dev
```

使用本机资源构建完整 Compose：

```bash
cp .env.example .env
docker compose -f compose.yml -f compose.build.yml up --build
```

## 检查

```bash
go test ./...
cd web
npm ci
npm run typecheck
npm run build
npm run test:e2e
```

端到端测试默认连接 `http://127.0.0.1:8080`，可通过 `E2E_BASE_URL`、`E2E_USERNAME` 和 `E2E_PASSWORD` 覆盖。
在完整 Compose 环境中设置 `E2E_LIVEKIT=1`，还会创建两个临时账号并验证双方已订阅远端音频轨道。
