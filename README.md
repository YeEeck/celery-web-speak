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

生产服务器只拉取预构建的应用镜像和 LiveKit 官方镜像，不进行 Go、Node 或原生模块编译。推荐在具有固定公网 IPv4 的 Linux amd64 主机上部署。

### 部署拓扑

```text
浏览器
  | HTTPS/WSS 443
  v
Nginx ─────── 127.0.0.1:8080  应用、API、文字 WebSocket
  └───────── 127.0.0.1:7880  LiveKit /rtc 信令

浏览器 ───── 公网 IP:7882/UDP  WebRTC 首选媒体路径
       ├─── 公网 IP:7881/TCP  ICE/TCP 回退
       └─── 公网 IP:3478/UDP  TURN
```

Nginx 只承载网页、业务 WebSocket 和 LiveKit 信令，不转发音频数据。音频通过 WebRTC 端口直接进入 LiveKit。

### 前置条件

- Linux amd64 主机，建议至少 2 核 CPU、4 GB 内存
- Docker Engine 和 Docker Compose v2
- 固定公网 IPv4，或能执行等价端口映射的公网入口
- 已配置的 HTTPS 证书；可以是域名证书或与公网 IP 匹配的 IP 证书
- 云安全组和主机防火墙都允许所需端口
- Nginx 能访问本机 `127.0.0.1:8080` 和 `127.0.0.1:7880`

### 1. 准备应用镜像

默认镜像地址是 `ghcr.io/yeck/celery-web-speak:latest`。正式部署建议使用明确版本，而不是长期跟随 `latest`：

```env
APP_IMAGE=ghcr.io/yeck/celery-web-speak:v0.1.0
```

仓库的 GitHub Actions 会在推送 `v*` 标签或手动运行工作流时构建 amd64 镜像。若 GHCR 包是私有的，先在服务器登录：

```bash
docker login ghcr.io
```

也可以在 CI 或开发机执行本地构建并推送到自己的镜像仓库。生产服务器不要使用 `compose.build.yml`，因为它会在服务器现场编译。

### 2. 生成 LiveKit 密钥

使用官方镜像生成一对 API Key 和 Secret：

```bash
docker run --rm livekit/livekit-server:v1.13.4 generate-keys
```

将输出分别填入 `.env`。这对密钥同时提供给应用和 LiveKit，不能泄露给浏览器，也不要提交到 Git：

```env
LIVEKIT_API_KEY=生成的Key
LIVEKIT_API_SECRET=生成的Secret
```

### 3. 配置公网地址

复制环境变量模板：

```bash
cp .env.example .env
chmod 600 .env
```

使用公网 IP 访问时，关键配置如下：

```env
LIVEKIT_NODE_IP=203.0.113.10
LIVEKIT_PUBLIC_URL=wss://203.0.113.10
TRUSTED_ORIGINS=https://203.0.113.10
```

使用域名访问时，只有信令和网页使用域名，媒体层仍建议明确填写公网 IPv4：

```env
LIVEKIT_NODE_IP=203.0.113.10
LIVEKIT_PUBLIC_URL=wss://voice.example.com
TRUSTED_ORIGINS=https://voice.example.com
```

三个变量的职责不同：

| 变量 | 含义 | 常见错误 |
| --- | --- | --- |
| `LIVEKIT_NODE_IP` | 写入 ICE 候选、供客户端直接连接媒体服务的 IP | 填写 `127.0.0.1`、Docker 网桥 IP 或客户端无法路由的内网 IP |
| `LIVEKIT_PUBLIC_URL` | 浏览器连接 LiveKit 信令的 WSS 地址 | HTTPS 页面使用 `ws://`，或错误添加内部端口 `:7880` |
| `TRUSTED_ORIGINS` | 允许建立业务 WebSocket 的网页来源 | 与浏览器地址的协议、主机或非标准端口不完全一致 |

如果服务器直接持有公网 IP，`LIVEKIT_NODE_IP` 就填写该 IP。如果服务器位于 NAT 后面，则填写 NAT 设备的公网 IP，并将媒体端口原样映射到服务器。若使用 FRP、端口穿透或另一台入口机，应填写客户端最终连接到的公网 IP，并保持外部和内部端口一致。

仅穿透 `7881/TCP` 也可能通过 ICE/TCP 建立通话，但它是回退路径。稳定部署仍应提供 `7882/UDP` 和 TURN UDP；否则在 TCP 拥塞或严格 NAT 下更容易出现延迟和断线。

### 4. 配置内核与防火墙

安装仓库提供的 UDP 缓冲区参数：

```bash
sudo install -m 0644 deploy/99-celery-web-speak.conf /etc/sysctl.d/99-celery-web-speak.conf
sudo sysctl --system
```

