# 生产部署指南

本文档是 Celery Web Speak 的完整生产部署与运维手册。只需要在具有固定公网 IPv4 的服务器上完成默认 Caddy Gateway 部署时，可直接按照 [README 标准流程](../README.md#生产部署) 操作；域名、自管反向代理、NAT、自定义端口、故障排查、更新回滚和数据备份等场景以本文档为准。

当前稳定版本为 `v0.3.10`。生产环境应让仓库标签、部署文件和 `APP_IMAGE` 使用同一版本，不要长期跟随 `latest`。

## 部署拓扑

默认部署由 Caddy、应用和 LiveKit 三个容器组成：

```text
浏览器
  | HTTPS/WSS（HTTPS_PORT，默认 443）
  v
Caddy Gateway ───── app:8080      页面、API、文字 WebSocket
  └─────────────── livekit:7880  LiveKit /rtc/* 信令

浏览器 ───── 公网 IP:LIVEKIT_UDP_PORT  WebRTC 首选媒体路径
       └─── 公网 IP:LIVEKIT_TCP_PORT  ICE/TCP 回退
```

Caddy 只承载网页、业务 WebSocket 和 LiveKit 信令，不转发音频数据。音频通过 WebRTC 端口直接进入 LiveKit。应用和 LiveKit 的 HTTP 端口仅绑定宿主机 `127.0.0.1`，用于本机诊断或宿主机上的自管反向代理。

## 标准公网 IP 部署

标准流程适用于直接拥有固定公网 IPv4 的 Linux amd64 主机，由仓库提供的 Caddy Gateway 自动申请和续期公网 IP HTTPS 证书。

### 前置条件

- Linux amd64 主机，建议至少 2 核 CPU、4 GB 内存
- Docker Engine 和 Docker Compose v2
- 固定公网 IPv4 直接绑定到主机
- 80/TCP 可从公网访问，供 Let's Encrypt HTTP-01 验证和续期
- 宿主机的 80/TCP 和 443/TCP 未被其他服务占用
- 云安全组与主机防火墙允许本文列出的 HTTPS 和 WebRTC 端口

位于 NAT、家庭路由器或端口映射之后的服务器需要额外配置，参见[在 NAT 后部署](#在-nat-后部署)。

### 1. 获取固定版本的部署文件

```bash
git clone --branch v0.3.10 --depth 1 https://github.com/YeEeck/celery-web-speak.git
cd celery-web-speak
```

生产服务器只拉取预构建的应用镜像、LiveKit 官方镜像和 Caddy 官方镜像，不进行 Go、Node 或原生模块编译。不要在生产服务器使用 `compose.build.yml`。

### 2. 生成 LiveKit 密钥

使用 Compose 中相同版本的 LiveKit 官方镜像生成一对 API Key 和 Secret：

```bash
docker run --rm livekit/livekit-server:v1.13.4 generate-keys
```

这对密钥同时提供给应用和 LiveKit。不要泄露给浏览器，也不要提交到 Git。

### 3. 配置环境变量

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，至少填写以下内容。将示例 IP、管理员密码和 LiveKit 密钥替换为实际值：

```env
PUBLIC_IP=203.0.113.10

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=一段足够长的随机密码

LIVEKIT_API_KEY=生成的Key
LIVEKIT_API_SECRET=生成的Secret

APP_IMAGE=ghcr.io/yeeeck/celery-web-speak:v0.3.10
COMPOSE_PROFILES=gateway
HTTPS_PORT=443
```

### 4. 配置内核与网络入口

安装仓库提供的 UDP 缓冲区参数：

```bash
sudo install -m 0644 deploy/99-celery-web-speak.conf /etc/sysctl.d/99-celery-web-speak.conf
sudo sysctl --system
```

在云安全组和主机防火墙中开放以下端口：

| 默认端口 | 协议 | 用途 | 暴露服务 |
| --- | --- | --- | --- |
| 80 | TCP | ACME HTTP-01、跳转到 HTTPS | Gateway |
| 443 | TCP | 网页、API、业务 WebSocket、LiveKit WSS 信令 | Gateway |
| 7881 | TCP | WebRTC ICE/TCP 回退 | LiveKit |
| 7882 | UDP | WebRTC 首选媒体路径 | LiveKit |

当前部署不启用 TURN。不要向公网开放 `APP_HTTP_PORT` 和 `LIVEKIT_HTTP_PORT`；Compose 已将它们限制绑定到 `127.0.0.1`。

### 5. 启动服务

先检查 Compose 环境变量插值结果，再拉取并启动服务：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
```

首次启动时 Caddy 会向 Let's Encrypt 申请 `shortlived` 公网 IP 证书，通常需要数秒。ACME 账号、证书和私钥保存在 `caddy-data` 卷中；不要使用 `docker compose down -v` 作为常规停止或更新命令。

### 6. 验证部署

检查容器、本机应用健康接口和服务日志：

```bash
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
docker compose logs --tail=100 gateway app livekit
```

健康接口应返回：

```json
{"status":"ok"}
```

再从服务器之外检查公网 HTTPS。正式验证不要使用 `curl -k`，否则无法发现证书信任问题：

```bash
curl -I http://203.0.113.10/
curl -fsS https://203.0.113.10/api/health
```

第一条命令应跳转到 HTTPS，第二条命令应通过可信证书校验并返回健康状态。

### 7. 首次登录与语音验收

使用 `.env` 中的 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD` 登录。通过管理控制台创建第二个账号或邀请码，然后用两个不同账号加入同一语音频道，确认双方能够听到声音。这个测试同时验证 Gateway 信令和公网 WebRTC 端口，不应只验证网页能够打开。

确认管理员可以登录后，清空 `.env` 中的初始密码并刷新应用容器环境：

```env
BOOTSTRAP_ADMIN_PASSWORD=
```

```bash
docker compose up -d app
```

数据库已有用户时，启动变量不会覆盖管理员密码。后续账号应通过管理控制台预先创建，或使用带次数和有效期的邀请码。

## 配置参考

### 公网地址与派生配置

`PUBLIC_IP` 同时用于 Caddy IP 证书、浏览器访问地址、应用允许的 Origin，以及 LiveKit 向浏览器发布的 ICE 地址。

默认 Gateway 会基于 `PUBLIC_IP` 和 `HTTPS_PORT` 设置以下公开地址：

| 配置 | 默认值 | 可覆盖变量 |
| --- | --- | --- |
| LiveKit 节点地址 | `${PUBLIC_IP}` | 无 |
| LiveKit 浏览器信令地址 | `wss://${PUBLIC_IP}:${HTTPS_PORT}` | `LIVEKIT_PUBLIC_URL` |
| 应用可信 Origin | `https://${PUBLIC_IP}`（默认 443） | `TRUSTED_ORIGINS` |

使用非标准 HTTPS 端口、自有域名或外部 Gateway 时，必须显式设置与浏览器地址完全一致的 `TRUSTED_ORIGINS`。多个 Origin 使用逗号分隔。

### 端口变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HTTPS_PORT` | `443` | Gateway HTTPS |
| `LIVEKIT_TCP_PORT` | `7881` | ICE/TCP 回退 |
| `LIVEKIT_UDP_PORT` | `7882` | WebRTC 首选媒体路径 |
| `APP_HTTP_PORT` | `8080` | 应用在宿主机的 localhost 诊断端口 |
| `LIVEKIT_HTTP_PORT` | `7880` | LiveKit 在宿主机的 localhost 诊断端口 |

修改任意公开端口后，Compose、云安全组、主机防火墙和 NAT 端口映射必须使用相同的新值。

### 应用行为变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COOKIE_SECURE` | `true` | 生产 HTTPS 部署必须保持为 `true` |
| `SESSION_COOKIE_NAME` | `celery_session` | 登录会话 Cookie 名称 |
| `VOICE_RECONCILE_INTERVAL` | `15s` | 语音占用状态后台校准间隔，`0` 表示禁用 |
| `TZ` | `Asia/Shanghai` | 应用容器时区 |

### Caddy Gateway 行为

默认 Gateway 使用官方 `caddy:2.11` 镜像和仓库中的 `deploy/Caddyfile`：

- `default_sni` 为不发送 SNI 的裸 IP 浏览器连接选择 IP 证书。
- 显式 HTTP 跳转会保留非标准 `HTTPS_PORT`。
- `/rtc` 和 `/rtc/*` 都代理到 LiveKit，覆盖实际信令地址 `/rtc/v1`。
- 页面、API 和业务 WebSocket 代理到应用，WebSocket 升级由 Caddy 自动处理。
- Let's Encrypt `shortlived` profile 为公网 IP 签发短期证书，Caddy 自动续期。

## 网络与反向代理场景

### 使用非标准 HTTPS 端口

设置例如 9443 时，需要开放该 TCP 端口，并显式设置可信 Origin：

```env
HTTPS_PORT=9443
TRUSTED_ORIGINS=https://203.0.113.10:9443
```

访问地址为 `https://203.0.113.10:9443`。80/TCP 仍必须从公网可达，Caddy 会将 HTTP 请求重定向到带端口的 HTTPS 地址。

### 在 NAT 后部署

`PUBLIC_IP` 应填写客户端最终连接的固定公网 IP，而不是服务器内网地址。公网入口必须将 HTTPS 和 LiveKit TCP/UDP 按相同外部端口映射到服务器。

只映射 `LIVEKIT_TCP_PORT` 时可能通过 ICE/TCP 建立通话，但稳定部署仍应提供 UDP 媒体端口。NAT 设备、云安全组与服务器防火墙都需要同步放行；如果公网入口不能提供 80/TCP，默认 Caddy 的 HTTP-01 证书路径不可用。

### 使用域名和自管 Nginx

自管反向代理必须提供有效 HTTPS，并把 `/rtc` 整个前缀代理到宿主机的 LiveKit HTTP 端口，把其他请求代理到应用 HTTP 端口。WebRTC 媒体端口仍由 LiveKit 直接对外暴露，不经过 Nginx。

在 `.env` 中禁用默认 Gateway，并覆盖浏览器公开地址：

```env
PUBLIC_IP=203.0.113.10
# COMPOSE_PROFILES=gateway
LIVEKIT_PUBLIC_URL=wss://chat.example.com
TRUSTED_ORIGINS=https://chat.example.com
```

首次部署可直接启动 app 和 LiveKit：

```bash
docker compose up -d app livekit
```

如果从 Caddy Gateway 切换到自管反向代理，先停止 Gateway：

```bash
docker compose --profile gateway stop gateway
docker compose up -d app livekit
```

宿主机上的 Nginx 可参考 [`deploy/nginx.conf.example`](../deploy/nginx.conf.example)。需要按实际域名、证书路径和端口调整该示例。生产环境仍须保持 `COOKIE_SECURE=true`。

### UFW 示例

项目不要求使用 UFW。大多数云主机还需要单独配置云厂商安全组；只修改 UFW 不会自动开放云侧入口。

使用默认端口时可执行：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
```

使用 firewalld、nftables 或云厂商防火墙时，按[标准端口表](#4-配置内核与网络入口)创建等价规则。不要向公网开放应用和 LiveKit 的 localhost 诊断端口。

## 更新与回滚

更新前先完成 SQLite 数据备份，并确认目标版本的发布说明。将下面的 `v0.3.10` 替换为要升级到的版本：

```bash
git fetch --depth 1 origin tag v0.3.10
git checkout v0.3.10
```

同步修改 `.env` 中的镜像版本：

```env
APP_IMAGE=ghcr.io/yeeeck/celery-web-speak:v0.3.10
```

检查配置并替换容器：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose up -d --force-recreate gateway
docker compose ps
```

Gateway 通过只读 bind mount 读取 `deploy/Caddyfile`。文件内容变化不会改变 Compose 容器定义，因此更新部署文件后应显式重建 Gateway。不要删除 `caddy-data` 卷。

回滚时，将仓库标签和 `APP_IMAGE` 一起切换到上一个已验证版本，再次更新服务。数据库迁移在应用启动时自动执行；跨越不兼容数据库版本回滚时必须同时恢复升级前的数据库备份，不能直接使用已迁移的数据卷。例如从 `v0.2.0` 回滚到 `v0.1.x` 时必须恢复旧数据库。

## 数据备份与恢复

默认 Compose 项目名为 `celery-web-speak`，SQLite 位于 Docker 卷 `celery-web-speak_app-data`，Caddy 数据位于 `celery-web-speak_caddy-data`。使用 `docker compose -p` 修改项目名后，卷名也会变化；操作前可执行 `docker volume ls` 确认实际名称。

### 备份 SQLite

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

### 备份 Caddy 数据

`caddy-data` 保存 ACME 账号、证书和私钥。它丢失后 Caddy 可以重新签发证书，但频繁重新签发可能触发 Let's Encrypt 速率限制。

```bash
docker compose stop gateway
docker run --rm \
  -v celery-web-speak_caddy-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine:3.23 \
  tar czf "/backup/caddy-$(date +%Y%m%d-%H%M%S).tar.gz" -C /data .
docker compose start gateway
```

### 恢复 SQLite

恢复会覆盖当前数据库。先再次备份当前数据，并确认 Compose 项目名、目标卷名和归档内容。将示例归档名替换为实际文件名：

```bash
docker compose stop app
docker run --rm \
  -v celery-web-speak_app-data:/data \
  -v "$PWD/backups":/backup:ro \
  alpine:3.23 \
  sh -c 'rm -rf /data/* && tar xzf /backup/celery-YYYYMMDD-HHMMSS.tar.gz -C /data'
docker compose start app
```

恢复 `caddy-data` 时也必须先停止 Gateway，并保持原文件权限。生产备份应复制到服务器之外，并定期验证归档能够解压和恢复。

## 故障排查

| 现象 | 主要检查项 |
| --- | --- |
| 浏览器提示 `ERR_SSL_PROTOCOL_ERROR` 或 curl 收到 TLS `internal error` | 确认 Gateway 已使用当前 `deploy/Caddyfile` 重建；检查 Caddy 日志中是否成功签发 IP 证书，并确认配置保留 `default_sni {$PUBLIC_IP}` |
| 证书无法签发或续期 | 确认 `PUBLIC_IP` 指向本机公网入口、80/TCP 可从公网访问，并查看 `docker compose logs gateway` 中的 ACME 错误 |
| HTTP 跳转后丢失非标准 HTTPS 端口 | 确认 Caddyfile 使用显式 HTTP `redir`，并强制重建 Gateway |
| 网页正常，但浏览器提示 `could not establish pc connection` | 确认 `PUBLIC_IP` 是客户端可达地址；检查 LiveKit TCP/UDP 端口、安全组、NAT 与端口映射 |
| WSS 连接后反复 `signalReconnecting` | 检查 Gateway 日志，并确认当前 Caddyfile 将 `/rtc` 和 `/rtc/*` 代理到 `livekit:7880` |
| 只开放 7881/TCP 后能够通话 | 当前正在使用 ICE/TCP 回退；继续开放 7882/UDP 以获得更稳定的媒体路径 |
| `/rtc/v1` 返回 404 或应用首页 | Gateway 未加载当前 Caddyfile，或自管反向代理没有代理整个 `/rtc` 前缀 |
| 登录成功后立即回到登录页 | 生产必须通过 HTTPS 访问；确认浏览器 Origin 与 `TRUSTED_ORIGINS` 完全一致，并保持 `COOKIE_SECURE=true` |
| 浏览器无法访问麦克风 | 使用有效 HTTPS，检查浏览器站点权限；普通公网 HTTP 不属于安全上下文 |
| LiveKit 提示 UDP receive buffer 过小 | 安装 `deploy/99-celery-web-speak.conf` 并执行 `sudo sysctl --system` |
| `docker compose pull` 无权限 | 登录对应镜像仓库，或确认 GHCR 包可公开拉取 |

诊断媒体连接时，先查看服务器日志：

```bash
docker compose logs --since=10m livekit
```

成功连接后，日志中的 participant 应出现选中的 ICE candidate 和明确的 connection type。只有信令会话、没有媒体候选，通常意味着公网 IP 或媒体端口不可达。

## 安全与运维注意事项

- `.env` 包含管理员初始密码和 LiveKit Secret，应保持权限为 `0600`，不得提交到 Git。
- 生产部署必须使用可信 HTTPS，并保持 `COOKIE_SECURE=true`。
- 80/TCP 用于公网 IP 证书验证和续期，不能在首次签发后永久关闭。
- 不要把 `APP_HTTP_PORT` 和 `LIVEKIT_HTTP_PORT` 暴露到公网。
- 不要把 `docker compose down -v` 用作常规更新命令；它会删除 SQLite 和 Caddy 持久卷。
- 应用镜像、Compose 文件和 Gateway 配置应固定在同一发布标签。
- 定期备份 SQLite 与 Caddy 数据，并把备份复制到服务器之外。
