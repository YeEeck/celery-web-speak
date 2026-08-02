# 发送端降噪采用 RNNoise 客户端管线，拒绝 Krisp 集成

自托管 LiveKit 部署需要优于 WebRTC `noiseSuppression` 的发送端降噪。Krisp 官方前端集成（`@livekit/krisp-noise-filter`）在启用时请求 `{SFU}/settings` 并要求返回 `enhancedNoiseCancellation: true`，该授权检查端点仅存在于 LiveKit Cloud——自托管服务器（源码验证）没有此路由，且模型权重为私有、不可绕过授权使用；DeepFilterNet 等开源 SOTA 模型缺少生产级浏览器 WASM 实现。决策：采用 RNNoise（WASM + AudioWorklet）客户端管线，麦克风始终经过统一管线（降噪 worklet + 增益节点同图），降噪选项控制启用/直通，切换即时生效；加载失败静默回退到系统降噪，设置不变量、下次仍尝试。

## Considered Options

- **Krisp 官方集成（@livekit/krisp-noise-filter）**：质量最好，但启用授权绑定 LiveKit Cloud，自托管部署必然失败；伪造授权端点属绕过机制且模型权重私有，拒绝。
- **DeepFilterNet**：开源质量最高，但浏览器实时 WASM 端口没有生产级维护方案，拒绝。
- **WebRTC noiseSuppression**：保留为"系统降噪"选项与回退目标，不作为主方案。
