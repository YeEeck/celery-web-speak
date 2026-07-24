# Celery Web Speak 原生客户端壳设计

> 状态：方案已确认，尚未实施。
>
> 设计日期：2026-07-21。
>
> 当前服务端与 Web 实现基线：v0.3.0。

## 背景

当前客户端完全运行在浏览器中。浏览器承担登录会话、业务 WebSocket、LiveKit WebRTC、麦克风采集、远端音频播放、设备选择和本地设置持久化。该模式便于部署，但存在以下限制：

- 应用会话与日常浏览器上下文混在一起，容易误关、误刷新或清理数据。
- 麦克风、后台运行和音频设备能力受浏览器权限及生命周期约束。
- Android 切到后台或锁屏后，无法对持续双向通话提供稳定保证。
- 浏览器窗口和标签页的交互方式不像独立应用。

本设计通过桌面和 Android 原生壳解决应用上下文、权限和后台语音问题，同时保留服务器托管的一套 Vue Web UI。

## 目标

- Windows 和 Linux 使用 Electron 提供独立应用窗口与存储上下文。
- Android 使用 Kotlin WebView 显示服务器托管的同一套 Vue Web UI。
- Android 使用原生 LiveKit SDK 和前台服务保证后台双向语音。
- 浏览器、Electron 和 Android 共用同一套服务端业务接口和 Web UI。
- Web UI 随服务器发布，不随桌面或 Android 安装包固化。
- Android 允许用户输入任意 `http://` 或 `https://` 自建服务器地址。
- 把原生壳维护范围限制在窗口、权限、生命周期、音频和版本化 Bridge。

## 非目标

- 不开发 Android 专用页面或第二套移动端前端。
- 不支持 iOS。
- 不提供后台文字消息推送，不接入 FCM、HMS 或其他推送服务。
- 不保证应用进程被系统杀死后自动恢复语音。
- 不在用户从最近任务划掉应用后继续通话。
- 不实现 localhost HTTP 转发器。
- 不承诺任意 HTTP、自签名证书或错误 TLS 配置均可工作。
- 首期不提供 Electron 自动更新、开机启动、托盘常驻、签名或公证。
- 首期不要求 Android 后台播放成员加入、退出或文字消息提示音。

## 已确认决策

| 决策项 | 结论 |
| --- | --- |
| 桌面技术 | Electron |
| 桌面平台 | Windows、Linux |
| Android 技术 | Kotlin + WebView |
| Android 媒体运行时 | LiveKit Android SDK |
| 前端交付 | 服务器托管 Vue Web，浏览器与壳共用 |
| 后台语音 | 支持，使用麦克风类型 Foreground Service |
| 划掉最近任务 | 立即结束语音并停止服务 |
| 后台消息推送 | 不支持 |
| 自建服务器 | 用户输入任意 HTTP/HTTPS 地址 |
| localhost 转发 | 不实施 |
| Android 分发 | 直接分发 APK |
| Android 可靠性门槛 | 主要机型锁屏连续双向通话 30-60 分钟通过实测 |

## 总体架构

```text
                              +----------------------+
Browser --------------------> |                      |
                              |  Server-hosted Vue   |
Electron -------------------> |  HTTP API + WS       |
                              |                      |
Android WebView ------------> |                      |
        |                     +----------+-----------+
        |                                |
        | JS Bridge                      | LiveKit token / state API
        v                                |
+----------------------+                 |
| Android VoiceService | <---------------+
| LiveKit Android SDK  | ----------------------> LiveKit Server
| AudioManager         |
| Foreground Service   |
+----------------------+
```

桌面浏览器和 Electron 继续使用 `livekit-client`。Android WebView 不创建 Web LiveKit Room，而是通过 Bridge 控制 Kotlin `VoiceService` 中的原生 LiveKit Room。

## 客户端职责边界

### 共用 Web UI

Web UI 继续负责：

- 登录、注册、退出和账号资料。
- 文字频道、语音频道、消息和管理界面。
- 业务 WebSocket 及断线后的 HTTP 权威快照恢复。
- 当前用户、频道、成员资料和服务端权限状态。
- 语音成员的业务排序与展示。
- 用户设置界面和按服务器 Origin 隔离的 `localStorage`。
- 浏览器与 Electron 中的 LiveKit Web 运行时。

