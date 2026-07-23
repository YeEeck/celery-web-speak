# Celery Web Speak

Celery Web Speak 是一个面向小型固定群体的公开多频道在线语音与文字聊天工具。文字频道与语音频道彼此独立，前端使用 Vue 3，业务服务使用 Go 与 SQLite，语音通过 LiveKit SFU 集中转发。

当前稳定版本为 `v0.3.9`，生产部署建议固定使用明确版本的预构建镜像。

## 功能

- 中文 Discord 风格桌面与 Android Chrome 界面
- 公开文字与语音频道创建、改名、删除，以及分频道设置和实时状态
- 可调 32-128 kbps Opus 单声道语音，背景音独立 64-256 kbps 立体声码率，并可分别配置 RED 丢包冗余
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

完整范围与权限矩阵见 [产品规格](docs/product-spec.md)，服务关系见 [技术架构](docs/architecture.md)，版本发布流程见 [发版流程](docs/release-process.md)。

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

以下流程适用于直接拥有固定公网 IPv4 的 Linux amd64 主机。Caddy Gateway 会自动为公网 IP 申请浏览器信任的 HTTPS 证书，生产服务器只拉取预构建镜像。

域名或自管 Nginx、NAT、非默认端口、UFW、故障排查、更新回滚和数据备份参见[完整生产部署指南](docs/deployment.md)。

### 前置条件

- Linux amd64 主机，建议至少 2 核 CPU、4 GB 内存
- Docker Engine 和 Docker Compose v2
- 固定公网 IPv4 直接绑定到主机
- 80/TCP 与 443/TCP 未被其他服务占用
- 云安全组和主机防火墙允许下文列出的端口

### 1. 获取固定版本

部署文件与应用镜像必须使用同一版本：

```bash
git clone --branch v0.3.9 --depth 1 https://github.com/YeEeck/celery-web-speak.git
cd celery-web-speak
```

### 2. 配置密钥和管理员

生成 LiveKit API Key 和 Secret：

```bash
docker run --rm livekit/livekit-server:v1.13.4 generate-keys
```

复制环境变量模板并限制文件权限：

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，至少填写以下配置：

```env
PUBLIC_IP=203.0.113.10

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=一段足够长的随机密码

LIVEKIT_API_KEY=生成的Key
LIVEKIT_API_SECRET=生成的Secret

APP_IMAGE=ghcr.io/yeeeck/celery-web-speak:v0.3.9
COMPOSE_PROFILES=gateway
HTTPS_PORT=443
```

将示例 IP、管理员密码和 LiveKit 密钥替换为实际值。不要提交包含这些机密的 `.env`。

### 3. 配置内核和网络入口

安装 LiveKit 所需的 UDP 缓冲区参数：

```bash
sudo install -m 0644 deploy/99-celery-web-speak.conf /etc/sysctl.d/99-celery-web-speak.conf
sudo sysctl --system
```

在云安全组和主机防火墙中开放：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | HTTPS 证书签发、续期和 HTTP 跳转 |
| 443 | TCP | 网页、API、WebSocket 和 LiveKit 信令 |
| 7881 | TCP | WebRTC ICE/TCP 回退 |
| 7882 | UDP | WebRTC 首选媒体路径 |

80/TCP 在证书签发后仍须保持开放，以便续期。当前部署不启用 TURN；不要向公网开放仅供本机诊断的 8080/TCP 和 7880/TCP。

### 4. 启动和验证

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
```

首次签发证书通常需要数秒。检查容器、本机健康接口和日志：

```bash
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
docker compose logs --tail=100 gateway app livekit
```

健康接口应返回 `{"status":"ok"}`。再从服务器之外验证可信 HTTPS：

```bash
curl -I http://203.0.113.10/
curl -fsS https://203.0.113.10/api/health
```

将示例 IP 替换为实际公网 IP。正式验证不要添加 `-k`，否则无法发现证书信任问题。

### 5. 登录和语音验收

使用 `.env` 中的初始管理员账号登录，通过管理控制台创建第二个账号或邀请码。用两个不同账号加入同一语音频道，确认双方可以听到声音；只验证网页能够打开，不能证明 WebRTC 媒体端口可达。

确认管理员可以登录后，清空 `.env` 中的初始密码：

```env
BOOTSTRAP_ADMIN_PASSWORD=
```

刷新应用容器环境：

```bash
docker compose up -d app
```

不要使用 `docker compose down -v` 作为常规停止或更新命令，它会删除 SQLite 和 Caddy 持久卷。后续部署维护参见[完整生产部署指南](docs/deployment.md)。

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
docker compose -f compose.yml -f compose.build.yml -f compose.dev.yml up --build
```

`compose.dev.yml` 覆盖 `LIVEKIT_PUBLIC_URL`、`TRUSTED_ORIGINS` 和 `COOKIE_SECURE`，使本地不走 Gateway 也能正常访问 WebSocket 和语音。

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
