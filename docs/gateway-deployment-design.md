# Gateway 一键 HTTPS 部署设计

> 状态：已实施。
>
> 设计日期：2026-07-23。
>
> 当前部署基线：v0.3.0（手动 Nginx + 手动证书）。

## 背景

当前 Docker Compose 部署仅包含 app 和 LiveKit 两个服务。HTTPS 终止、反向代理和证书管理完全由部署方在 Compose 外部自行完成（Nginx + 手动 certbot/acme.sh）。对于没有专业运维能力的用户，配置 Nginx 反向代理（含 WebSocket 升级头、长连接超时）和证书自动续期是部署中最大的障碍。

Let's Encrypt 于 2025 年 12 月正式支持公网 IP 地址证书签发（`shortlived` profile，6 天有效期），使得无域名部署也能获得浏览器信任的 HTTPS 证书。Caddy v2.10+ 原生支持 ACME profiles，可全自动完成 IP 证书的签发与续期，无需外部脚本或 cron。

## 目标

- 用户在 `.env` 中填写最少必填项后，`docker compose up -d` 即获得完整可用的 HTTPS 服务。
- Gateway 自动完成：IP 证书签发、续期、HTTP→HTTPS 重定向、反向代理（含 WebSocket）。
- 不构建自定义 Docker 镜像，使用官方 `caddy:2.11` 镜像 + 挂载配置文件。
- 通过 Docker Compose profiles 机制实现 gateway 的可选启用，不破坏高级用户的自定义部署。
- LiveKit 媒体端口参数化，支持非标准端口部署。

## 非目标

- 不自动 LiveKit API 密钥（用户仍需手动 `docker run livekit-server generate-keys`）。
- 不处理云服务商防火墙/安全组配置（文档提示用户手动开放端口）。
- 不支持域名证书（本方案专注 IP 证书路径；域名部署走高级参考配置）。
- 不支持 80 端口重映射（ACME HTTP-01 挑战强制要求 80 端口）。
- 不替代现有 Nginx 高级部署参考（保留 `deploy/nginx.conf.example`）。
- 不支持多站点/多实例共享同一 Gateway。

## 架构

```text
Browser
  | HTTPS (HTTPS_PORT, 默认 443)
  v
Caddy Gateway (caddy:2.11)
  |  80: ACME HTTP-01 挑战 + 301 重定向
  |  443 (或 HTTPS_PORT): TLS 终止
  |
  |-- /rtc --> livekit:7880 (WSS 信令)
  |-- /*   --> app:8080    (HTTP + WS)
  |
  v (Docker internal network)
app:8080 ──── livekit:7880
                 |
                 | WebRTC 媒体 (直接暴露到宿主机)
                 v
Browser <── 7881/TCP, 7882/UDP, 3478/UDP, 30000-30099/UDP
```

## 已确认决策

### D1: Gateway 实现方式

使用官方 `caddy:2.11` 镜像，通过只读卷挂载 `deploy/Caddyfile` 注入配置。不构建自定义镜像。

理由：Caddy 原生支持 ACME IP 证书签发与自动续期，无需 cron、acme.sh 或 entrypoint 脚本。维护成本为零。

### D2: 证书方案

- CA：Let's Encrypt，`shortlived` profile（6 天有效期）。
- 验证方式：HTTP-01（Caddy 自动在 80 端口响应 `/.well-known/acme-challenge/`）。
- 续期时机：Caddy 内置策略，证书生命周期 2/3 处（约第 4 天）自动续期。
- 持久化：Caddy 数据目录通过 named volume `caddy-data` 挂载到 `/data`，避免容器重建后重新签发触发速率限制。

### D3: 端口策略

