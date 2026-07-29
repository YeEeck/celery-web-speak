# 应用提示音 module 深化设计

## 目标

把现有 `sounds` store 深化为应用提示音 module：调用方只表达领域事件、设置意图与播放上下文，implementation 统一拥有操作提示音槽位、静音说话提醒的固定反馈、持久化、异步顺序、解码缓存和播放政策。

本设计保持 ADR-0006、ADR-0007、ADR-0008 与 ADR-0009：静音说话提醒不接受音色配置，自定义音效继续使用 IndexedDB、按事件独占槽且允许用户上传。现有浏览器存储键、数据库结构、记录格式与五个系统预置音效保持兼容。

## 领域范围

应用提示音是上位概念，包括：

- 操作提示音：加入语音、退出语音与新文字消息三个可配置事件槽。
- 静音说话提醒：固定双音，只复用总开关、音量、耳机静音和输出设备政策。

应用提示音不包含语音通话中他人的麦克风或背景音。语音与消息 module 负责判断真实领域事件；应用提示音 module 不接收原始 LiveKit、WebSocket、频道或消息状态。

## External seam

external interface 按三类调用意图区分：

```ts
type ApplicationSoundOccurrence =
  | 'voice-self-joined'
  | 'voice-self-left'
  | 'voice-participant-joined'
  | 'voice-participant-left'
  | 'text-message-received'
  | 'muted-speaking-reminder'

interface ApplicationSoundPlaybackContext {
  deafened: boolean
  outputDeviceId: string
}

interface ApplicationSounds {
  readonly settings: ApplicationSoundSettings
  readonly mutedSpeakingReminderAudible: boolean

  signal(occurrence: ApplicationSoundOccurrence): void
  followPlayback(context: ApplicationSoundPlaybackContext): void
}
```

`settings` 提供一个总设置控制对象和三个同形操作提示音槽，不暴露 `localStorage` 键、IndexedDB 记录、Blob、`AudioBuffer`、音符模式、缓存或播放机制参数。

```ts
interface ApplicationSoundSettings {
  readonly master: MasterSoundControl
  readonly operationSounds: readonly OperationSoundControl[]
}

interface MasterSoundControl {
  readonly enabled: boolean
  readonly volume: number
  readonly phase: 'ready' | 'changing'
  readonly issue: SoundIssue | null

  setEnabled(value: boolean): Promise<SoundChangeResult>
  setVolume(value: number): Promise<SoundChangeResult>
}

interface OperationSoundControl {
  readonly event: 'join' | 'leave' | 'message'
  readonly label: string
  readonly enabled: boolean
  readonly choices: readonly SoundChoice[]
  readonly selectedChoice: string
  readonly custom: CustomSoundPresentation
  readonly phase: 'loading' | 'ready' | 'changing'
  readonly issue: SoundIssue | null

  setEnabled(value: boolean): Promise<SoundChangeResult>
  select(choice: string): Promise<SoundChangeResult>
  upload(file: File): Promise<SoundChangeResult>
  removeCustom(): Promise<SoundChangeResult>
  preview(): Promise<SoundChangeResult>
}
```

具体 TypeScript 命名可在不改变上述调用意图和不变量的前提下微调。`ProfilePanel` 直接遍历 `operationSounds`，不再维护三组字段映射、`customBusy` 或 `customError`，也不再导入系统预置 ID 与自定义存储记录类型。

## 责任划分

语音 module 负责：

- 成功加入语音后发出 `voice-self-joined`。
- 真实主动退出语音后发出 `voice-self-left`；空闲状态下重复请求离开不构成事件。
- 排除频道删除、成员资格移除、页面关闭、刷新与异常断线等被动离开。
- 初始参与者同步与重连完成后才报告真实参与者加入或退出。
- 把耳机静音与首选输出设备同步给 `followPlayback`。
- 把 `mutedSpeakingReminderAudible` 与语音连接、主动麦克风静音、服务器语音禁言、提醒独立开关和麦克风权限组合，决定是否运行 VAD。

消息 module 负责：

- 只在当前查看的文字频道收到其他用户新消息时发出 `text-message-received`。

应用提示音 module 负责：

- 把合格领域事件映射到操作提示音槽或固定提醒双音。
- 组合总开关、音量、事件开关、耳机静音、来源、限流与输出设备政策。
- 让每个真实 `voice-self-left` 绕过退出提示音的 300ms 时间窗；不维护语音会话去重状态。

## 状态不变量

- 选中自定义音效时，该槽必须同时拥有已验证、可解码且可播放的自定义音频。
- 自定义音效不存在、无法读取或无法解码时，槽位回退到上一次选择的系统预置音效并修复来源偏好。
- 自动回退不删除 IndexedDB 原始记录。仍可识别的不可用记录不进入可选来源，但设置界面显示文件摘要或通用问题，并保留替换与删除入口。
- 选择或上传自定义音效不改写该槽保留的系统预置音效；删除自定义音效后回退到该预置。
- 不存在自定义记录时按空槽处理，不显示不可用问题。
- 静音说话提醒没有操作提示音槽、系统预置选择、自定义上传或试听入口。

## 异步顺序

- 每个操作提示音槽拥有独立串行队列；不同槽可以并行。
- 启动加载是每槽队列的首项，随后用户操作按发起顺序执行。
- 最后一个成功操作决定最终状态；失败操作保持此前已提交状态。
- 状态只在校验、解码和所需持久化全部成功后提交。
- 事件播放与试听始终读取最后一次已提交且可播放的状态，不读取半完成变更。
- 启动加载期间若发生操作提示音事件，立即使用该槽保留的系统预置音效，不等待加载，也不延迟补播。
- 配置变更期间若发生事件，继续使用变更前已提交来源。
- 同槽进入新设置操作时清除旧问题；不同槽的问题互不影响。

