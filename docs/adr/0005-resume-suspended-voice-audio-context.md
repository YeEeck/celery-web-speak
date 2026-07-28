# 语音连接期间自动恢复被挂起的混音上下文

LiveKit 语音房间启用 `webAudioMix` 后，浏览器可能在系统休眠恢复、音频输出设备切换或页面生命周期变化时把混音 `AudioContext` 从 `running` 改为 `suspended`。房间和 WebRTC 连接仍然存在，但远端声音会停止；LiveKit 只在加入、显式 `startAudio()` 或媒体元素播放失败时更新播放状态，不能覆盖连接期间的异步状态变化。

每次语音会话由前端创建并持有一个 `AudioContext`，以 `webAudioMix: { audioContext }` 传给 LiveKit。上下文的 `statechange` 进入 `suspended` 时，如果该上下文仍属于当前语音房间、房间状态为已连接且用户未开启耳机静音，则调用 `room.startAudio()` 尝试恢复。使用 `startAudio()` 而非直接调用 `resume()`，是为了同时恢复已挂载的媒体元素并同步 LiveKit 的 `canPlaybackAudio` 状态。

耳机静音期间不主动恢复，解除耳机静音时沿用现有 `startAudio()` 路径。自动恢复失败（例如浏览器要求用户手势）只记录警告，不循环重试；用户后续交互仍可触发 LiveKit 的播放恢复。离开或被动断开时，前端先移除状态监听并关闭自有上下文，因为传入自有上下文后 LiveKit 不负责关闭它。

## 考虑过的备选与取舍

- **只调用 `AudioContext.resume()`**：不能保证挂载的 `<audio>` 元素播放状态和 `Room.canPlaybackAudio` 同步，可能留下 SDK 状态漂移。舍弃。
- **继续使用 `webAudioMix: true` 并访问 LiveKit 私有字段**：依赖 SDK 内部实现，升级容易失效；公开的 `WebAudioSettings.audioContext` 已提供稳定注入点。舍弃。
- **无条件恢复（包括耳机静音或未连接）**：会违背用户的静音意图，也可能在旧会话清理后重新唤醒上下文。舍弃。
- **失败后定时循环重试**：浏览器自动播放策略不会因重试变为允许，循环只会产生无效调用和日志噪声；保留用户手势作为兜底。
