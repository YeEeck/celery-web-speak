# 语音设备管理深化为 ctx-adapter 模块（与 ADR 0011 同构）

语音设备逻辑原先全部内联在 1031 行的 voice store 里：权限请求、枚举与 devicechange 监听、偏好持久化、选项构建、切换（含失败回滚）、缺失降级、`applyPreferredDevicesToRoom`、输出路由应用，约 250 行、12 个 ref、4 个模块级 let，零单元测试。决定把它深化为 `useVoiceDevices(ctx)` 模块（`web/src/stores/voice-devices.ts`，与 ADR 0011 的 mute/deafen 模块同构）：一切设备命名的状态与逻辑移入模块，voice store 只剩连接生命周期与跨模块组合。

## Interface

模块返回 12 个只读 refs（`inputDevices`、`outputDevices`、`activeInputId/OutputId`、`preferredInput/OutputId/Label`、`devicePermissionState`、`devicePermissionError`、`deviceChangeError`、`deviceChangeErrorKind`、`deviceChangingKind`、`deviceChangingId`）与 2 个 computed（`inputDeviceOptions`、`outputDeviceOptions`），加领域入口（`switchInput/Output`、`refreshDevices`、`initializeDevices`、`resolvedPreferredDeviceId`、`applyPreferredDevicesToRoom`、`devicePreference`）。外部消费方（VoiceDeviceMenu、ProfilePanel、voice store 内部读取）接口面逐字不变，行为零变化；私有状态（promise 缓存、监听已装标记、降级与回滚细节）留在模块内部。

## ctx seam 划分

浏览器 seam 全部走 ctx adapter：`requestMicPermission`（getUserMedia）、`getLocalDevices`（`Room.getLocalDevices` 静态）、`listenDeviceChange`（`navigator.mediaDevices`）、`supportsOutputSelection`（livekit 静态）、`applyOutputSink`（`setAudioSink` 遍历语音音频元素）。跨模块回调走 ctx：`notifyPreferenceChange`（mute/deafen 的 reconcile 循环）、`onOutputDeviceChanged`（voice store 的 `syncApplicationSoundPlayback` 组合）。localStorage 偏好读写直接引用 voice-utils 纯函数，测试沿用 ADR 0011 harness 的全局假造先例，不进 ctx。

## Considered Options

- **只收交互核心**（switch/回滚/降级），权限与偏好留在 voice store：权限状态机与偏好 ref 仍散在两处，将来改权限流程仍需跨模块跳读，否决。
- **localStorage 也走 ctx**：与 ADR 0011 harness 的全局假造先例重复造轮子，且把纯函数层包进 adapter 无益，否决。
- **输出路由留在 voice store**：`applyOutputSink` 面对的是语音房间的音频元素，属于设备切换的行为，留在 store 则切换结果跨 seam 泄漏，否决。

## 测试

`web/tests/voice-devices.test.ts`：假 Room（带 `switchActiveDevice`/`getActiveDevice`，可注入失败与"切换未生效"）+ 假浏览器 seam，覆盖切换成功/失败回滚/重入拒绝/输出不支持/无房间纯偏好路径/不可用选项/会话竞态/枚举降级/偏好应用/权限两态/监听只装一次/偏好落盘回调。
