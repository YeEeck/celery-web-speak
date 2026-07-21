# Celery Web Speak 应用背景音设计

> 状态：方案已确认，尚未实施。
>
> 设计日期：2026-07-21。
>
> 当前服务端与 Web 实现基线：v0.2.0。

## 背景

用户希望把 Windows 中指定应用的音频作为独立背景音发布到当前语音频道。分享者必须主动选择目标窗口；系统不得自动枚举后静默捕获，也不得在目标能力不可用时退化为全部系统音频。

浏览器的 `getDisplayMedia` 可以可靠捕获标签页音频，但当前 Chromium 没有完整实现 `windowAudio: "window"`。选择普通应用窗口时，浏览器可能只提供全部系统音频，返回的音轨也不能证明音频已按窗口隔离。因此普通浏览器不能满足本设计的隐私边界。

Windows Electron 客户端使用 WASAPI Process Loopback 捕获目标窗口所属进程树的音频。该能力与 OBS Application Audio Capture 使用的系统机制相同，不需要虚拟声卡、驱动、管理员权限或向目标进程注入代码。

## 目标

- Windows Electron 客户端允许已加入语音频道的用户主动选择一个应用窗口并共享其进程树音频。
- 背景音作为独立 LiveKit 音轨发布，不与麦克风在客户端混成一轨。
- 分享者独立控制背景音播放、暂停、停止和发送音量。
- 听众现有的用户音量与总输出音量同时作用于背景音。
- 管理员语音禁言同时禁止麦克风和背景音，背景音不能绕过现有权限。
- 窗口标题、应用名称、图标和缩略图只在 Electron 本地选择器中使用，不发送给服务器、LiveKit 或其他成员。
- 普通浏览器、Linux Electron 和能力检测失败的 Windows 客户端完全隐藏功能入口。

## 非目标

- 不在普通浏览器中捕获 Windows 应用音频。
- 不捕获全部系统音频，不提供失败后的系统音频回退。
- 不保证同一进程内的多个窗口或同一进程树内的多个音源可以进一步隔离。
- 不支持同一用户同时共享多个应用音源。
- 不提供管理员单独禁止背景音但保留麦克风的权限。
- 不安装或引导安装虚拟声卡。
- 不支持 Windows 10 2004 之前的版本。
- 不在 Linux、Android 或 macOS 客户端实现应用音频采集。
- 不传输、录制或持久化目标窗口的画面。

## 已确认决策

| 决策项 | 结论 |
| --- | --- |
| 客户端 | Windows Electron |
| 最低系统 | Windows 10 2004 Build 19041，最终以运行时能力检测为准 |
| 采集机制 | WASAPI Process Loopback，包含目标 PID 及其子进程 |
| 选择粒度 | 用户选择窗口，实际音频边界为窗口所属进程树 |
| 原生承载 | Electron `utilityProcess` 加载 Windows x64 N-API 模块 |
| 目标选择器 | Electron 本地模态窗口，只列应用窗口 |
| 每用户轨道数 | 最多一路背景音 |
| 同频道分享者 | 允许多人同时分享 |
| LiveKit 来源 | `screen_share_audio` |
| 编码 | Opus、立体声、遵循频道码率、关闭 DTX 与语音处理 |
| 发送音量 | 0%-100%，默认 50%，当前客户端本地持久化 |
| 听众音量 | 分享者发送增益 x 听众用户音量 x 听众总输出音量 |
| 权限 | 所有未被语音禁言的成员均可使用 |
| 远端状态 | 播放时显示音乐图标，暂停时隐藏 |
| 发言状态 | 只由麦克风决定，背景音不触发说话高亮 |
| 窗口信息 | 只在本地选择器中展示，不进入媒体或业务协议 |

## 总体架构

```text
+-------------------------- Windows Electron --------------------------+
|                                                                       |
|  Local source picker                                                  |
|    Electron desktopCapturer                                           |
|    title / icon / thumbnail                                           |
|                | selected DesktopCapturerSource.id                    |
|                v                                                      |
|  Electron main process                                                |
|    validate sender / origin / HWND                                    |
|    own capture session lifecycle                                      |
|                | HWND + control MessagePort                           |
|                v                                                      |
|  utilityProcess                                                       |
|    N-API WASAPI Process Loopback                                      |
|    48 kHz stereo float PCM                                            |
|                | transferable PCM blocks                              |
|                v                                                      |
|  restricted remote preload bridge                                    |
|                | DOM MessagePort                                      |
|                v                                                      |
|  AudioWorklet ring buffer -> GainNode -> MediaStreamAudioDestination  |
|                | MediaStreamTrack                                     |
+----------------|------------------------------------------------------+
                 v
       LiveKit screen_share_audio
                 |
                 v
          current voice room
```