### Android 原生壳

Android 原生壳负责：

- 服务器地址配置和 WebView 生命周期。
- Android 麦克风权限与前台服务权限。
- LiveKit Room 连接、重连、发布和订阅音频。
- 锁屏或退到后台后的持续双向语音。
- AudioFocus、来电打断和音频设备路由。
- 蓝牙、听筒、扬声器和有线耳机变化。
- 通话期间的系统前台服务通知。
- 后台期间的权威语音运行状态。
- 必要时使用 WebView Cookie 调用现有语音 Token 与状态接口。

### Go 服务端

原生语音不要求新建业务协议。首期继续使用：

- `POST /api/servers/{serverID}/channels/{channelID}/voice/token`
- `PATCH /api/servers/{serverID}/channels/{channelID}/voice/state`
- LiveKit Webhook、房间校准和单账号单语音连接约束

不增加设备 Token、推送任务或推送服务配置。

## Web 语音运行时抽象

当前 `web/src/stores/voice.ts` 同时包含 Vue 状态、业务规则和 LiveKit Web 媒体操作。实施时应把媒体操作提取为运行时接口，Store 保留 UI 和业务状态。

概念接口如下，具体 TypeScript 类型在实现阶段确定：

```ts
interface VoiceRuntime {
  readonly kind: 'web' | 'android-native'

  prepare(serverOrigin: string): Promise<void>
  connect(options: VoiceConnectOptions): Promise<void>
  disconnect(): Promise<void>
  setMicrophoneEnabled(enabled: boolean): Promise<void>
  setDeafened(deafened: boolean): Promise<void>
  setParticipantVolume(userId: number, volume: number): Promise<void>
  setOutputVolume(volume: number): Promise<void>
  setInputDevice(deviceId: string): Promise<void>
  setOutputRoute(routeId: string): Promise<void>
  getSnapshot(): Promise<VoiceRuntimeSnapshot>

  subscribe(listener: (event: VoiceRuntimeEvent) => void): () => void
}
```

运行时选择规则：

```text
不存在原生壳
  -> WebVoiceRuntime
存在兼容的 Android Native Voice Bridge
  -> AndroidVoiceRuntime
存在原生壳但 Bridge 协议不兼容
  -> 禁用语音并显示客户端版本不兼容
```

Android 壳内不应静默退回 Web LiveKit 并继续宣称支持后台通话。Bridge 缺失或协议不兼容时，应明确禁用 Android 原生语音并显示版本不兼容错误。普通浏览器和 Electron 始终使用 `WebVoiceRuntime`。

## 状态所有权

| 状态 | 前台 Web | Android 后台 | 服务端 |
| --- | --- | --- | --- |
| 当前语音连接 | 展示与发起操作 | Kotlin 权威 | LiveKit 房间最终状态 |
| 麦克风实际启用状态 | 展示 | Kotlin 权威 | LiveKit 发布状态 |
| 耳机静音本地状态 | 展示与发起操作 | Kotlin 权威 | 参与者属性副本 |
| 参与者与发言状态 | Kotlin 事件映射后展示 | Kotlin 权威 | LiveKit 权威 |
| 角色与账号资料 | Web Store | 缓存快照 | Go/SQLite 权威 |
| 每用户音量设置 | `localStorage` | 连接时同步给 Kotlin | 不保存 |
| 麦克风和输出增益设置 | `localStorage` | 连接时同步给 Kotlin | 不保存 |
| 业务在线状态 | 业务 WebSocket | WebView 可能断开 | Go Hub 权威 |

后台 WebView 的业务 WebSocket 可能被系统暂停或断开。此时用户可能在语音频道中可见，但业务在线状态变为离线。这符合当前“在线状态只表示业务页面连接”的产品定义。首期不修改该语义。

## Bridge 协议

### 传输原则

- 使用结构化 JSON 消息，不通过拼接 JavaScript 代码传递数据。
- 每个请求包含唯一 `requestId`，并得到一次成功或失败响应。
- 所有消息包含 Bridge 主版本号。
- Token、Cookie 和密码不得进入日志或持久化 Bridge 队列。
- Bridge 只向当前顶层页面开放语音能力，不向子框架开放。
- WebView 导航到新 Origin 后必须重新完成握手。
- 原生端保存最新完整快照，不要求 WebView 消费后台期间的所有增量事件。