| 端口 | 用途 | 可配置 | 暴露方 |
|------|------|--------|--------|
| 80/TCP | ACME 挑战 + HTTP→HTTPS 重定向 | 否 | gateway |
| HTTPS_PORT（默认 443）/TCP | HTTPS 服务 | 是 | gateway |
| 8080/TCP | app HTTP（仅 127.0.0.1，宿主机端口可配置） | APP_HTTP_PORT | app（调试用） |
| 7880/TCP | LiveKit HTTP（仅 127.0.0.1，宿主机端口可配置） | LIVEKIT_HTTP_PORT | livekit（调试用） |
| LIVEKIT_TCP_PORT（默认 7881）/TCP | WebRTC TCP | 是 | livekit |
| LIVEKIT_UDP_PORT（默认 7882）/UDP | WebRTC UDP | 是 | livekit |
| LIVEKIT_TURN_PORT（默认 3478）/UDP | TURN | 是 | livekit |
| LIVEKIT_RELAY_START~END（默认 30000-30099）/UDP | TURN relay | 是 | livekit |

Gateway 启用时独占宿主机 80 和 HTTPS_PORT。app 的 `127.0.0.1:8080` 映射始终保留（localhost only，无害且便于调试）。

### D4: Gateway 启用机制

使用 Docker Compose `profiles`：

- gateway 服务声明 `profiles: ["gateway"]`。
- `.env` 中 `COMPOSE_PROFILES=gateway` 启用；注释或置空则禁用。
- 禁用时用户需自行在 Compose 外部提供 HTTPS 反代（参考 `deploy/nginx.conf.example`）。

### D5: Caddyfile 环境变量注入

Caddyfile 使用 Caddy 原生 `{$VAR:default}` 语法引用环境变量：

- `{$PUBLIC_IP}`：站点地址（无默认值，必填）。
- `{$HTTPS_PORT:443}`：HTTPS 监听端口。

Caddy 全局选项设置 `https_port {$HTTPS_PORT:443}`。80 端口行为（ACME + 重定向）无需额外配置。

### D6: 派生环境变量

以下变量在 `compose.yml` 中由 `PUBLIC_IP` 和 `HTTPS_PORT` 推导，用户无需手动填写：

- `LIVEKIT_PUBLIC_URL` = `wss://${PUBLIC_IP}:${HTTPS_PORT:-443}`
- `TRUSTED_ORIGINS` = `https://${PUBLIC_IP}:${HTTPS_PORT:-443}`
- `LIVEKIT_NODE_IP` = `${PUBLIC_IP}`

注：443 端口时 URL 带冗余端口号（`wss://1.2.3.4:443`），功能正确，不做条件省略。

### D7: LiveKit 配置参数化

`LIVEKIT_CONFIG` 内联 YAML 中的媒体端口使用 Compose 变量替换：

```yaml
LIVEKIT_CONFIG: |
  port: 7880
  bind_addresses: ["0.0.0.0"]
  logging:
    level: info
    json: true
  rtc:
    node_ip: "${PUBLIC_IP:?set PUBLIC_IP}"
    tcp_port: ${LIVEKIT_TCP_PORT:-7881}
    udp_port: ${LIVEKIT_UDP_PORT:-7882}
  turn:
    enabled: true
    udp_port: ${LIVEKIT_TURN_PORT:-3478}
    relay_range_start: ${LIVEKIT_RELAY_START:-30000}
    relay_range_end: ${LIVEKIT_RELAY_END:-30099}
  room:
    empty_timeout: 300
    departure_timeout: 20
  webhook:
    api_key: "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}"
    urls:
      - "http://app:8080/api/livekit/webhook"
```

`ports` 映射同步使用相同变量。

### D8: 消除的 .env 变量

以下变量从 `.env.example` 中移除（由推导替代）：

- `LIVEKIT_PUBLIC_URL`（推导为 `wss://${PUBLIC_IP}:${HTTPS_PORT:-443}`）
- `TRUSTED_ORIGINS`（推导为 `https://${PUBLIC_IP}:${HTTPS_PORT:-443}`）
- `LIVEKIT_NODE_IP`（= PUBLIC_IP）

以下变量保留在 `.env.example` 中，带默认值，用户可按需覆盖：