Go 不接收、混合或转码 PCM。LiveKit 继续作为 SFU 转发麦克风和背景音轨。SQLite 不增加背景音表或状态字段。

## 产品行为

### 功能入口

- 背景音按钮位于底部用户控制区，与麦克风、耳机静音和断开语音并列。
- 只有已经加入语音频道、未被语音禁言且桌面 Bridge 报告支持应用音频时才显示按钮。
- 普通浏览器、Linux Electron、旧桌面客户端和运行时能力检测失败的 Windows 客户端不显示按钮，也不展示功能说明占位。
- 旧 Web 连接到新桌面客户端时不会使用 Bridge；新 Web 连接到旧桌面客户端时根据能力缺失隐藏入口。

### 选择应用

用户点击背景音按钮后，Electron 打开本地模态选择器：

- 使用 `desktopCapturer.getSources({ types: ['window'] })` 获取窗口。
- 显示窗口缩略图、应用图标和窗口标题。
- 排除 Celery Web Speak 自身窗口和无效来源。
- 不列出显示器或“整个屏幕”。
- 选择器数据不进入远程服务器页面；远程页面只收到采集会话是否开始的结果。
- 取消选择不改变当前语音连接。

每次开始新共享都必须由用户重新选择。已有背景音会先停止并释放，再打开新选择器，不允许在一个用户会话内混合多个目标。

### 控制面板

共享成功后，背景音按钮打开紧凑控制面板，包含：

- 播放/暂停切换。
- 停止共享。
- 发送音量滑块，范围 0%-100%。

发送音量默认 50%，保存在当前客户端的 `localStorage`。发送音量只改变发布到频道的增益，不改变目标应用在分享者电脑上的本地播放音量。0% 保持共享会话和音轨存在，但发送静音信号。

### 远端展示与音量

- 背景音正在播放时，成员列表在发送者旁显示音乐图标。
- 背景音暂停或发送者停止共享时不显示图标。
- 不显示目标程序、窗口或媒体名称。
- 听众现有的用户音量同时应用于该用户的麦克风轨和背景音轨。
- 听众实际背景音增益为分享者发送增益、该发送者用户音量和听众总输出音量的乘积。
- 背景音不得让发送者持续显示为正在说话。发言状态只使用麦克风音轨；若 LiveKit 的参与者聚合状态包含背景音，Web 客户端应改为只检测麦克风轨。

## 采集语义

### 窗口与进程树

Electron 的 `DesktopCapturerSource.id` 在 Windows 上包含窗口 `HWND`。主进程校验用户选择的来源后，把 HWND 的十进制字符串交给原生采集层，由原生层按指针宽度解析并取得目标 PID；JavaScript 层不得先把 64 位 HWND 转为 `number`。采集使用：

```text
ActivateAudioInterfaceAsync
VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
```

采集范围是目标 PID 及其子进程，不是单个 `HWND`。以下行为属于已接受限制：

- 同一进程拥有多个窗口时，多个窗口的声音可能一起被捕获。
- 选择 Chrome、Edge 等多进程浏览器时，可能包含同一浏览器进程树的其他窗口或标签页音频。
- 目标应用把音频渲染交给不属于目标进程树的独立服务时，可能只能得到静音。
- 受保护媒体、特殊音频引擎或部分反作弊程序可能不兼容。

不兼容时停止本次共享并显示可操作错误，不捕获全部系统音频作为回退。

### 系统兼容

微软公开文档把 Process Loopback 结构标记为较高 Windows Build，但 OBS 已在 Windows 10 2004 Build 19041 及以上启用相同机制。本项目采用两级检测：

1. 系统版本低于 Windows 10 2004 时直接报告不支持。
2. 动态加载接口并执行最小初始化探测；接口不存在或初始化失败时报告不支持。