### 消息封装

```json
{
  "protocol": 1,
  "type": "voice.join",
  "requestId": "01J...",
  "payload": {}
}
```

响应：

```json
{
  "protocol": 1,
  "type": "response",
  "requestId": "01J...",
  "ok": true,
  "payload": {}
}
```

错误响应：

```json
{
  "protocol": 1,
  "type": "response",
  "requestId": "01J...",
  "ok": false,
  "error": {
    "code": "microphone_permission_denied",
    "message": "未获得麦克风权限"
  }
}
```

### Web 到 Android 命令

| 命令 | 作用 | 主要参数 |
| --- | --- | --- |
| `shell.hello` | 协商协议和能力 | Web 支持的协议范围 |
| `voice.prepare` | 请求权限并确认可以启动语音服务 | server Origin |
| `voice.join` | 启动服务并连接房间 | server Origin、channel ID、LiveKit URL、Token、音频设置 |
| `voice.leave` | 断开 Room 并停止服务 | 无 |
| `voice.set_muted` | 开关本地麦克风 | `muted` |
| `voice.set_deafened` | 联动麦克风与远端播放 | `deafened` |
| `voice.set_participant_volume` | 设置远端用户音量 | user ID、0-3 音量 |
| `voice.set_output_volume` | 设置全局输出音量 | 0-3 音量 |
| `voice.set_audio_processing` | 设置音频处理偏好 | 回声消除、降噪、自动增益 |
| `voice.set_input_device` | 切换输入设备 | 设备 ID；不支持时返回能力错误 |
| `voice.set_output_route` | 切换输出路由 | 路由 ID |
| `voice.get_snapshot` | 获取完整语音快照 | 无 |

`voice.join` 中的 Token 只保存在当前原生语音会话内。离开、连接失败或服务停止后应清除引用。

### Android 到 Web 事件

| 事件 | 作用 |
| --- | --- |
| `shell.ready` | 返回协议版本、壳版本和能力 |
| `voice.snapshot` | 完整连接、参与者、静音和设备状态 |
| `voice.connection_state` | connecting、connected、reconnecting、disconnected、error |
| `voice.participants_changed` | 提示 Web 请求或应用最新完整参与者快照 |
| `voice.audio_route_changed` | 当前与可用音频路由变化 |
| `voice.audio_focus_changed` | 音频焦点丢失或恢复 |
| `voice.permission_changed` | 麦克风权限变化 |
| `voice.error` | 运行时错误 |

WebView 位于后台时，原生端可以只更新内部快照。Activity 恢复后发送一次 `voice.snapshot`，不重放所有中间事件。

### 快照顺序

每次 `voice.join` 创建新的随机 `sessionId`。同一会话内，每次状态变化递增 `revision`。所有语音响应、事件和快照均携带这两个字段：

```ts
interface VoiceRuntimeSnapshot {
  sessionId: string | null
  revision: number
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  channelId: number | null
  muted: boolean
  deafened: boolean
  participants: NativeVoiceParticipant[]
  availableInputDevices: NativeAudioDevice[]
  availableOutputRoutes: NativeAudioRoute[]
  activeInputDeviceId: string | null
  activeOutputRouteId: string | null
  error: VoiceRuntimeError | null
}
```

Web 只接受当前 `sessionId` 且 `revision` 不小于已应用版本的状态。应用启动且从未加入过语音时，空闲快照的 `sessionId` 为 `null`。新会话建立后，旧会话的迟到事件必须丢弃；退出后的 `idle` 快照保留最后会话 ID，使退出过程可以覆盖同一会话的旧连接事件。

### 初始错误码

- `protocol_incompatible`
- `invalid_server_origin`
- `microphone_permission_denied`
- `foreground_service_start_failed`
- `voice_token_rejected`
- `livekit_connect_failed`
- `audio_route_unavailable`
- `audio_processing_unsupported`
- `session_revoked`
- `voice_disconnected`

