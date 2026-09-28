# 语音混音时钟保持 48 kHz interactive；分析图隔离因音质撤回

安卓 Chrome / WebView 上出现双向语音顿卡并伴随「嘣嘣」爆音。0.4.41 曾用三层隔离（分析图不进扬声器、语音中不双采集、采集/播放分上下文）去修。v0.4.40 听感正常，0.4.41 起音质劣化；0.4.45 只把混音时钟改回 0.4.40 仍无改善。

**现行决策：** 语音图与 v0.4.40 对齐。唯一 `{ latencyHint: 'interactive', sampleRate: 48000 }` 上下文给 `webAudioMix`、RNNoise、自动音量平衡测声。分析图（说话检测、TrackActivityMonitor）仍以 `gain=0` 接到 `destination`。说话检测登录后持续自持采集。安卓顿卡另开一轮，不以音质为代价。

## 考虑过的备选

- **只关 RNNoise / 安卓默认系统降噪：** 实机对照只有微小改善，静音只听仍卡，不能当根治；可作为后续策略兜底，本次不做默认值切换。
- **进语音后无条件停掉 VAD：** 静音说话提醒和静音期间的采集边界会回退到 ADR-0024 之前，拒绝。只在「发布链已经占着麦克风」时让出采集。
- **分析图继续接 destination 但统一采样率：** 16 kHz VAD 改 48 kHz 仍会多开一条扬声器流；欠载和 HAL 争用还在。
- **壳里设 `MODE_IN_COMMUNICATION`：** 管不到移动 Chrome，且 AEC 采集已经把设备推进通话模式，不能当主修复。

## 修订

### 安卓采集上下文也用 balanced（发送端 RNNoise 欠载）

播放侧 `balanced` 修好了安卓听别人。残留只在发送端：安卓壳开启增强降噪时对端听到短暂掉字/炸音，系统降噪正常。三种降噪档共用 48 kHz 采集图，差别只有 RNNoise AudioWorklet。采集侧此前只设 `sampleRate: 48000`，`latencyHint` 仍是默认 `interactive`。改为与播放对称：安卓采集 `balanced`，桌面采集当时仍 `interactive`。不把安卓默认降噪改成系统降噪。

### 长驻语音图一律 balanced（桌面 interactive 欠载）

0.4.41 拆开采集/播放后，Electron 桌面变成三条 `interactive` 图（播放、采集/RNNoise、背景音 48 kHz worklet）。当时判断是 audio thread 预算不够。0.4.42「桌面保持 interactive 以免误伤延迟」被 0.4.43 作废。

### 桌面回到单条 48 kHz interactive 图（0.4.43 被听感证伪）

0.4.43 把桌面播放/采集/背景音/分析图一律改成 `balanced`，安卓政策不变。HITL：断续仍在，整体听感更不稳，接收端自动音量平衡忽大忽小。`balanced` 加大播放缓冲，测声与 0.4.41 之前的 48 kHz interactive 混音图不再对齐。改回：桌面混音与 RNNoise 共用一条 48 kHz `interactive` 图；安卓仍拆分 + `balanced`。应用提示音不在此列。

### 按采样率能力分支，取消 OS 适配（0.4.44）

按「安卓 / 桌面」选拓扑是用壳标记和 UA 记住两次 HITL，不能覆盖 44.1 kHz 安卓、锁不住 48 kHz 的桌面、或 iOS。改为只看浏览器真正给出的 `sampleRate`：能 48 kHz 就共用 interactive 混音图；不能就拆一条 48 kHz balanced 采集图。第 1、2 层（分析图不进扬声器、语音中不双采集）对所有端仍成立。应用提示音不在此列。

### 混音时钟回到 v0.4.40（0.4.45）

v0.4.40 听感正常。v0.4.41 把播放改成设备原生采样率并另开 48 kHz 采集图，音质劣化；0.4.42–0.4.44 的 `balanced`、手搓 RNNoise 节点、按采样率再共用，都在这条坏基线上。对照物是 **v0.4.40 标签**，不是 0.4.43。

作废第 3 层（分上下文 / 播放跟设备 / 按采样率共用）以及其后所有 latencyHint / 采样率分叉。唯一语音图恢复 `{ latencyHint: 'interactive', sampleRate: 48000 }`，采集与播放是同一对象。RNNoise 回到库的 `RnnoiseWorkletNode`。背景音恢复 48 kHz `interactive`。第 1、2 层暂留。应用提示音不在此列。

### 第 1、2 层因音质撤回（0.4.46）

v0.4.45 HITL：混音时钟已回到 0.4.40，音质仍劣化。第 1 层（分析图接 `MediaStreamDestination`）和第 2 层（发布时 VAD 让出采集）与 0.4.41 同一提交，现一并撤回：

- 说话检测与 `TrackActivityMonitor` 再以 `gain=0` 接到 `context.destination`（v0.4.40）。
- 引擎登录后持续自持 `getUserMedia`，进语音不再让出采集。

混音时钟仍是单条 48 kHz `interactive`。安卓顿卡/爆音可能回来；音质是硬约束，断续另开一轮。