不能只根据 User-Agent、Electron 版本或 Windows 版本号宣称支持。正式验收至少覆盖 Windows 10 22H2 Build 19045 与当前 Windows 11 稳定版。

### PCM 格式

- 原生层输出 48 kHz、双声道、32-bit float PCM。
- 原生采集线程写入有界环形缓冲，不在实时线程等待 JavaScript。
- utilityProcess 按固定帧块通过 MessagePort 转移 `ArrayBuffer` 所有权。
- AudioWorklet 使用有界环形缓冲吸收 IPC 抖动；欠载时输出静音，过载时丢弃最旧帧。
- PCM 流不得通过普通高频 `ipcRenderer.send` 逐块传输。
- 停止会话时清空原生与 AudioWorklet 缓冲，防止旧会话尾音进入新目标。

具体帧长、缓冲上限和欠载阈值在原型中根据端到端延迟与稳定性确定，不在设计阶段硬编码。

## LiveKit 媒体设计

### 发布权限

未被语音禁言的加入令牌允许：

```text
microphone
screen_share_audio
```

动态解除禁言时恢复同一来源集合；语音禁言时把 `CanPublish` 设为 false，并清空可发布来源。背景音不能使用 `microphone` 来源伪装发布。

服务端不根据 User-Agent 或客户端声明决定授权。普通浏览器虽然可以获得相同来源权限，但共用 Web UI 在没有兼容 Bridge 时不提供功能入口；服务端权限的业务边界仍是“所有未被语音禁言的成员可以发布背景音”。

### 发布参数

背景音作为独立 `screen_share_audio` 音轨发布：

- `maxBitrate` 使用当前语音频道的 `audioBitrateKbps`。
- 强制立体声。
- 关闭 DTX。
- 不应用麦克风回声消除、降噪、自动增益或麦克风增益处理器。
- 网络冗余策略沿用项目的 LiveKit 音频兼容策略，并在真实丢包测试中验证额外带宽。

频道设置为 32-64 kbps 时，立体声音乐质量下降属于频道码率选择的直接结果，不另设背景音码率字段。

### 订阅与播放

当前客户端会附加所有远端音频轨，但音量只按 `microphone` 来源设置。实施时应：

- 明确识别 `screen_share_audio` publication。
- 把同一用户的保存音量同时应用到 `microphone` 和 `screen_share_audio`。
- 耳机静音与总输出音量同时作用于两类轨道。
- 背景音暂停时根据 publication muted 状态隐藏音乐图标。
- 轨道取消发布或参与者离开时立即移除对应元素和状态。

## 状态机

### 状态

```text
unsupported
idle
selecting
starting
playing
paused
stopping
error
```

- `unsupported`：Bridge 缺失、平台不支持或原生探测失败；入口隐藏。
- `idle`：支持能力，但没有共享。
- `selecting`：本地选择器已打开。
- `starting`：已选目标，正在启动 utilityProcess、WASAPI 和 Web 音轨。
- `playing`：正在捕获并发布。
- `paused`：保留目标与 publication，但原生采集暂停、音轨 muted。
- `stopping`：正在取消发布并释放原生资源。
- `error`：本次会话失败，完成清理后回到 `idle`。

所有异步响应和事件必须携带随机 `sessionId` 与单调递增的 `revision`。Web 只接受当前会话且 revision 不小于已应用版本的状态，丢弃旧会话的延迟 PCM、错误和停止事件。

### 暂停与耳机静音

- 用户手动暂停时保留目标窗口和采集会话，不要求重新选择。
- 开启耳机静音时，若背景音正在播放则自动暂停，并记录“由耳机静音暂停”。
- 取消耳机静音时，只恢复此前由耳机静音自动暂停的背景音。
- 背景音原本已由用户手动暂停时，耳机静音开启和关闭均不得自动恢复。
- 麦克风静音与背景音播放互不联动。

### 停止条件

以下情况彻底停止共享并释放目标：

- 用户点击停止共享。
- 主动离开语音频道或切换语音频道。
- 退出登录。
- 远程页面刷新、导航、崩溃或销毁。
- Electron 主窗口关闭或切换服务器。
- 管理员对用户执行语音禁言。
- 目标 `HWND` 被销毁。
- 目标进程退出。
- utilityProcess 或原生采集模块异常退出。
- LiveKit 明确拒绝或撤销背景音发布权限。