错误码用于程序分支，中文消息用于当前 UI 展示。Web 不应依赖原生 SDK 的异常文本。

## Bridge 版本兼容

Web UI 随服务器发布，而 APK 和 Electron 壳不自动更新，因此 Bridge 必须保持长期向后兼容。

- 协议使用整数主版本，首版为 `1`。
- 同一主版本只允许增加可选字段、命令或能力，不改变现有字段语义。
- Web 必须先执行 `shell.hello`，再选择双方共同支持的版本。
- Web 根据能力列表控制功能，不根据 User-Agent 推断。
- 新 Web 需要更高协议版本时，应显示“客户端壳版本过低”，不能尝试未知命令。
- 壳遇到未知字段应忽略，遇到未知命令应返回明确错误。
- 破坏性变更必须使用新的主版本，并在服务端 Web 中保留旧主版本适配期。

首期能力名称建议包括：

```text
native_voice
foreground_voice
audio_routes
input_devices
participant_volume
microphone_gain
audio_processing_options
```

## Android 组件设计

### MainActivity

负责：

- 读取和修改当前服务器地址。
- 创建 WebView 并加载远程页面。
- 安装 Bridge 和协议握手脚本。
- 处理同源导航、外部链接和下载。
- 绑定 `VoiceService` 并把当前完整快照送入 Web。
- 返回前台时重新同步 Cookie、权限和语音快照。

Activity 不持有 LiveKit Room，不直接播放远端音频，也不承担后台连接。

### VoiceService

使用 started + bound service 模式：

- `startForegroundService` 保证 Activity 退到后台后继续运行。
- Activity 前台时绑定 Service，用于命令和状态订阅。
- Service 独立持有 LiveKit Room、协程作用域和最新快照。
- Service 进入连接流程后立即创建前台服务通知。
- 连接结束后释放 Room、音频焦点、设备监听器和通知。
- `onTaskRemoved` 主动断开 Room 并停止自身。

首期 Service 与 Activity 运行在同一应用进程，不使用独立 `android:process`，避免引入 IPC 和双进程 Cookie/状态同步复杂度。

### VoiceRepository

进程内单例，连接 Activity 与 Service：

- 保存最新 `VoiceRuntimeSnapshot`。
- 暴露命令入口和状态 Flow。
- Activity 重建后可立即获得当前快照。
- 不持久化 Room、Token 或临时耳机静音状态。

### NativeApiClient

负责后台重连所需的少量认证请求：

- 从 `android.webkit.CookieManager` 读取当前服务器 Cookie。
- 只调用当前服务器 Origin 下的固定语音 API 路径。
- 不跟随到其他 Origin 的重定向。
- 不记录 Cookie、Token 或响应正文中的敏感字段。
- 收到新的 `Set-Cookie` 时同步回 WebView CookieManager。

首期不把所有 Web API 迁移到 Kotlin，仅实现语音 Token 刷新和必要的耳机静音状态同步。

### AudioRouteController

负责：

- 请求和释放通话型 AudioFocus。
- 观察蓝牙、听筒、扬声器和有线耳机状态。
- Android 12+ 使用通信设备 API 选择输出。
- 把可用路由和当前路由映射为稳定 Bridge ID。
- 处理来电、其他应用抢占音频和设备拔出。

LiveKit Android SDK 默认通信音频模式可以自动路由。若需要手动选择设备，应使用 SDK 允许自定义音频属性和模式的配置，不能同时依赖完全自动路由。

### Foreground Notification

通话期间显示常驻通知：

- 当前服务器与语音频道名称。
- 当前连接或重连状态。
- 打开应用操作。
- 静音/取消静音操作。
- 退出语音操作。

这是 Android 后台麦克风运行所需的通话通知，不承担文字消息提醒。

## Android 权限与系统配置

预计需要：

- `android.permission.INTERNET`
- `android.permission.RECORD_AUDIO`
- `android.permission.MODIFY_AUDIO_SETTINGS`
- `android.permission.FOREGROUND_SERVICE`
- `android.permission.FOREGROUND_SERVICE_MICROPHONE`
- Android 12+ 的 `android.permission.BLUETOOTH_CONNECT`
- Android 13+ 的 `android.permission.POST_NOTIFICATIONS`

