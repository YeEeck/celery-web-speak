# 语音分析图不进扬声器，语音中不双采集，采集与播放分上下文

安卓 Chrome / WebView 上出现双向语音顿卡并伴随「嘣嘣」爆音：自己听别人卡、别人听自己也卡；关掉增强降噪只有微小改善，麦克风静音后只听仍然卡。根因不是 RNNoise 算法本身，而是多条 `AudioContext` 同时接到扬声器、语音发布与常开 VAD 叠两条带 AEC 的 `getUserMedia`，以及为 RNNoise 把播放混音也锁成 48 kHz `interactive`。

决策分三层，互不替代：

1. **分析图禁止占用扬声器。** 说话检测引擎（16 kHz）和 `TrackActivityMonitor`（设备默认采样率）原先以 `gain=0` 接到 `context.destination`，在安卓上仍会打开独立播放流，与 48 kHz `webAudioMix` 在 AudioFlinger 里混音、重采样，欠载即顿卡+爆音。改为接到 `MediaStreamAudioDestinationNode`：图继续被调度，不打开扬声器。
2. **已有发布麦克风时 VAD 不再自持采集。** 登录常开（ADR-0024）保留；但频道或通话已经 `getUserMedia` 时，引擎释放自己的采集，消费方改吃注入的说话帧（会话侧活动监测、通话侧 `isSpeaking`）。静音或未进语音时引擎仍自采，静音说话提醒不受影响。禁止两条带 AEC 的采集同时打开。
3. **采集与播放拆成两个 `AudioContext`。** RNNoise 需要 48 kHz，但不应为此把 `webAudioMix` 播放也锁成 48 kHz + `interactive`。播放上下文用设备原生采样率；安卓用 `latencyHint: 'balanced'`，桌面保持 `interactive`。采集/RNNoise 用单独的 48 kHz 上下文，只接到 `MediaStreamDestination`，永不进扬声器。LiveKit `TrackProcessor.init` 传入的房间上下文被采集上下文覆盖。

## 考虑过的备选

- **只关 RNNoise / 安卓默认系统降噪：** 实机对照只有微小改善，静音只听仍卡，不能当根治；可作为后续策略兜底，本次不做默认值切换。
- **进语音后无条件停掉 VAD：** 静音说话提醒和静音期间的采集边界会回退到 ADR-0024 之前，拒绝。只在「发布链已经占着麦克风」时让出采集。
- **分析图继续接 destination 但统一采样率：** 16 kHz VAD 改 48 kHz 仍会多开一条扬声器流；欠载和 HAL 争用还在。
- **壳里设 `MODE_IN_COMMUNICATION`：** 管不到移动 Chrome，且 AEC 采集已经把设备推进通话模式，不能当主修复。

## 修订

无。