## 持久化与恢复

`localStorage` 与 IndexedDB 不增加事务日志：

- 上传或替换先完成格式、大小、解码与时长验证，再写 IndexedDB，最后选择自定义来源并发布状态。
- 删除先移除 IndexedDB 音频，再选择保留的系统预置音效并发布状态。
- 浏览器在两次写入间终止时，下次启动通过来源归一化恢复到合法且可播放的状态。
- 接受无法完整回滚崩溃前用户意图的代价，不引入 journal、两阶段提交或额外恢复记录。

同一浏览器的多个已打开页面不实时同步设置。每个页面实例独立维护状态与队列，共享存储采用最后写入结果；其他页面重新加载时读取最新值。本阶段不引入 BroadcastChannel、跨页面锁或冲突提示。

## 播放政策

### 操作提示音

- 加入、退出和消息分别拥有独立的 300ms 时间窗。
- 事件通过总开关、事件开关、音量与耳机静音检查后立即占用时间窗，再开始异步输出路由与播放调度。
- 被设置抑制的事件不占用时间窗；已接受但随后播放失败的事件仍占用。
- 每个真实主动退出事件绕过退出提示音时间窗。

### 试听

- 遵守总开关、音量与耳机静音。
- 忽略对应事件的独立开关并绕过 300ms 时间窗。
- 只播放最后一次已提交来源。
- 播放失败作为用户主动操作写入对应槽的问题，不延迟补播。

### 静音说话提醒

- 使用固定双音，遵守总开关、音量与耳机静音。
- 不进入操作提示音时间窗；提醒节奏继续由静音说话提醒 module 拥有。

### 浏览器播放生命周期

- module 创建时启动槽位加载并安装首次交互监听。
- 用户首次交互前无法播放的事件直接跳过，不延迟补播。
- Pinia store 销毁时移除监听、关闭 AudioContext 并释放缓存。
- external interface 不暴露启动、停止、安装或卸载方法。

## 输出设备

- `followPlayback` 每次调用生成新的播放上下文代次，只有最新代次可以更新有效输出。
- 指定设备失败时，本代次回退并记住系统默认输出；后续提示音不对同一失败选择反复调用 `setSinkId`。
- 首选设备变化、语音 module 主动重新同步播放上下文或 AudioContext 重建时重新尝试。
- 旧代次的异步完成不得覆盖较新的设备选择。
- 输出路由失败不穿过 external interface，只记录诊断信息。

## 错误 seam

- 用户主动发起的总设置、槽位设置、上传、替换、删除和试听失败返回结构化 `SoundIssue`，并保存在对应控制投影中。
- 失败不覆盖此前已提交状态。
- 后台领域事件播放失败不要求调用方补偿，不弹 Toast、不重试或补播，只记录诊断信息。
- 问题包含稳定 code 与当前界面可直接展示的中文 message；设置界面不重复编码文件限制与存储错误规则。

## Implementation 与 adapter

文件组织：

```text
web/src/stores/application-sounds.ts
web/src/application-sounds/
  core.ts
  storage.ts
  web-audio.ts
  patterns.ts
```

- `stores/application-sounds.ts` 是唯一生产调用入口，提供 Pinia adapter 与 external interface。
- `core.ts` 拥有状态机、领域事件映射、队列、设置投影与播放政策。
- `storage.ts` 拥有现有 localStorage 与 IndexedDB 格式的生产 adapter。
- `web-audio.ts` 拥有解码、缓存、调度、输出路由和交互解锁的生产 adapter。
- `patterns.ts` 拥有五个系统预置音效与静音说话提醒固定音型。
- 不建立 barrel 文件，不向生产调用方暴露内部工厂或 adapter。

浏览器存储、音频执行、交互状态与时钟均为 local-substitutable 依赖。生产使用浏览器 adapter；测试通过内部工厂使用内存偏好 adapter、内存自定义音效 adapter、可记录音频 adapter、可控交互状态和可控时钟。internal seam 不扩张 external interface。

## 验证

单元测试以 external interface 为 test surface，覆盖：

- 启动加载与上传、删除交错时按发起顺序提交。
- 不可用自定义音效回退并修复来源，不自动删除原始记录。
- 后续失败保留前次成功状态，三个槽可以独立推进。
- 启动或变更期间播放最后已提交来源。
- 总开关、事件开关、音量、耳机静音、试听与静音说话提醒政策。
- 三类独立限流、事件接受时占用时间窗、主动退出绕过限流。
- 输出设备代次、系统默认回退与重试时机。
- 设置问题与后台播放诊断的不同错误 seam。
- module 销毁后的监听与音频资源清理。

E2E 保留少量真实浏览器集成覆盖：

- 设置界面通过同形槽控制上传、选择、试听、替换、删除和不可用状态。
- 自定义音效写入 IndexedDB 并在刷新后恢复。
- Web Audio 生产 adapter 与输出接线可调度声音。
- 主动与被动语音离开、参与者初始同步及当前文字频道消息继续产生正确领域事件。

直接访问 Pinia 私有 `_s`、缓存或 IndexedDB helper 来代替行为断言的测试应删除或改写；只有存储 adapter 兼容性测试检查具体持久化格式。

## 非目标

- 不重做音效设置布局，只增加加载中、更改中、自定义音效不可用与操作失败所需状态。
- 不新增操作提示音事件、系统预置音效或自定义上传池。
- 不提供跨事件复用、跨标签页实时同步、跨浏览器同步或服务端同步。
- 不改变语音通话媒体、静音说话提醒节奏或 VAD implementation。
