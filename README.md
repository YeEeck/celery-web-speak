# Celery Web Speak

Celery Web Speak 是一个面向小型固定群体的公开多频道在线语音与文字聊天工具。文字频道与语音频道彼此独立，前端使用 Vue 3，业务服务使用 Go 与 SQLite，语音通过 LiveKit SFU 和 UDP TURN 集中转发。

当前稳定版本为 `v0.3.4`，生产部署建议固定使用明确版本的预构建镜像。

## 功能

- 中文 Discord 风格桌面与 Android Chrome 界面
- 公开文字与语音频道创建、改名、删除，以及分频道设置和实时状态
- 可调 32-128 kbps Opus 单声道语音
- 静音、耳机静音、输入/输出设备选择和网络质量提示
- 麦克风、扬声器及按用户独立麦克风和背景音音量支持 0%-300% 增益
- 语音成员按角色与本次加入时间稳定排序，并显示当前说话人
- 同一账号跨标签页和设备只保留一个语音连接，切换语音频道时自动断开旧连接
- 加入语音、退出语音和新文字消息操作提示音
- 分频道最近 N 条纯文字消息、游标分页、虚拟列表、跨设备已读和实时在线状态
- 业务连接重建后自动校准频道、成员、未读与当前消息，语音房间状态定期自动校准
- 邀请码注册、预建账号和 30 天登录会话
- 邀请码状态、分页、复制、撤销和永久删除管理
- 服务器管理员、频道管理员、语音/文字禁言和临时/永久封禁
- 服务器管理员可不可恢复地删除账号；历史消息匿名保留，原登录名可重新使用

完整范围与权限矩阵见 [产品规格](docs/product-spec.md)，服务关系见 [技术架构](docs/architecture.md)。

## 客户端音频设置

用户设置面板分为四个页签：账号、音频、音效与主题。音频、音效与主题设置即时生效并保存在当前浏览器的 `localStorage`，不会写入服务器或同步到其他浏览器。账号修改（显示名称、密码）使用各自独立的保存按钮。

### 音频

- 麦克风与扬声器选择仅在加入语音频道后可用。麦克风增益与扬声器音量支持 0%-300% 调节，始终可配置。
- 回声抑制与降噪开关可随时调整，更改在下次加入语音频道时生效。自动增益控制保持开启，不暴露开关。

### 主题

- 主题模式可选跟随系统、亮色或暗色。强调色提供靛蓝、绿色、玫瑰与琥珀四种预设。主题与强调色仅保存在当前浏览器。

### 音效

操作提示音默认开启，默认音量为 60%。用户可以关闭全部提示音，也可以分别控制加入语音、退出语音和新文字消息三类提示。每个事件可以从预置音效库中选择不同的提示音。

- 自己成功加入语音频道时播放一次加入音效，自己退出时不播放退出音效。
- 其他用户在初始成员同步完成后加入或退出时播放对应音效；初次进入频道和网络重连不会为已有成员逐个提示。
- 当前正在查看的文字频道收到其他用户消息时播放消息音效，自己发送的消息不提示；未进入的文字频道只增加未读数量。
- 耳机静音会同时静音语音和操作提示音。提示音优先跟随已选择的输出设备，不支持指定输出设备的浏览器会使用系统默认设备。
- 同类提示音在 300ms 内最多播放一次，避免批量上下线或连续消息形成叠音。

浏览器会限制未经用户交互的音频自动播放。Celery Web Speak 会在首次点击或按键时启用提示音；此前无法播放的事件会直接跳过，不会延迟补播。Android 切到后台后的播放能力由 Chrome 和系统策略决定。

## 生产部署

生产服务器只拉取预构建的应用镜像、LiveKit 官方镜像和 Caddy 官方镜像，不进行 Go、Node 或原生模块编译。推荐在具有固定公网 IPv4 的 Linux amd64 主机上部署。默认 Gateway 路径直接为公网 IP 申请浏览器信任的 HTTPS 证书，不要求准备域名、Nginx 或外部证书工具。

### 部署拓扑