Service 声明麦克风前台服务类型。麦克风 Foreground Service 必须在 Activity 仍处于前台且已获得 `RECORD_AUDIO` 时启动，不能等到应用进入后台后再请求。

允许 HTTP 自建服务器时需要启用明文网络访问。该配置只允许网络请求，不忽略 TLS 错误，也不绕过证书校验。

## Android 生命周期

### 加入语音

```text
用户点击语音频道
  -> Web 发送 voice.prepare
  -> Activity 在前台检查麦克风与通知权限
  -> voice.prepare 成功
  -> Web 请求现有 Voice Token
  -> Web 发送 voice.join
  -> 启动并绑定 VoiceService
  -> VoiceService 立即进入前台
  -> 创建 LiveKit Room 并连接
  -> 发布麦克风
  -> 返回完整 voice.snapshot
```

只有原生 Room 已连接且麦克风发布结果明确后，Web 才显示语音已连接。

`voice.prepare` 必须发生在 Token 请求之前。现有服务端签发 Token 会推进同账号的语音连接代次；若先签发 Token 再发现权限被拒绝，可能无意义地使旧连接失效。

### 退到后台或锁屏

```text
Activity stopped
  -> 不断开 VoiceService
  -> 不暂停原生 Room
  -> Service 继续收发音频
  -> Service 持续维护最新快照
```

WebView 可以被暂停。后台通话不得依赖 Web 定时器、Web Audio 或业务 WebSocket 保活。

### 返回前台

```text
Activity resumed
  -> 重新绑定 VoiceService
  -> shell.hello
  -> voice.get_snapshot
  -> Web 用完整快照覆盖本地语音运行状态
  -> 业务 WebSocket 按现有机制重连和 bootstrap
```

### 主动退出

```text
voice.leave 或通知栏退出
  -> 关闭麦克风轨道
  -> Room.disconnect
  -> 释放 AudioFocus 和设备监听
  -> 停止前台通知与 Service
  -> 向 Web 发布 disconnected 快照
```

### 划掉最近任务

`VoiceService.onTaskRemoved` 执行与主动退出相同的清理。若进程被系统强制终止而未执行回调，由 LiveKit 断线检测和服务端房间校准最终清理状态。

## Token 与后台重连

服务端当前签发 15 分钟有效的 LiveKit Token。Token 过期不会被假定为一定中断现有连接，但网络中断后的重新鉴权必须有刷新能力。

重连策略：

1. 优先让 LiveKit SDK 使用当前连接状态自动重连。
2. SDK 明确报告 Token 失效或需要新 Token 时，由 `NativeApiClient` 请求同一频道的新 Token。
3. 新 Token 仍受服务端签发代次约束，旧连接可能被服务端移除。
4. 会话 Cookie 失效、账号被封禁或 Token 接口返回 401/403 时，停止重试并结束语音。
5. 短暂网络错误使用有上限的退避重试，不能无限高频请求 Token。
6. Activity 恢复后向 Web 报告最终状态和错误。

原型必须覆盖通话超过 15 分钟后断网再恢复的场景。

## Android 音频行为

### 麦克风与耳机静音

- 麦克风静音只关闭本地麦克风发布，不停止 Room。
- 开启耳机静音时关闭所有远端音频并联动关闭麦克风。
- 关闭耳机静音时，仅在麦克风由耳机静音联动关闭时恢复。
- 管理员语音禁言优先于本地状态，不能由客户端解除。
- 原生状态切换成功后再更新 Bridge 快照。
- 服务端耳机静音属性同步失败时保持本地状态，并在连接恢复后重试。

### 音频路由

- 默认遵循 Android 通话音频策略。
- 提供扬声器、听筒、蓝牙和有线设备中的实际可用选项。
- 不向 Web 暴露 Android 临时设备 ID，Bridge 使用稳定的逻辑路由 ID。
- 设备消失时回退到系统可用路由，并向 Web 发送变更事件。
- 来电或永久 AudioFocus 丢失时默认静音麦克风；是否自动恢复以实际焦点类型和原静音状态决定。

### 音量与音频处理

