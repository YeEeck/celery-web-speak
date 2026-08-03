# 发送端降噪采用 RNNoise 客户端管线，拒绝 Krisp 集成

自托管 LiveKit 部署需要优于 WebRTC `noiseSuppression` 的发送端降噪。Krisp 官方前端集成（`@livekit/krisp-noise-filter`）在启用时请求 `{SFU}/settings` 并要求返回 `enhancedNoiseCancellation: true`，该授权检查端点仅存在于 LiveKit Cloud——自托管服务器（源码验证）没有此路由，且模型权重为私有、不可绕过授权使用；DeepFilterNet 等开源 SOTA 模型缺少生产级浏览器 WASM 实现。决策：采用 RNNoise（WASM + AudioWorklet）客户端管线，麦克风始终经过统一管线（降噪 worklet + 增益节点同图），降噪选项控制启用/直通，切换即时生效；加载失败静默回退到系统降噪，设置不变量、下次会话仍尝试。

“即时生效”不以重新加入语音为边界。已发布麦克风时，选项变化立即重建当前采集轨并重新应用 `noiseSuppression` 约束；同一个 `MicrophonePipelineProcessor` 实例继续承载增益和降噪管线，因此不会因为设置切换而丢失处理器状态。这样 WebRTC 约束与 RNNoise 管线在每次选择变化后保持同刻，不接受旧约束继续作用造成双重降噪。

RNNoise 能力按当前采集会话单独判定。WASM 加载、AudioWorklet 注册或节点实例化失败时，处理器保持直通并将当前采集轨切换到 WebRTC `noiseSuppression: true`；`rnnoise` 偏好不改写。离开语音后下一次会话重新尝试加载和注册，失败不能永久阻塞后续重试。

RNNoise 是单声道语音增强算法，管线中强制 worklet 节点输入单声道（`channelCountMode: 'explicit'` + `channelCount: 1`）。若不强制，立体声麦克风轨（部分浏览器默认 2 声道）会让 worklet 输出保持 2 声道而仅写入左声道，右声道静音，对端只能听到左声道。强制单声道后输出随输入为单声道，链路下游（增益→MediaStream 目标）保持单声道，对端正常混音；同时单实例 RNNoise 的 CPU 开销恒定。

采集约束显式声明 `voiceIsolation: false`。LiveKit 的 `audioCaptureDefaults` 默认请求 `voiceIsolation: true`（Chromium 的浏览器 AI 语音隔离预处理），若不覆盖，浏览器会在 getUserMedia 内部对麦克风做一轮应用不可见、不可控的隔离：它游离于"降噪选项"三值语义之外（用户选"关闭"时仍在隔离），且与 RNNoise/WebRTC 形成双重降噪，实测会干扰 RNNoise 的 VAD 判定。降噪责任完全由"降噪选项"管辖，浏览器不做这层处理。

## Considered Options

- **Krisp 官方集成（@livekit/krisp-noise-filter）**：质量最好，但启用授权绑定 LiveKit Cloud，自托管部署必然失败；伪造授权端点属绕过机制且模型权重私有，拒绝。
- **DeepFilterNet**：开源质量最高，但浏览器实时 WASM 端口没有生产级维护方案，拒绝。
- **WebRTC noiseSuppression**：保留为"系统降噪"选项与回退目标，不作为主方案。