目标程序退出、崩溃或以新 PID 重启后不得按可执行文件自动跟随，用户必须重新选择。

以下情况不停止共享：

- 目标窗口失去焦点、被遮挡或普通最小化。
- 目标程序隐藏到系统托盘但原窗口句柄与进程仍存在。
- 切换 Windows 虚拟桌面。
- LiveKit 短暂断线并进入自动重连。

LiveKit 重连成功后恢复原 publication；如果原生目标已经失效，则以停止共享为准，不恢复到其他进程。

## Desktop Bridge

### 安全边界

现有 Electron 远程页面不加载 preload。实施背景音时只为远程 `WebContentsView` 增加背景音专用 preload：

- 保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` 和 `webSecurity: true`。
- 只暴露版本协商、状态查询、开始、暂停、继续、停止和事件订阅。
- 不暴露 `ipcRenderer`、文件系统、进程、窗口枚举、PID、HWND 或任意 IPC 通道。
- Main 必须验证消息来自当前远程 WebContents 的顶层 frame，且 URL Origin 等于当前配置服务器 Origin。
- 跨 Origin 页面、子 frame、本地选择器和弹窗不能调用背景音 Bridge。
- 每次开始共享都打开本地选择器，远程页面不能传入 PID、HWND 或预选来源。
- Main 同一时间最多持有一个本地用户背景音会话。

窗口选择器属于 Electron 本地受信界面。远程页面只能请求打开选择器，不能读取候选窗口列表，也不能获得用户选择的标题、图标、缩略图、HWND 或 PID。

### 能力协商

概念接口如下，实际 TypeScript 命名在实施时确定：

```ts
interface DesktopApplicationAudioBridge {
  hello(options: { minProtocol: number; maxProtocol: number }): Promise<{
    protocol: number
    capabilities: string[]
  }>

  getSnapshot(): Promise<ApplicationAudioSnapshot>
  start(): Promise<ApplicationAudioSnapshot>
  pause(sessionId: string): Promise<ApplicationAudioSnapshot>
  resume(sessionId: string): Promise<ApplicationAudioSnapshot>
  stop(sessionId: string): Promise<ApplicationAudioSnapshot>
  subscribe(listener: (event: ApplicationAudioEvent) => void): () => void
}
```

PCM 端口不经过 `contextBridge` 普通回调，具体交付格式见下文“PCM Port 页面事件”。

首版能力名称为：

```text
application_audio_capture
application_audio_source_picker
application_audio_pcm_port
```

Bridge 使用整数主版本。相同主版本只增加可选字段或能力，不改变已有字段语义。协议不兼容时 Web 隐藏功能入口，不退化为未知 IPC 调用。

### 快照

```ts
interface ApplicationAudioSnapshot {
  sessionId: string | null
  revision: number
  state: 'idle' | 'selecting' | 'starting' | 'playing' | 'paused' | 'stopping' | 'error'
  supported: boolean
  error: ApplicationAudioError | null
}
```

快照不得包含窗口标题、应用名、路径、PID、HWND 或可执行文件信息。

### PCM Port 页面事件

PCM Port 不经过 Bridge 的 Promise 返回值或高频回调传输。remote preload 收到 Main 通过
`webContents.postMessage` 转交的 port 后，使用同窗口 `postMessage` 向 main world 转交一次：

```ts
interface ApplicationAudioPcmPortMessage {
  type: 'celery:application-audio:pcm-port'
  protocol: 1
  sessionId: string
}