| Web 当前能力 | Android 目标 | 风险 |
| --- | --- | --- |
| 每用户 0%-300% 音量 | 对远端音轨应用独立音量 | 需验证 SDK 音量范围和失真 |
| 全局 0%-300% 输出音量 | 与每用户音量合成后限制为 300% | 需避免系统音量与软件增益混淆 |
| 麦克风 0%-300% 增益 | 原生/WebRTC 音频处理器 | 高风险，不能复用 Web Audio |
| 回声消除 | Android/WebRTC 音频配置 | 设备实现存在差异 |
| 降噪 | Android/WebRTC 音频配置 | 设备实现存在差异 |
| 自动增益 | Android/WebRTC 音频配置 | 与手动麦克风增益可能冲突 |

麦克风增益与自动增益的组合必须通过录音和真实通话验证。若无法稳定达到 Web 版 300%，首期应明确暴露能力差异，不能仅修改 UI 数值而实际无效。

## WebView 设计

### 服务器地址

- 首次启动要求用户输入完整 `http://` 或 `https://` URL。
- 保存规范化后的当前服务器地址，不保存账号密码。
- 切换服务器前退出当前语音并停止 Service。
- Cookie、LocalStorage 和 IndexedDB 继续由 WebView 按 Origin 隔离。
- 不使用 localhost 代理或 `file://` 页面承载远程应用。

### 导航

- 当前服务器同 Origin 导航留在 WebView。
- 跨 Origin 链接交给系统浏览器。
- 用户明确切换服务器时重新建立 Bridge 握手。
- 禁止 `javascript:`、`file:`、`content:` 和未知自定义协议。
- TLS 错误不自动忽略；HTTP 地址走明确的明文访问路径。

### Web 媒体权限

Android 使用原生 LiveKit 后，WebView 不应再授予页面麦克风捕获权限，避免同时创建 Web 和原生麦克风轨道。普通 Web Audio 输出仍可用于前台提示音，但不作为后台可靠能力。

## HTTP 自建服务器

Android 壳允许加载 HTTP 页面，并允许原生网络组件访问相同 HTTP Origin。由于麦克风采集发生在原生 LiveKit SDK 中，页面本身不需要通过 `getUserMedia` 获得麦克风。

HTTP 部署仍必须正确配置：

- 业务 WebSocket 使用可访问的 `ws://` 或 `wss://` 地址。
- LiveKit Token 返回的 URL 能被 Android SDK 访问。
- `TRUSTED_ORIGINS` 包含实际 Web 页面 Origin。
- HTTP 部署不能错误地要求浏览器发送仅限 HTTPS 的 Secure Cookie。
- Android 网络安全配置允许目标明文地址。

不实现 localhost 反向代理，不重写远端 Cookie、CSP、Origin 或 LiveKit URL。

## Electron 设计

Electron 仅提供薄桌面壳：

- 用户配置当前服务器 URL。
- `BrowserWindow` 直接加载远程 Web 页面。
- 使用独立 `userData` 保存 Cookie、LocalStorage 和服务器地址。
- `nodeIntegration` 关闭。
- `contextIsolation` 开启。
- 不向远程页面暴露通用文件系统或进程 API。
- 麦克风权限只对当前服务器 Origin 按用户操作授予。
- 跨 Origin 导航交给系统浏览器。
- 窗口关闭时直接退出应用并断开语音。
- 不实现托盘、开机启动和后台驻留。

Electron 继续使用 Web LiveKit。HTTP 页面中的 Web 麦克风仍受 Chromium 安全上下文限制，首期不通过不安全 Origin 启动参数绕过。需要桌面语音的自建服务器应使用 HTTPS。

## 本地存储与服务器切换

- Web 设置继续保存在服务器 Origin 对应的 `localStorage`。
- Android 壳只保存当前服务器 URL、壳级权限状态和非敏感偏好。
- Electron 使用自身用户数据目录，与系统浏览器完全分离。
- Android WebView 数据与 Chrome 浏览器数据分离。
- 切换服务器不清除其他 Origin 的 Cookie 或 LocalStorage，用户返回原服务器时可继续使用原会话。
- 提供“清除当前服务器数据”能力属于后续壳设置功能，不是首期语音原型的必要条件。

