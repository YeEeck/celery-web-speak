# 语音混音保持单条 48 kHz 图；安卓用 balanced 延迟

安卓 Chrome / WebView 上出现双向语音顿卡并伴随「嘣嘣」爆音。0.4.41 曾用三层隔离（分析图不进扬声器、语音中不双采集、采集/播放分上下文）去修。v0.4.40 听感正常，0.4.41 起音质劣化；0.4.45 只把混音时钟改回 0.4.40 仍无改善；0.4.46 撤回第 1、2 层后音质恢复，顿卡回来。0.4.47 给分析图加 none sink：安卓顿卡无改善，桌面出现低概率断续。

**现行决策：** 采集与播放仍是同一条 48 kHz 图，给 `webAudioMix`、RNNoise、自动音量平衡测声。桌面 `latencyHint: 'interactive'`（v0.4.40）；安卓（壳或 UA）改为 `balanced`，不拆图、不改采样率。分析图以 `gain=0` 接到 `destination`。说话检测登录后持续自持采集。不再给分析图换输出设备。

## 考虑过的备选

- **只关 RNNoise / 安卓默认系统降噪：** 实机对照只有微小改善，静音只听仍卡，不能当根治；可作为后续策略兜底，本次不做默认值切换。
- **进语音后无条件停掉 VAD：** 静音说话提醒和静音期间的采集边界会回退到 ADR-0024 之前，拒绝。只在「发布链已经占着麦克风」时让出采集。
- **分析图继续接 destination 但统一采样率：** 16 kHz VAD 改 48 kHz 仍会多开一条扬声器流；欠载和 HAL 争用还在。
- **MediaStreamDestination（0.4.41 第 1 层）：** 图里的样本不到扬声器，但 AudioContext 仍绑默认输出。0.4.45 与让出采集捆在一起，音质劣化。
- **`{ sinkId: { type: 'none' } }`（0.4.47）：** 分析图不打开输出设备。HITL：安卓顿卡无改善，桌面出现低概率断续。0.4.48 撤回。
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

### 分析图用 none sink，不打开输出设备（0.4.47）

v0.4.46 HITL：音质回到 0.4.40，安卓顿卡/嘣嘣回来。0.4.41 第 1 层用 `MediaStreamDestination` 避免把分析样本送进扬声器，但 AudioContext 仍绑默认输出；16 kHz VAD 图会把 HAL 拉到与 48 kHz 混音不同的时钟。第 1、2 层在 0.4.46 捆在一起撤回，无法单独证伪哪一层伤了音质。

本轮只动分析图的输出设备，不动混音、不让出采集、不拆上下文：

- 说话检测与 `TrackActivityMonitor` 的 AudioContext 构造传入 `{ sinkId: { type: 'none' } }`（VAD 仍锁 16 kHz）。图仍 `gain=0` 接到该上下文的 dummy `destination`，worklet / analyser 继续跑。
- 构造选项被忽略或抛掉时，在 `resume` 之前再调 `setSinkId({ type: 'none' })`。两条路都失败才退回旧扬声器绑定（VAD 仍要 16 kHz），不改混音图。
- 不恢复进语音停 VAD 采集。原文「静音只听仍卡」说明双采集不是充分条件。

对照：音质须与 v0.4.46 / v0.4.40 同级；顿卡看安卓双向与静音只听。HITL 必须在安全上下文（HTTPS 或 localhost）；`http://局域网IP` 没有 `setSinkId`，实验会打空。`document.documentElement.dataset.speechDetectionSink` 为 `none` / `speakers` / `unsupported`。

### none sink 被听感证伪（0.4.48）

v0.4.47 HITL：安卓双向顿卡/嘣嘣没有改善；桌面出现概率很低的断续。分析图改输出设备既治不好安卓，又引入桌面回归。撤回 none sink 与 `setSinkId` 补救，说话检测与 `TrackActivityMonitor` 回到 v0.4.46：`gain=0` 接到 `destination`，构造不再传 `sinkId`。混音时钟仍是单条 48 kHz `interactive`。不在本轮恢复让出采集——0.4.41 的让出只在真正发布麦克风时停 VAD，静音只听仍自持采集，解释不了「静音只听仍卡」。

### 安卓混音图改 balanced（0.4.49）

none sink 证伪后，顿卡更像是 48 kHz `interactive` 混音在安卓上欠载，而不是分析图占扬声器。0.4.43 的一律 `balanced` 叠在拆图上，桌面听感变差；本轮只动延迟、不拆图：

- 仍是一条 `{ sampleRate: 48000 }` 图，采集与播放同一对象。
- 安卓（`celeryShell` 或 UA 含 Android）`latencyHint: 'balanced'`；桌面仍 `interactive`。
- 分析图、双采集、RNNoise 节点、播放采样率都不动。

对照：桌面音质与断续须仍像 0.4.46；安卓先听音质，再听双向与静音只听。`document.documentElement.dataset.voiceMixLatency` 为 `balanced` 或 `interactive`。

HITL：安卓顿卡/嘣嘣消除。根因是同一条 48 kHz 图上 `webAudioMix` + RNNoise worklet 填不满 `interactive` 的回调窗口，欠载爆音；`balanced` 加大缓冲，图与采样率不变。0.4.41–0.4.42 里真正止住顿卡的是安卓 `balanced`，隔离层是音质毒药。UA/壳只作「这台 HAL 撑不住 interactive」的代理，不是拓扑分支（ADR-0044 作废的是按 OS 拆图）。
