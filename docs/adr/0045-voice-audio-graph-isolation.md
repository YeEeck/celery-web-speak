# 语音分析图不进扬声器，语音中不双采集，采集与播放分上下文

安卓 Chrome / WebView 上出现双向语音顿卡并伴随「嘣嘣」爆音：自己听别人卡、别人听自己也卡；关掉增强降噪只有微小改善，麦克风静音后只听仍然卡。根因不是 RNNoise 算法本身，而是多条 `AudioContext` 同时接到扬声器、语音发布与常开 VAD 叠两条带 AEC 的 `getUserMedia`，以及为 RNNoise 把播放混音也锁成 48 kHz `interactive`。

决策分三层，互不替代：

1. **分析图禁止占用扬声器。** 说话检测引擎（16 kHz）和 `TrackActivityMonitor`（设备默认采样率）原先以 `gain=0` 接到 `context.destination`，在安卓上仍会打开独立播放流，与 48 kHz `webAudioMix` 在 AudioFlinger 里混音、重采样，欠载即顿卡+爆音。改为接到 `MediaStreamAudioDestinationNode`：图继续被调度，不打开扬声器。
2. **已有发布麦克风时 VAD 不再自持采集。** 登录常开（ADR-0024）保留；但频道或通话已经 `getUserMedia` 时，引擎释放自己的采集，消费方改吃注入的说话帧（会话侧活动监测、通话侧 `isSpeaking`）。静音或未进语音时引擎仍自采，静音说话提醒不受影响。禁止两条带 AEC 的采集同时打开。
3. **采集与播放按实际采样率分支，不按 OS。** 媒体时钟是 48 kHz（Opus、RNNoise、自动音量平衡标定）。播放先请求 48 kHz `interactive`；浏览器真给了 48 kHz 则采集复用同一对象（混音、RNNoise、测声同一时钟）。给不出则播放保持该原生混音图，RNNoise 另开 48 kHz `balanced` 图，只接到 `MediaStreamDestination`，永不进扬声器。LiveKit `TrackProcessor.init` 传入的房间上下文被采集上下文覆盖。不读 UA、不读 `celeryShell`。

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