- `APP_HTTP_PORT`（默认 8080，localhost 调试映射的宿主机端口）
- `LIVEKIT_HTTP_PORT`（默认 7880，localhost 调试映射的宿主机端口）
- `COOKIE_SECURE`（默认 true）
- `SESSION_COOKIE_NAME`（默认 celery_session）
- `VOICE_RECONCILE_INTERVAL`（默认 15s）

## .env.example 最终形态

```bash
# ═══ 必填 ═══

# 服务器公网 IP（用于证书签发、ICE 候选、浏览器访问地址）
PUBLIC_IP=

# 首次启动时创建的服务器管理员
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=

# LiveKit 认证密钥（docker run --rm livekit/livekit-server:v1.13.4 generate-keys）
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# ═══ 可选（有默认值）═══

# 应用镜像（支持不同 registry 或版本）
APP_IMAGE=ghcr.io/yeck/celery-web-speak:latest

# 启用 gateway（注释掉则禁用，需自行配置 HTTPS 反代）
COMPOSE_PROFILES=gateway

# HTTPS 端口（默认 443）
HTTPS_PORT=443

# LiveKit 媒体端口（如需规避云厂商端口限制可修改，需同步开放防火墙）
LIVEKIT_TCP_PORT=7881
LIVEKIT_UDP_PORT=7882
LIVEKIT_TURN_PORT=3478
LIVEKIT_RELAY_START=30000
LIVEKIT_RELAY_END=30099

# 应用 HTTP 调试端口（仅绑定 127.0.0.1）
APP_HTTP_PORT=8080

# LiveKit HTTP 调试端口（仅绑定 127.0.0.1）
LIVEKIT_HTTP_PORT=7880

# 应用行为
COOKIE_SECURE=true
SESSION_COOKIE_NAME=celery_session
VOICE_RECONCILE_INTERVAL=15s

# 时区
TZ=Asia/Shanghai
```

## deploy/Caddyfile

```
{
	https_port {$HTTPS_PORT:443}
}

{$PUBLIC_IP} {
	tls {
		issuer acme {
			dir https://acme-v02.api.letsencrypt.org/directory
			profile shortlived
		}
	}

	@livekit path /rtc
	handle @livekit {
		reverse_proxy livekit:7880
	}

	handle {
		reverse_proxy app:8080
	}
}
```

说明：
- Caddy 自动处理 WebSocket 升级（无需手动设置 Upgrade/Connection 头）。
- WebSocket 连接无默认超时限制，语音长连接不会被断开。
- ACME HTTP-01 挑战由 Caddy 在 80 端口自动响应，优先于 reverse_proxy 路由。
- HTTP 访问自动 301 重定向到 HTTPS。

## compose.yml 服务结构