## 后台消息与在线状态

不接入推送服务，因此明确采用以下行为：

- 未通话且应用位于后台时，不保证收到文字消息通知。
- 正在通话时，前台服务通知只表示通话状态，不显示文字消息。
- WebView 仍存活时可能继续收到业务 WebSocket 消息，但这是尽力行为，不构成产品保证。
- 应用回到前台后，通过现有业务 WebSocket 重连和 `GET /api/bootstrap` 恢复未读状态。
- 主动离开语音时调用 `POST /api/servers/{serverID}/voice/leave`。`serverID` 必须取自当前语音连接建立时保存的服务器，而不是客户端此刻正在浏览的服务器。
- 不为了消息通知让常驻服务在未通话时持续运行。

## 服务端影响

原生语音首期预计不修改数据库模型，也不新增消息推送设施。

需要验证而非默认修改的服务端边界：

- 现有 Token 接口是否适合 Android 后台刷新。
- 15 分钟 Token 在长连接和重新连接中的实际行为。
- 会话撤销、封禁、管理员禁言和删除账号是否能及时终止原生 Room。
- Android NativeApiClient 请求的 Cookie、Origin 和代理头是否符合当前部署配置。
- LiveKit Android SDK 与当前 LiveKit Server 版本的兼容性。

只有验证发现现有接口不足时，才新增向后兼容的语音客户端接口。

## 安全边界

允许任意自建服务器不等于向任意网页开放不受限原生能力。最低安全边界如下：

- 原生 Bridge 仅提供语音命令，不提供文件、Shell、任意 HTTP 请求或系统设置写入。
- NativeApiClient 只能访问用户当前配置的服务器 Origin。
- WebView 跨 Origin 后原 Bridge 会话立即失效。
- Token 只保存在内存中，不写入磁盘、日志或崩溃报告。
- TLS 证书错误不自动忽略。
- 麦克风权限由用户明确授予，页面不能绕过 Android 权限对话框。
- 原生壳不替远端服务器背书，HTTP 地址应在配置界面明确标记为非加密连接。

## 测试策略

### Web 回归

- 现有 Playwright Web 语音测试继续覆盖 `WebVoiceRuntime`。
- 为运行时抽象增加浏览器假实现测试，验证 Store 不依赖 LiveKit Web 对象。
- Bridge 不存在时，普通浏览器行为保持不变。
- 协议不兼容时，Android 页面显示明确错误且不创建 Web 麦克风。

### Android 自动化

- Bridge JSON 编解码和版本协商单元测试。
- VoiceService 状态机测试。
- AudioRouteController 逻辑测试。
- Activity 重建、重新绑定和快照恢复测试。
- Cookie 到 NativeApiClient 的传递测试。
- 通知栏静音和退出操作测试。

### Android 实机验收

至少覆盖 Pixel、三星和一类后台限制较强的主流国产设备：

- 锁屏连续双向通话 30-60 分钟。
- Activity 切后台后持续收发语音。
- Wi-Fi 与移动网络双向切换。
- 通话超过 15 分钟后断网并恢复。
- 蓝牙耳机连接、切换和断开。
- 扬声器、听筒和有线耳机切换。
- 来电、闹钟或其他应用抢占 AudioFocus。
- 麦克风权限在连接前拒绝和连接中被撤销。
- 管理员禁言、踢出、封禁和会话撤销。
- 划掉最近任务后 15 秒内不再出现在 LiveKit 房间。
- WebView Activity 被系统重建后正确恢复语音 UI。
- 每用户音量、全局音量和麦克风增益达到声明效果。

### Electron 验收

- Windows 和 Linux 加载服务器、登录和保持独立 Cookie。
- 麦克风权限只授予当前服务器 Origin。
- 窗口关闭后 LiveKit 与业务 WebSocket 断开。
- 外部链接在系统浏览器打开。
- 普通 Web 更新后无需重新构建 Electron 壳即可生效。

## 原型通过标准

Android 原生语音原型必须同时满足：

