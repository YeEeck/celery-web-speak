# 语音通话走麦克风发布链编排器：每条连接一个实例

ADR-0032 让用户同时占频道房间与通话房间。麦克风发布链编排器仍是单 target（一个 processor、一套会话代际），只接在频道会话上；通话自己拼采集约束并 `setMicrophoneEnabled`。CONTEXT.md 把编排器定为发布麦克风的入口，选「增强降噪」时通话既无 RNNoise 也无 WebRTC 降噪，麦克风增益也不到通话。

## 决策 1：两条连接、两个实例，不把编排器改成多 target

频道会话与通话会话各自 `new` 一条编排器，同一 interface（`beginSession` / `endSession` / `applyMicrophoneState` / `setGain` / `buildCaptureOptions`），各自的 processor 与 `session`/`revision` 守卫。LiveKit `TrackProcessor` 一轨一图，不能把同一个 processor 挂到两条发布轨上。否决一个实例扇出 N 个 target：频道测试会背上通话竞态，而两条连接的会话代际本就独立。

## 决策 2：通话走整条发布链

通话 join 后 `beginSession`，启用/重发布/降噪切换/RNNoise 回退/麦克风增益全部经该实例。发布设置：码率与 RED 保持通话现有的 64 kbps + RED；传输模式跟全局偏好。回退粘滞按实例隔离——通话是新会话，按 ADR-0025 重新尝试增强降噪。

不在这一刀：回声抑制变更后重发布（频道侧同样只写 localStorage）；通话中切换首选输入设备（属语音设备管理）。

## 决策 3：通话 `enabled` 与频道作用域耳机静音隔离

`mute-deafen` 的 `applyMicrophoneState` 仍只打频道编排器。通话侧 `enabled = 麦克风静音偏好开启 ∧ ¬全局耳机静音`。频道作用域耳机静音、服务器语音禁言不进入通话公式。降噪 / 增益 / 传输模式由 `voice.ts` 现有 setter 同时转给两个实例；通话 idle 时无 target，与编排器「未接入会话」行为一致。

## 决策 4：通话自有混音 AudioContext

每条语音连接自有 `AudioContext` 与 `VoiceAudioContextController`（ADR-0005「每次语音会话一个」，在 ADR-0032 之后即两条会话两条上下文）。48 kHz 门控读该实例自己的上下文。ADR-0031 的 `startAudio` 门控只打到对应房间。否决共用频道 `voiceContextRef`（call-only 没有上下文；通话 join 覆盖 ref 会拆掉频道混音）与通话 `webAudioMix: true`（join 时采集约束与真正挂上 RNNoise 的时刻分叉）。

## Considered Options

- **只把采集约束接到编排器**：增益与增强降噪仍漏在通话门外，否决。
- **多 target 扇出**：见决策 1，否决。
- **两条房间共用一条 AudioContext**：见决策 4，否决。

## 相关

- ADR-0025（RNNoise 客户端管线与即时切换）
- ADR-0032（独立 ad-hoc 房间 + 频道作用域耳机静音）
- ADR-0005 / ADR-0031（每会话混音上下文与 startAudio 门控）
- CONTEXT.md：麦克风发布链编排器、语音通话、频道作用域耳机静音、降噪选项、麦克风增益