```text
浏览器
  | HTTPS/WSS（HTTPS_PORT，默认 443）
  v
Caddy Gateway ───── app:8080      页面、API、文字 WebSocket
  └─────────────── livekit:7880  LiveKit /rtc/* 信令

浏览器 ───── 公网 IP:LIVEKIT_UDP_PORT  WebRTC 首选媒体路径
       ├─── 公网 IP:LIVEKIT_TCP_PORT  ICE/TCP 回退
       └─── 公网 IP:LIVEKIT_TURN_PORT 与中继端口范围  TURN
```

Caddy 只承载网页、业务 WebSocket 和 LiveKit 信令，不转发音频数据。音频通过 WebRTC 端口直接进入 LiveKit。应用和 LiveKit 的 HTTP 端口仍仅绑定宿主机 `127.0.0.1`，用于本机诊断。

### 前置条件

- Linux amd64 主机，建议至少 2 核 CPU、4 GB 内存
- Docker Engine 和 Docker Compose v2
- 固定公网 IPv4；位于 NAT 后面时，公网入口必须将配置的所有端口原样映射到主机
- 80/TCP 能从公网访问，供 Let's Encrypt HTTP-01 验证和后续续期使用
- 云安全组和主机防火墙允许 Gateway、WebRTC 与 TURN 所需端口
- 宿主机的 80/TCP 和 `HTTPS_PORT` 未被其他服务占用

### 1. 准备应用镜像

默认镜像地址是 `ghcr.io/yeck/celery-web-speak:latest`。正式部署建议使用明确版本，而不是长期跟随 `latest`：

```env
APP_IMAGE=ghcr.io/yeck/celery-web-speak:v0.3.4
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

默认 Gateway 部署至少填写以下配置：

```env
PUBLIC_IP=203.0.113.10

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=一段足够长的随机密码

LIVEKIT_API_KEY=生成的Key
LIVEKIT_API_SECRET=生成的Secret

APP_IMAGE=ghcr.io/yeck/celery-web-speak:v0.3.4
COMPOSE_PROFILES=gateway
HTTPS_PORT=443
```

`PUBLIC_IP` 同时用于 Caddy IP 证书、浏览器访问地址、应用允许的 Origin，以及 LiveKit 向浏览器发布的 ICE/TURN 地址。Compose 自动推导以下配置，不要再在 `.env` 中填写旧变量：

| 派生配置 | Compose 中的值 |
| --- | --- |
| LiveKit 节点地址 | `${PUBLIC_IP}` |
| `LIVEKIT_PUBLIC_URL` | `wss://${PUBLIC_IP}:${HTTPS_PORT}` |
| `TRUSTED_ORIGINS` | `https://${PUBLIC_IP}:${HTTPS_PORT}` |

`HTTPS_PORT` 默认为 443。设置为 9443 等非标准端口时，必须开放该 TCP 端口，并使用 `https://203.0.113.10:9443` 访问；80 端口仍然必须开放，Caddy 会将 HTTP 请求重定向到带端口的 HTTPS 地址。