- 主要测试机型锁屏 30-60 分钟没有可感知的单向断音或持续断线。
- 网络切换后能自动恢复，不需要重启 Activity。
- 蓝牙、扬声器和有线耳机路由符合 UI 显示。
- WebView 暂停不影响原生 Room。
- Activity 重建后语音状态无重复连接、重复成员或错误静音。
- 管理员操作和会话撤销能终止或限制原生语音。
- Token 过期后的后台重连路径明确且可测试。
- 原生麦克风增益和每用户音量达到最终承诺的范围。

任何主要机型不能满足后台语音门槛时，不应通过增加 WebView 保活技巧规避，应在 VoiceService、权限、音频模式或 SDK 使用方式上定位问题。

## 实施阶段

### 阶段 1：协议与 Web 运行时拆分

- 定义 `VoiceRuntime`、快照和事件类型。
- 把现有 LiveKit Web 代码迁入 `WebVoiceRuntime`。
- 保持浏览器功能和 Playwright 测试通过。
- 定义 Bridge v1 消息结构和兼容规则。

### 阶段 2：Android 薄壳

- 创建 Kotlin Android 工程。
- 实现服务器地址配置、WebView、Cookie 和导航策略。
- 实现 Bridge 握手，不接入 LiveKit。
- 验证远程 Web 更新无需重新发布 APK。

### 阶段 3：原生 LiveKit 原型

- 实现 VoiceService、LiveKit Room 和基础 Bridge 命令。
- 实现麦克风权限和前台服务通知。
- 完成加入、退出、静音、参与者快照和重连。
- 完成长时间锁屏实机验证。

### 阶段 4：音频完整性

- 实现 AudioFocus 和音频路由。
- 实现每用户音量和全局音量。
- 实现或明确收敛麦克风增益能力。
- 映射回声消除、降噪和自动增益选项。
- 覆盖管理员禁言、耳机静音和设备变化。

### 阶段 5：Electron 薄壳

- 创建 Electron 工程并加载远程页面。
- 实现服务器地址、权限、导航和窗口关闭行为。
- 构建 Windows 与 Linux 可直接分发产物。

### 阶段 6：发布准备

- 固定 LiveKit Android 与 Electron 依赖版本。
- 完成协议兼容矩阵和最低服务器版本说明。
- 完成 Android 实机清单和桌面验收。
- 更新 README、产品规格和当前技术架构文档。

## 主要风险

| 风险 | 影响 | 缓解方式 |
| --- | --- | --- |
| 麦克风增益无法与 Web 等价 | Android 音频设置行为不一致 | 先做音频原型，按实际能力定义范围 |
| Web UI 更新超过旧壳协议 | 语音不可用或状态错误 | Bridge 版本协商、能力检测和向后兼容 |
| WebView 后台断开业务 WS | 业务在线状态变离线、无实时文字 | 保留现有重连/Bootstrap，明确不保证后台消息 |
| Token 过期后无法后台重连 | 长时间通话网络恢复失败 | NativeApiClient 使用 Cookie 刷新 Token |
| Android 厂商后台策略差异 | 局部机型通话中断 | Foreground Service、实机矩阵、发布支持范围 |
| 蓝牙与音频路由差异 | 错误输出设备或单向音频 | 使用通话音频模式和设备变化实测 |
| 任意远程页面滥用 Bridge | 麦克风或服务被非预期调用 | 顶层 Origin 绑定和窄能力 Bridge |
| HTTP 部署配置不一致 | Cookie、WS 或 LiveKit 无法连接 | 明确部署检查，不引入通用本地代理 |

## 延后决策

以下事项在 Android 原型前或原型中确定，不阻塞当前架构：

- Android 最低系统版本与目标 API Level。
- 应用包名、显示名称和图标资源。
- LiveKit Android SDK 固定版本。
- 麦克风增益最终支持范围。
- 通知栏是否保留静音操作，或只提供打开应用与退出语音。
- 首批正式支持的 Android 品牌和系统版本。
- Electron 打包工具和安装包格式。

## 完成定义

本设计阶段完成不代表原生客户端已经可交付。进入实现前至少需要：

- 本文档评审通过。
- Bridge v1 的 TypeScript/Kotlin 数据结构确定。
- Android 原型测试服务器和 LiveKit 环境可用。
- 实机测试设备范围确定。
- 麦克风增益是否为 Android 首发阻断项得到明确结论。
