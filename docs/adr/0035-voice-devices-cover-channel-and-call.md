# 语音设备管理覆盖频道与通话：一个实例、活动连接列表

ADR-0032 让用户同时占频道房间与通话房间。语音设备管理的 seam 仍是「当前频道房间」：`room()` / `voiceSession()` 只有一份，`applyOutputSink` 只扫 `#voice-audio-root`。通话中途切换首选输入/输出设备只打到频道；只在通话里时连 LiveKit 都不调，只写偏好。ADR-0034 把输入热切换划给这一刀，且否决过「一个编排器扇出 N 个 target」——容易被对称地理解成「两个 VoiceDevices」。

## 决策 1：一个设备模块，应用目标是活动连接列表

偏好、枚举、权限、回滚是浏览器级一份状态。模块仍一个实例；ctx 用 `liveConnections(): { room, session }[]` 替换 `room()` / `voiceSession()` / `status()` / `joined()`。`voice.ts` 组装列表：频道在 `status !== 'connecting'` 时入列，通话在 `connectedAt != null` 时入列；reconnecting 入列。呼出/振铃没有 Room。否决两个 VoiceDevices 实例（偏好会分叉）和两套平行 getter（「有两个房间」会漏进设备模块 interface）。

## 决策 2：输入热切换保持 `switchActiveDevice`，不走编排器重发布

对列表里每个房间 `switchActiveDevice`。输出另加一次 `applyOutputSink`（adapter 同时扫 `#voice-audio-root` 与 `#call-audio-root`）。不把输入切换改成各条连接的 `applyMicrophoneState({ forceRepublish: true })`——那会改写已工作的频道路径，并把设备模块焊到两条编排器上。通话 join 不额外跑 `applyPreferredDevicesToRoom`（采集与 `audioOutput` 已在构造时读偏好）。

## 决策 3：用户点选对仍存活的连接全有或全无；拔出降级按房间尽力

列表里仍在的房间有一个 `switchActiveDevice` 失败：已成功的活房间回滚，不写偏好，走现有 `deviceChangeError`。`await` 期间某房间 session 对不上（挂断/离开）：当作已离列，不回滚、不报错。列表为空时只写偏好（与今天无房间 / connecting 一致）。

刷新发现某房间当前设备已不在枚举里：对该房间切到系统默认，失败只吞掉，不回滚其它房间、不写 `deviceChangeError`——不能回滚到已经消失的设备。`activeInputId` / `activeOutputId` 以「当前 id 是否仍在枚举」为准，不合并两个房间的 `getActiveDevice`。

不在这一刀：说话检测引擎随首选输入重启（已订阅偏好）；回声抑制变更后重发布；UI。通话 join 不额外跑 `applyPreferredDevicesToRoom`。

## Considered Options

- **两个 VoiceDevices 实例**：与编排器同构，但偏好不是 per-connection，否决。
- **输入走编排器 `forceRepublish`**：见决策 2，否决。
- **一边成功即写偏好**：频道新麦、通话旧麦会返回成功，否决。

## 相关

- ADR-0020（设备模块 ctx-adapter）
- ADR-0032（独立 ad-hoc 房间）
- ADR-0034（通话走编排器；输入热切换划出）
- CONTEXT.md：语音设备管理、首选输入设备、首选输出设备、语音通话