window.postMessage(message, window.location.origin, [pcmPort])
```

Web 只接受 `event.source === window`、`event.origin === window.location.origin`、协议版本与当前
Bridge 协商版本一致且 `event.ports.length === 1` 的消息。port 必须与当前 `sessionId` 匹配；旧会话、
重复 port 和未知消息立即关闭。该事件不包含窗口或进程身份信息。

preload 必须在调用 `start()` 的 Promise 完成前后都允许 port 到达；Web 因此按 `sessionId` 暂存
至多一个尚未消费的 port。Web 完成 LiveKit 发布后持有该 port，停止、失败、离开频道或页面卸载时关闭。
创建 AudioWorklet 管线或收到当前 session 快照不代表 port 已附加；只有首个 port 已实际转交给
AudioWorklet 后，后续同 session port 才能按重复消息关闭。快照、`start()` 返回值与页面
`MessageEvent` 三者均不得假设固定到达顺序。

### 初始错误码

- `unsupported_platform`
- `unsupported_windows_version`
- `process_loopback_unavailable`
- `source_picker_cancelled`
- `source_unavailable`
- `source_process_exited`
- `capture_start_failed`
- `capture_stream_failed`
- `bridge_incompatible`
- `voice_not_connected`
- `voice_publish_forbidden`
- `livekit_publish_failed`
- `capture_worker_exited`

取消选择属于正常结果，不应显示错误通知。错误码用于程序分支，中文消息用于当前 UI 展示；Web 不依赖 HRESULT、Electron 或原生模块异常文本。

## 音量与带宽

发送端使用 `GainNode` 在发布前调整背景音增益。该增益不会路由回分享者的本地扬声器，分享者继续通过目标应用和 Windows 音量控制听取原声音频。

频道通常有 5-10 人，且一般只有一人共享背景音。以 128 kbps Opus 和网络封装开销估算：

- 分享者额外上传约 150-200 kbps。
- 每位听众额外下载约 150-200 kbps。
- 10 人房间、一路背景音的 LiveKit 额外出站约 1.35-1.8 Mbps。

LiveKit 不转码或服务端混音，服务器 CPU 主要增加包转发。多人同时分享时，带宽按“背景音轨数 x 听众数”线性增长。

## 安全与隐私

- 原生采集只接受本地选择器产生并由 Main 校验的 HWND。
- 用户每次开始新共享都必须进行本地选择，不记住或自动重新绑定目标。
- 原生模块不接触 Cookie、账号密码、服务器地址或 LiveKit Token。
- utilityProcess 不发起网络请求。
- PCM 只通过内存中的 MessagePort 传给当前远程 WebContents，不写入磁盘。
- 不记录窗口标题、应用名、可执行文件路径、PID、HWND、PCM 内容或媒体统计原始数据。
- 日志可以记录稳定错误码、会话阶段、采样格式和丢帧计数，但不得记录目标身份。
- 服务端和其他参与者只看到通用 `screen_share_audio` publication 与播放/暂停状态。
- 管理员语音禁言是最高优先级；本地操作和 Bridge 不能恢复被服务端撤销的发布权限。

## 测试策略

### Go 与 Web 自动化

- 加入令牌对正常用户同时授权 microphone 和 screen_share_audio。
- 语音禁言动态清空全部发布来源，解除后恢复两个来源。
- 普通浏览器和无 Bridge 环境隐藏背景音按钮。
- Bridge 协议不兼容和能力缺失时隐藏入口。
- 背景音状态机覆盖选择取消、开始、暂停、继续、停止、旧事件丢弃和重复操作。
- 耳机静音只恢复此前自动暂停的背景音。
- 离开、切换频道、退出登录和页面卸载停止背景音。
- 远端音乐图标只在 screen_share_audio 播放时出现。
- 用户音量和总输出音量同时应用到麦克风与背景音。
- 背景音不触发麦克风说话高亮。
- 频道码率变化时背景音使用新码率重新发布或更新发送参数。

### Windows 原生自动化

- 构建一个可控的测试音源进程，持续输出已知频率的立体声正弦波。
- 选择测试进程后，原生模块收到非静音 PCM，且频率、声道和采样率符合预期。
- 同时播放另一无关进程，捕获数据不得包含其测试频率。
- 目标子进程音频被包含，非目标进程音频被排除。
- 暂停停止 PCM，继续恢复同一目标。
- HWND 销毁或目标进程退出后产生稳定停止事件。
- 最小化、隐藏和失焦不停止采集。
- utilityProcess 崩溃不退出 Electron 主进程，并向 Web 报告稳定错误。
- PCM 环形缓冲覆盖欠载、过载、停止清空和旧 session 丢弃。

### Windows 实机矩阵

至少覆盖：

- Windows 10 22H2 Build 19045。
- 当前 Windows 11 稳定版。
- 普通桌面播放器。
- Chrome 或 Edge 多进程浏览器窗口。
- 游戏或 GPU 加速应用。
- 目标切换输出设备、最小化到任务栏和隐藏到托盘。
- LiveKit 短暂断网重连。
- 管理员语音禁言期间正在播放的背景音。

受保护媒体和已知不兼容程序只验证能够安全失败，不要求绕过系统保护。

## 发布与兼容顺序

该功能横跨主仓库和桌面仓库，推荐顺序：

1. 先发布服务端与 Web：增加 LiveKit 来源权限、Bridge 适配和隐藏入口。旧桌面客户端因无能力而不显示功能。
2. 再发布 Windows Electron：增加 Bridge、选择器、utilityProcess 和原生模块。连接旧服务器时旧 Web 不调用 Bridge。
3. Windows 实机矩阵通过后再把能力标记为正式可用。

服务端与桌面客户端不要求锁步升级。Bridge 能力协商和默认隐藏保证任一侧先升级都不会暴露不可用入口。

## 实施阶段

### 阶段 1：文档与原型

- 固定跨仓库协议、权限和生命周期。
- 在 Windows CI 构建最小 N-API Process Loopback 模块。
- 完成“测试音源 -> utilityProcess -> MessagePort -> AudioWorklet”链路。
- 在 Windows 10 19045 和 Windows 11 验证进程隔离。

### 阶段 2：服务端与 Web 媒体

- 扩展 LiveKit Token 与动态禁言来源。
- 实现背景音 Web 状态机、AudioWorklet、发送增益和 publication。
- AudioWorklet 模块必须作为同源静态资源发布，禁止被构建工具内联为 `data:` URL；发布验收需要检查产物中存在独立 worklet 文件。
- 扩展远端音量、音乐状态与麦克风说话检测。
- 完成无 Bridge 环境的隐藏与回归测试。

### 阶段 3：Electron 集成

- 增加受限远程 preload 与版本化 Bridge。
- 实现本地窗口选择器和 Main 来源校验。
- 接入 utilityProcess、N-API 模块和 PCM MessagePort。
- 处理窗口/进程结束、worker 崩溃与应用生命周期。

### 阶段 4：验收与发布

- 完成 Windows 自动化与实机矩阵。
- 验证安装器、便携 ZIP 和 Linux AppImage 不受影响。
- 先发布服务端/Web，再发布 Windows Electron。

## 主要风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Windows 10 2004 属于实测支持、微软文档标注更保守 | 部分系统初始化失败 | 版本预检加运行时探测，覆盖 19045 实机 |
| 应用音频不在目标进程树 | 捕获静音或缺少部分声音 | 明确错误，不回退系统音频，记录兼容矩阵 |
| 多窗口、多进程应用共享进程树 | 捕获范围大于单窗口 | 本地 UI 使用“应用音频”措辞，文档明确边界 |
| PCM IPC 抖动 | 爆音、间断或延迟 | utility 与 AudioWorklet 两级有界缓冲和统计 |
| 原生模块崩溃 | 背景音中断 | 放在 utilityProcess，主应用保持运行 |
| 远程 preload 扩大攻击面 | 服务器页面调用本地能力 | 精确 Origin、顶层 frame、固定命令、本地选择器和 Main 二次校验 |
| 背景音影响活跃说话人 | 成员持续高亮 | 只根据麦克风轨计算说话状态 |
| Windows 原生构建影响跨平台发布 | Linux 包失败或误带模块 | 仅 Windows job 编译和打包，Linux 能力固定缺失 |

## 参考资料

- [Microsoft Application Loopback Audio Capture Sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Microsoft AUDIOCLIENT_ACTIVATION_PARAMS](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params)
- [OBS Application Audio Capture Guide](https://obsproject.com/kb/application-audio-capture-guide)
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [MDN MediaDevices.getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

## 完成定义

满足以下条件后才可宣称功能完成：

- Windows 10 19045 与 Windows 11 均通过目标进程隔离实测。
- 无关进程音频不会进入背景音轨。
- 选择器、Bridge 和日志不泄露窗口身份到远程页面或服务器。
- 背景音的开始、暂停、恢复、停止、耳机静音、语音禁言和重连行为符合本文状态机。
- 麦克风与背景音可以同时发布，且背景音不触发说话高亮。
- 听众用户音量与总输出音量正确作用于两类音轨。
- utilityProcess 异常不会退出客户端或破坏麦克风通话。
- 普通浏览器、Linux Electron、旧客户端和不支持的 Windows 环境不显示入口。
- Windows 安装器与便携 ZIP 包含可加载的原生模块，Linux AppImage 构建与现有功能回归通过。