以 UFW 为例开放端口：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
sudo ufw allow 3478/udp
sudo ufw allow 30000:30099/udp
```

云服务器还需要在安全组中开放相同端口。不要向公网开放 `8080/TCP` 和 `7880/TCP`；Compose 已将它们限制绑定到 `127.0.0.1`。

| 端口 | 协议 | 用途 | 是否经过 Nginx |
| --- | --- | --- | --- |
| 80 | TCP | 跳转到 HTTPS | 是 |
| 443 | TCP | 网页、API、业务 WebSocket、LiveKit WSS 信令 | 是 |
| 7881 | TCP | WebRTC ICE/TCP 回退 | 否 |
| 7882 | UDP | WebRTC 首选媒体路径 | 否 |
| 3478 | UDP | TURN 入口 | 否 |
| 30000-30099 | UDP | TURN 中继分配 | 否 |

### 5. 接入 Nginx 和证书

将 [Nginx 示例](deploy/nginx.conf.example) 合并到现有配置，并至少替换以下内容：

- 两处 `server_name 203.0.113.10`
- `ssl_certificate` 和 `ssl_certificate_key` 路径
- 如果修改了 `APP_HTTP_PORT` 或 `LIVEKIT_HTTP_PORT`，同步修改两个 upstream 端口

LiveKit Client 2.x 当前使用 `/rtc/v1` 建立信令连接，因此 Nginx 必须代理整个 `/rtc` 前缀，不能只精确匹配 `/rtc`。示例已经使用 `location ^~ /rtc`。

检查并重新加载配置：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

证书申请、IP 证书短周期续期和私钥权限由部署方管理。应用容器不读取证书，也不会修改 Nginx。

### 6. 启动服务

先检查环境变量插值结果。该命令不会启动容器：

```bash
docker compose config --quiet
```

然后拉取并启动：

```bash
docker compose pull
docker compose up -d
```

检查容器和本机健康端点：

```bash
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
docker compose logs --tail=100 app livekit
```

预期健康接口返回：

```json
{"status":"ok"}
```

再从公网检查 Nginx 和证书：

```bash
curl -fsS https://voice.example.com/api/health
```

LiveKit 启动日志应包含配置的 `nodeIP`、`rtc.portTCP: 7881`、`rtc.portUDP: 7882` 和 TURN 启动信息，不应持续出现 UDP receive buffer 过小的警告。

### 7. 首次登录

首次启动且数据库中没有用户时，应用使用以下变量创建第一名服务器管理员：

```env
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=一段足够长的随机密码
```

确认可以登录后，可将 `.env` 中的密码清空并刷新应用容器环境：

```env
BOOTSTRAP_ADMIN_PASSWORD=
```

```bash
docker compose up -d app
```

数据库已有用户时，启动变量不会覆盖管理员密码。后续账号应通过管理控制台预先创建，或生成带次数和有效期的邀请码。

### 常见故障

| 现象 | 主要检查项 |
| --- | --- |
| 网页正常，但浏览器提示 `could not establish pc connection` | 确认 `LIVEKIT_NODE_IP` 是客户端可达 IP；检查 `7882/UDP` 和 `7881/TCP` 的安全组、NAT 与端口穿透 |
| WSS 连接后反复 `signalReconnecting` | 检查 Nginx 是否代理 `/rtc/v1`、Upgrade/Connection 头以及 3600 秒超时 |
| 只开放 `7881/TCP` 后能够通话 | 当前正在使用 ICE/TCP 回退；继续开放 `7882/UDP` 和 TURN UDP 以获得更稳定的媒体路径 |
| `/rtc/v1` 返回 404 或应用首页 | Nginx 仍在精确匹配 `/rtc`；改为 `location ^~ /rtc` |
| 登录成功后立即回到登录页 | 生产必须通过 HTTPS 访问；检查 `COOKIE_SECURE=true` 和 `TRUSTED_ORIGINS` 是否匹配实际来源 |
| 浏览器无法访问麦克风 | 使用有效 HTTPS，检查浏览器站点权限；普通公网 HTTP 不属于安全上下文 |
| 同一账号的一个页面加入后，另一个页面断开 | LiveKit 参与者 identity 与用户绑定；同一账号不要同时加入多个语音页面 |
| LiveKit 提示 UDP receive buffer 过小 | 安装 `deploy/99-celery-web-speak.conf` 并执行 `sysctl --system` |
| `docker compose pull` 无权限 | 登录对应镜像仓库，或将 GHCR 包改为公开 |

诊断媒体连接时，先查看服务器日志：

```bash
docker compose logs --since=10m livekit
```

成功连接后，日志中的 participant 应出现已选中的 ICE candidate 和明确的 connection type。只有信令会话、没有媒体候选通常意味着公网 IP 或媒体端口不可达。

### 更新与回滚

更新前先备份数据，然后修改 `.env` 中固定的镜像版本：

```env
APP_IMAGE=ghcr.io/yeck/celery-web-speak:v0.2.0
```

执行滚动替换：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

如需回滚，将 `APP_IMAGE` 改回上一个已验证版本，再次执行 `docker compose up -d`。数据库迁移在应用启动时自动执行；回滚跨越数据库结构变更前应先恢复对应版本的备份。

### SQLite 备份与恢复

默认 Compose 项目名为 `celery-web-speak`，SQLite 位于 Docker 卷 `celery-web-speak_app-data`。使用 `docker compose -p` 修改项目名后，卷名也会变化，可先执行 `docker volume ls` 确认。

创建一致备份时短暂停止应用写入，LiveKit 可以继续运行：

```bash
mkdir -p backups
docker compose stop app
docker run --rm \
  -v celery-web-speak_app-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine:3.23 \
  tar czf "/backup/celery-$(date +%Y%m%d-%H%M%S).tar.gz" -C /data .
docker compose start app
```

恢复前必须再次备份当前数据。确认备份文件名后，停止应用并将归档恢复到数据卷：

```bash
docker compose stop app
docker run --rm \
  -v celery-web-speak_app-data:/data \
  -v "$PWD/backups":/backup:ro \
  alpine:3.23 \
  sh -c 'rm -rf /data/* && tar xzf /backup/celery-YYYYMMDD-HHMMSS.tar.gz -C /data'
docker compose start app
```

恢复属于破坏性操作，必须在确认卷名和归档内容后执行。生产环境应将备份复制到服务器之外，并定期验证归档能够解压。

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