媒体和调试端口可按需覆盖：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LIVEKIT_TCP_PORT` | `7881` | ICE/TCP 回退 |
| `LIVEKIT_UDP_PORT` | `7882` | WebRTC 首选媒体路径 |
| `LIVEKIT_TURN_PORT` | `3478` | TURN UDP 入口 |
| `LIVEKIT_RELAY_START` / `LIVEKIT_RELAY_END` | `30000` / `30099` | TURN UDP 中继范围 |
| `APP_HTTP_PORT` | `8080` | 应用在宿主机的 localhost 调试端口 |
| `LIVEKIT_HTTP_PORT` | `7880` | LiveKit 在宿主机的 localhost 调试端口 |

如果服务器位于 NAT 后面，`PUBLIC_IP` 填写客户端最终连接的公网 IP，并将 HTTPS、媒体和 TURN 端口按相同外部端口映射到服务器。仅映射 `LIVEKIT_TCP_PORT` 可能通过 ICE/TCP 建立通话，但稳定部署仍应提供 UDP 媒体和 TURN 端口。

其他可选行为变量包括 `COOKIE_SECURE=true`、`SESSION_COOKIE_NAME=celery_session`、`VOICE_RECONCILE_INTERVAL=15s` 和 `TZ=Asia/Shanghai`。生产 Gateway 必须保持 `COOKIE_SECURE=true`；语音状态校准间隔设为 `0` 会禁用后台兜底校准。

默认 Compose 的公开 URL 与可信 Origin 固定由 `PUBLIC_IP` 和 `HTTPS_PORT` 推导。需要域名、多站点或不同内外端口映射时，应禁用 Gateway，并通过 Compose override 同时覆盖应用公开 URL、可信 Origin 和 LiveKit 节点配置；`deploy/nginx.conf.example` 仅作为自管反向代理参考。

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

如果 `HTTPS_PORT` 不是 443，将上面的 443/TCP 替换为实际端口。若修改任意 LiveKit 端口或中继范围，防火墙和云安全组必须使用相同的新值。不要向公网开放 `APP_HTTP_PORT` 和 `LIVEKIT_HTTP_PORT`；Compose 已将它们限制绑定到 `127.0.0.1`。

| 默认端口 | 协议 | 用途 | 暴露服务 |
| --- | --- | --- | --- |
| 80 | TCP | ACME HTTP-01、跳转到 HTTPS | Gateway |
| 443 | TCP | 网页、API、业务 WebSocket、LiveKit WSS 信令 | Gateway |
| 7881 | TCP | WebRTC ICE/TCP 回退 | LiveKit |
| 7882 | UDP | WebRTC 首选媒体路径 | LiveKit |
| 3478 | UDP | TURN 入口 | LiveKit |
| 30000-30099 | UDP | TURN 中继分配 | LiveKit |

### 5. 启动 Gateway 与服务

先检查 Compose 环境变量插值结果。该命令不会启动容器：

```bash
docker compose config --quiet
```

拉取并启动全部服务：

```bash
docker compose pull
docker compose up -d
```

`.env` 中的 `COMPOSE_PROFILES=gateway` 会自动启用 Gateway profile。Caddy 监听 80 和 `HTTPS_PORT`，首次启动时向 Let's Encrypt 申请 `shortlived` 公网 IP 证书，之后自动续期。ACME 账号、证书和私钥保存在 `caddy-data` 卷中；不要使用 `docker compose down -v` 作为常规更新命令。

Caddyfile 同时处理几个容易忽略的 IP 部署细节：

- `default_sni` 为不发送 SNI 的裸 IP 浏览器连接选择 IP 证书。
- HTTP 跳转显式保留非标准 `HTTPS_PORT`。
- `/rtc` 和 `/rtc/*` 都代理至 LiveKit，覆盖实际信令地址 `/rtc/v1`。
- WebSocket 升级由 Caddy 自动处理。

禁用 Gateway 时，删除或注释 `.env` 中的 `COMPOSE_PROFILES=gateway`，然后自行提供 HTTPS 入口。[Nginx 示例](deploy/nginx.conf.example) 可作为高级参考，但域名或不同外部地址场景还需要 Compose override 覆盖默认派生的公开 URL 与 Origin。

### 6. 验证部署

检查容器、本机应用和三项服务日志：

```bash
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
docker compose logs --tail=100 gateway app livekit
```

修改过 `APP_HTTP_PORT` 时，将健康检查中的 8080 替换为实际端口。

预期健康接口返回：

```json
{"status":"ok"}
```

再从公网检查 HTTP 跳转、TLS 证书和应用健康接口；非标准端口需要在 URL 中显式填写：

```bash
curl -I http://203.0.113.10/
curl -v https://203.0.113.10/api/health
```

第一条命令的 `Location` 应包含实际 `HTTPS_PORT`。第二条命令应完成可信证书校验并返回 `{"status":"ok"}`；正式验证不要加 `-k`，否则无法发现证书信任问题。LiveKit 日志应包含配置的 `nodeIP`、TCP/UDP 媒体端口和 TURN 信息，不应持续出现 UDP receive buffer 过小的警告。

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
| 浏览器提示 `ERR_SSL_PROTOCOL_ERROR` 或 curl 收到 TLS `internal error` | 确认 Gateway 已使用当前 `deploy/Caddyfile` 重建；检查 Caddy 日志中是否成功签发 IP 证书，并确认配置保留 `default_sni {$PUBLIC_IP}` |
| 证书无法签发或续期 | 确认 `PUBLIC_IP` 指向本机公网入口、80/TCP 可从公网访问，并查看 `docker compose logs gateway` 中的 ACME 错误 |
| HTTP 跳转后丢失非标准 HTTPS 端口 | 确认 Caddyfile 使用显式 HTTP `redir`，并重建 Gateway 容器使配置生效 |
| 网页正常，但浏览器提示 `could not establish pc connection` | 确认 `PUBLIC_IP` 是客户端可达地址；检查配置的 LiveKit TCP/UDP 端口、安全组、NAT 与端口映射 |
| WSS 连接后反复 `signalReconnecting` | 检查 Gateway 日志，并确认当前 Caddyfile 将 `/rtc` 和 `/rtc/*` 代理到 `livekit:7880` |
| 只开放默认 `7881/TCP` 后能够通话 | 当前正在使用 ICE/TCP 回退；继续开放配置的 UDP 媒体端口和 TURN UDP 以获得更稳定的媒体路径 |
| `/rtc/v1` 返回 404 或应用首页 | Gateway 未加载当前 Caddyfile，或自管反代没有代理整个 `/rtc` 前缀 |
| 登录成功后立即回到登录页 | 生产必须通过 HTTPS 访问；确认浏览器 URL 与由 `PUBLIC_IP`、`HTTPS_PORT` 推导的可信 Origin 完全一致 |
| 浏览器无法访问麦克风 | 使用有效 HTTPS，检查浏览器站点权限；普通公网 HTTP 不属于安全上下文 |
| 同一账号加入新语音频道后旧连接断开 | 服务端在所有 LiveKit 房间间强制每个账号只有一个语音连接，这是预期行为 |
| LiveKit 提示 UDP receive buffer 过小 | 安装 `deploy/99-celery-web-speak.conf` 并执行 `sysctl --system` |
| `docker compose pull` 无权限 | 登录对应镜像仓库，或将 GHCR 包改为公开 |

诊断媒体连接时，先查看服务器日志：

```bash
docker compose logs --since=10m livekit
```

成功连接后，日志中的 participant 应出现已选中的 ICE candidate 和明确的 connection type。只有信令会话、没有媒体候选通常意味着公网 IP 或媒体端口不可达。

### 更新与回滚

更新前先备份数据，然后拉取仓库变更并修改 `.env` 中固定的镜像版本：

```env
APP_IMAGE=ghcr.io/yeck/celery-web-speak:v0.3.4
```

从 `v0.1.x` 升级到 `v0.2.0` 时，应用会将数据库迁移到公开多频道结构。账号、会话、邀请码、封禁和审计记录会保留；旧单频道文字消息与单例频道设置无法映射到新的分频道模型，会被移除，并创建默认的“文字聊天”和“语音频道”。升级前必须完成 SQLite 备份。

执行滚动替换：

```bash
git pull --ff-only
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose up -d --force-recreate gateway
docker compose ps
```

Gateway 通过只读 bind mount 读取 `deploy/Caddyfile`，文件内容变化不会改变 Compose 容器定义，因此更新 Caddyfile 后应显式重建 Gateway。不要删除 `caddy-data` 卷。如需回滚，将 `APP_IMAGE` 改回上一个已验证版本，再次执行 `docker compose up -d`；若同时回滚 Caddyfile，也要再次强制重建 Gateway。数据库迁移在应用启动时自动执行；从 `v0.2.0` 回滚到 `v0.1.x` 时必须同时恢复升级前的数据库备份，不能直接使用已迁移的数据卷。

### SQLite 与 Caddy 数据备份

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

`caddy-data` 保存 ACME 账号、证书和私钥。它丢失后 Caddy 可以重新签发证书，但频繁重新签发可能触发 Let's Encrypt 速率限制。可在短暂停止 Gateway 后单独备份：

```bash
docker compose stop gateway
docker run --rm \
  -v celery-web-speak_caddy-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine:3.23 \
  tar czf "/backup/caddy-$(date +%Y%m%d-%H%M%S).tar.gz" -C /data .
docker compose start gateway
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

SQLite 恢复属于破坏性操作，必须在确认卷名和归档内容后执行。恢复 `caddy-data` 时也必须先停止 Gateway，并保持原文件权限。生产环境应将两类备份复制到服务器之外，并定期验证归档能够解压。

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
在完整 Compose 环境中设置 `E2E_LIVEKIT=1`，还会创建两个临时账号，验证双方订阅远端音频轨道、成员稳定排序、麦克风与耳机静音状态同步、按用户独立麦克风和背景音音量以及加入和退出提示音。
