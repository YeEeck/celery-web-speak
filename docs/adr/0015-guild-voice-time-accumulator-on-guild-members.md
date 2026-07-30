# 服务器语音时长落在 guild_members.voice_seconds_total，由 media 域周期拍快照累加

服务器语音时长以整秒累加在 `guild_members.voice_seconds_total` 列上（key 为 user×guild），由 `media.Service` 每 60s 拍一次 `VoiceRooms()` 快照、对每个活跃 (guild, user) 加 `now - lastFlushAt` 秒，停机时再拍一次落盘。累加器放在 media 域而非 Hub，因为语音段事实（webhook join/left、`s.media.Refresh` 对账、`s.rooms` 快照）全部在 media 内封闭，跨域接信号线反而更耦合；store 经 `VoiceTimeAccumulator` sink 接口注入 media，与 ADR 0014 的 `PresenceAccumulator` 形态同构。不分段、不 settle、不接 webhook left。

## 与 ADR 0014 的取舍差异

ADR 0014 的平台在线时长有 settle-on-0↔1 转换边界，最坏丢失约 60s。本 ADR 接受**任何 < 60s 的语音会话整段丢失**——短连接不会触发任何 tick，下次拍快照时该 (guild, user) 已不在 `VoiceRooms()` 中。这是相对于 ADR 0014 的精度退化，换来不接 webhook left、不维护段状态机的实现简单度。若将来需要短会话也计入，可在本架构上加 EventParticipantLeft 钩子 settle，不破坏现有累加路径。

## Considered Options

- **在 Hub 累加，平行复刻 ADR 0014**：Hub 不持有任何语音段事实，需新增 media→Hub 信号线，跨域耦合比 ADR 0014 当年形态更差。
- **在 reconcile 路径差分累加**：精度依赖 reconcile 间隔（≥400ms 且可被 cfg 拉长），同 tick 内跳频道会产生假段切换。语音段天然是 webhook 知道的事实，退回 reconcile 差分无谓丢精度。
- **独立 voice_sessions 区间表**：ADR 0014 已对平台在线时长效否决（"只展示总和，不值得写入与清理成本"）；本场景展示用途同构，同理跳过。