```yaml
name: celery-web-speak

services:
  gateway:
    image: caddy:2.11
    profiles: ["gateway"]
    restart: unless-stopped
    ports:
      - "80:80"
      - "${HTTPS_PORT:-443}:${HTTPS_PORT:-443}"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    environment:
      PUBLIC_IP: ${PUBLIC_IP:?set PUBLIC_IP}
      HTTPS_PORT: ${HTTPS_PORT:-443}
    depends_on:
      - app
      - livekit

  app:
    image: ${APP_IMAGE:-ghcr.io/yeck/celery-web-speak:latest}
    restart: unless-stopped
    depends_on:
      livekit:
        condition: service_started
    environment:
      ADDR: ":8080"
      DATABASE_PATH: /data/celery.db
      COOKIE_SECURE: ${COOKIE_SECURE:-true}
      SESSION_COOKIE_NAME: ${SESSION_COOKIE_NAME:-celery_session}
      BOOTSTRAP_ADMIN_USERNAME: ${BOOTSTRAP_ADMIN_USERNAME:-}
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD:-}
      LIVEKIT_URL: http://livekit:7880
      LIVEKIT_PUBLIC_URL: wss://${PUBLIC_IP:?set PUBLIC_IP}:${HTTPS_PORT:-443}
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET}
      VOICE_RECONCILE_INTERVAL: ${VOICE_RECONCILE_INTERVAL:-15s}
      TRUSTED_ORIGINS: https://${PUBLIC_IP:?set PUBLIC_IP}:${HTTPS_PORT:-443}
      TZ: ${TZ:-Asia/Shanghai}
    volumes:
      - app-data:/data
    ports:
      - "127.0.0.1:${APP_HTTP_PORT:-8080}:8080"

  livekit:
    image: livekit/livekit-server:v1.13.4
    restart: unless-stopped
    environment:
      LIVEKIT_KEYS: "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET}"
      LIVEKIT_CONFIG: |
        port: 7880
        bind_addresses:
          - "0.0.0.0"
        logging:
          level: info
          json: true
        rtc:
          node_ip: "${PUBLIC_IP:?set PUBLIC_IP}"
          tcp_port: ${LIVEKIT_TCP_PORT:-7881}
          udp_port: ${LIVEKIT_UDP_PORT:-7882}
        turn:
          enabled: true
          udp_port: ${LIVEKIT_TURN_PORT:-3478}
          relay_range_start: ${LIVEKIT_RELAY_START:-30000}
          relay_range_end: ${LIVEKIT_RELAY_END:-30099}
        room:
          empty_timeout: 300
          departure_timeout: 20
        webhook:
          api_key: "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}"
          urls:
            - "http://app:8080/api/livekit/webhook"
    ports:
      - "127.0.0.1:${LIVEKIT_HTTP_PORT:-7880}:7880"
      - "${LIVEKIT_TCP_PORT:-7881}:${LIVEKIT_TCP_PORT:-7881}/tcp"
      - "${LIVEKIT_UDP_PORT:-7882}:${LIVEKIT_UDP_PORT:-7882}/udp"
      - "${LIVEKIT_TURN_PORT:-3478}:${LIVEKIT_TURN_PORT:-3478}/udp"
      - "${LIVEKIT_RELAY_START:-30000}-${LIVEKIT_RELAY_END:-30099}:${LIVEKIT_RELAY_START:-30000}-${LIVEKIT_RELAY_END:-30099}/udp"

volumes:
  app-data:
  caddy-data:
```

## 用户部署流程（最终体验）

1. 准备一台有公网 IP 的 VPS，开放防火墙端口：80/TCP、443/TCP、7881/TCP、7882/UDP、3478/UDP、30000-30099/UDP。
2. 克隆 repo，复制 `.env.example` 为 `.env`。
3. 填写：`PUBLIC_IP`、`BOOTSTRAP_ADMIN_PASSWORD`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`。
4. `docker compose up -d`。
5. 浏览器访问 `https://<PUBLIC_IP>`，首次加载时 Caddy 自动签发证书（数秒）。

## 已知约束与风险

- **80 端口必须可达**：若云厂商或防火墙阻断 80 端口入站，证书无法签发/续期，6 天后 HTTPS 不可用。部分国内云厂商对未备案域名/IP 的 80 端口有间歇性拦截。
- **IP 证书 6 天有效期**：相比域名证书（90 天）续期频率高 15 倍。Caddy 自动处理，但续期窗口内若 80 端口不可达则失败。
- **端口独占**：启用 gateway 后宿主机 80 和 HTTPS_PORT 被 Caddy 独占。已有服务占用这些端口的用户应禁用 gateway 走高级部署。
- **非标准 HTTPS 端口**：`HTTPS_PORT` 非 443 时，用户访问需带端口号（`https://IP:8443`），80 端口仍用于 ACME 挑战。
- **LE 速率限制**：证书持久化依赖 `caddy-data` volume。`docker compose down -v` 会删除 volume 导致重新签发，频繁操作可能触发限制。

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `deploy/Caddyfile` | 新增 |
| `compose.yml` | 重写（加入 gateway、参数化端口、推导变量） |
| `.env.example` | 重写（精简必填项、新增端口变量） |
| `deploy/nginx.conf.example` | 保留不动（高级部署参考） |
| `deploy/99-celery-web-speak.conf` | 保留不动 |
| `docs/architecture.md` | 更新部署描述（Nginx → 可选 Gateway） |
| `compose.build.yml` | 检查兼容性（本地构建场景） |
