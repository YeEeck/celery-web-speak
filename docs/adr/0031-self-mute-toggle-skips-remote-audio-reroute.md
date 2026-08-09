# 切换自身麦克风静音不再无条件重建远端音频路由（避免按参与者播放控制的静音短暂失效）

用户反馈：开关自己的麦克风静音时，被按参与者播放控制静音（`cws.muted.<uid>`）的频道内用户声音会**短暂失效（可闻）后恢复静音**。决策：`reconcileConnectedPreferences` 中的 `startAudio` 调用加门控——音频上下文 running 时跳过 SDK `room.startAudio()`（从源头消除远端轨道路由重建）；仅上下文 suspended 或控制器缺失时才调用（恢复播放，此时重路由无感知）。

## 背景与根因

- 切换自身麦克风静音（`userToggledMute` → `reconcileConnectedPreferences`，`web/src/stores/voice-mute-deafen.ts:287`）无条件调用 `ctx.startAudio()`（=`room.startAudio()`）。
- SDK `Room.startAudio()` → `acquireAudioContext()`（livekit-client 2.20.1 `livekit-client.esm.mjs:31588-31602`）：webAudioMix 启用时对**全部远端参与者**无条件 `setAudioContext` → 已 attach 轨道 `connectWebAudio`（`26694-26699`、`26713-26737`）**重建 gainNode（默认 gain=1.0）**。
- SDK 缺陷：`connectWebAudio` 以 `if (this.elementVolume)` 重放音量——**音量 0 是 falsy，被跳过** → 按参与者播放控制静音（`setVolume(0)`，`web/src/stores/voice-participant-volume.ts:85-104`）的轨道以满增益接入输出。
- 恢复：`applyAllVolumes`（`voice-mute-deafen.ts:299`）在编排器异步队列（可达数百 ms）完成后重新 `setVolume(0)`，0.1s 时间常数指数衰减（约 0.3–0.5s 可闻）——「短暂失效后恢复」。
- 前提：本项目启用 `webAudioMix + 自定义 AudioContext`（`web/src/stores/voice-session.ts:292-296`），所有远端音频走 gainNode 路径；元素 `volume`/`muted` 不参与可闻量。非 WebAudio 路径（`el.volume`）无此缺陷。
- 与「开关静音必现」的关系：每次切换都走 `startAudio`，每次 `startAudio` 都重路由；`acquireAudioContext` 复用已存在上下文只跳过创建，不跳过重设。重连/远端重发布（`TrackSubscribed` 换轨）走同一缺陷的次要触发源。
- 已用 SDK 真实编译代码验证（`Object.create(RemoteAudioTrack.prototype)` 伪造实例执行 `setVolume`/`setAudioContext`）：音量 0.5 重路由后正确重放；音量 0 重路由后 gain 停在 1（可闻），重新 `setVolume(0)` 恢复；不重路由时静音保持。

## 决策

- `voice-mute-deafen` 的 `ctx.startAudio` 语义不变，在适配层（`voice.ts:202` → voice-session）实现门控：**音频上下文 running 时直接跳过 SDK `room.startAudio()`**；上下文 suspended 或控制器不存在时保留原行为（调用 `room.startAudio()`）。
- 切换静音时上下文几乎总是 running → 重路由不再发生 → 短暂可闻窗口根除；重连路径（`transportRecovered` → 同一入口）同样被覆盖。
- 修复形态选择「门控」而非「startAudio 后立即重放音量」：后者仅缩短窗口，0.1s 时间常数的指数衰减仍使前 0.1–0.2s 明显可闻，不能根除。
- 不做 SDK 侧 patch-package（依赖外部包版本，升级需维护补丁）；不采纳双管齐下（本次无上游协作诉求）。
- 范围：仅修短暂可闻根因。调查中发现的「每次切换静音无条件 PATCH /voice/state（deafen 属性广播全房间）」为无谓开销，非本 bug 根因，另记 issue 待办。

## 实现事实

- 改动点：`web/src/stores/voice-mute-deafen.ts:287`（调用方不变）、`web/src/stores/voice.ts:202`（adapter 改转发门控）、`web/src/stores/voice-session.ts`（暴露门控方法，复用 `voiceAudioContextController` 的 context 状态；控制器缺失时回退原行为）、`web/src/audio/VoiceAudioContextController.ts`（新增 `ensureRunning`）。
- 门控判定基于项目持有的自定义 AudioContext 状态（`VoiceAudioContextController.context.state`），而非 SDK Room 内部状态。
- 错误契约：`ensureRunning` 不吞掉 `startAudio` 的拒绝——与无控制器分支 `room.startAudio()` 一样上抛，`userToggledMute`/`userToggledDeafen`/`transportRecovered` 等调用方依赖拒绝来回滚偏好并提示用户（code-review 修正，与旧适配器直接转发的行为一致）。
- 单测：适配层断言「running 跳过 / suspended 调用 / 无控制器回退 / suspended 下 startAudio 失败上抛」。`resumeIfNeeded` 保持既有 fire-and-forget 吞错风格，不受本次错误契约影响。

## Considered Options

- **startAudio 后立即 applyAllVolumes**：窗口从「编排器队列 + 衰减」缩到「纯衰减」，但 `setTargetAtTime(0, 0, 0.1)` 从 1 衰减约 0.3–0.5s 仍可闻，且无法覆盖重连/重订阅路径。舍弃。
- **SDK 侧 patch-package 修 falsy 检查**（`if (this.elementVolume !== undefined)`）：根治 SDK 缺陷，但绑定外部包版本，升级 SDK 需重新维护补丁；且项目代码无法触达 node_modules。舍弃（可向上游反馈）。
- **双管齐下**：项目门控 + 上游 PR。上游修复周期不可控，本次无协作诉求。舍弃。
