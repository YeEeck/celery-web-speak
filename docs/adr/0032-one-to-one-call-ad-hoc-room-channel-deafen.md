# 1:1 通话采用独立 ad-hoc 房间 + 频道耳机静音叠加

需求是"临时与某个人 1:1 语音通信"。两条实现路线摆在面前：独立通话房间（微信电话式）vs 频道内逐接收者闭麦；同时要决定通话与频道语音是互斥还是叠加。本 ADR 记录两个不可逆、有真实取舍的架构决策。

## 决策 1：方案 A——独立 ad-hoc LiveKit 房间

通话用独立房间 `call-<callID>`（callID 由服务端单调递增分配），不侵入频道控制。否决方案 B（频道内逐接收者权限）。

理由：LiveKit 的逐接收者订阅权限是发布方逐轨显式授权（客户端逐个调 `setTrackSubscriptionPermissions`）、服务端 SDK 无对应 RPC、新发布轨道不自动继承授权、无按音频源粒度——实现与运维成本显著高于独立 ad-hoc 房间；且 B 把"私聊"硬塞进多人频道房间，对第三方的呈现与权限语义都别扭。A 的 ad-hoc 房间零额外状态机：首参与者加入自动建房、全员离开自动回收（departure_timeout 默认 20s），双方 token 权限用缺省"全发布全订阅"即可。

## 决策 2：叠加 + 频道侧耳机静音（而非互斥离开频道）

通话与频道语音并存：用户同时占频道房间 + 通话房间两个 LiveKit 连接，通话期间频道侧自动进入耳机静音、挂断自动解除并恢复通话前偏好；通话中来频道邀请被拒。

理由：互斥（离开频道）会让用户接完电话还要手动回到原频道，且进出对频道其他成员是 join/leave 噪音。叠加 + 频道耳机静音保留了频道成员资格与连接、零 churn、挂断自动恢复。代价是打破"一人一条语音连接"不变式：`targets[userID]` 单值改为「每用户最多一个频道目标 + 一个通话目标」，前端单 room 改为频道会话 + 通话会话并列；"耳机静音"细化为「频道作用域 deafen」（只静频道、不静通话）。

## 决策 3：通话 token 状态门控 + 终态驱逐（状态机扩展，已批准）

在 1 与 2 定稿后的实现评审中补记两项状态机决策：

- **token 仅 active 状态签发**：`JoinCallCredentials` 只在 `State == CallActive` 时签发 JoinCredentials，ringing/ended 返回 `ErrCallNotActive`（HTTP 409 `call_not_active`）。理由：token 是进入 `call-<callID>` 房间的凭证，房间只在 accept 后才有实际媒体意义；振铃期签发会让被叫在拒绝/超时后仍持有可加入的令牌，把「通话已结束」的仲裁权泄漏给客户端。
- **终态通话立即回收**：`evictTerminalCallLocked` 在全部终态转移点 emit 后驱逐无参与者的终态通话——reject/cancel/timeout/busy/unreachable 这类从未建房或已无参与者的终态即时回收；hangup/disconnect 因参与者仍可能在场，保留到最后参与者离场（`RemoveCallParticipant`/participant_left）再驱逐。Refresh 兜底丢弃 ended + 过期 call（active/ringing 不因创建 TTL 过期而丢弃）。理由：call 实体纯内存（决策 1），不回收即内存泄漏；但驱逐必须发生在终态信令 emit 之后，保证 peer 字段仍可解析。

## 决策 4：参与者观察驱动的终态转移统一为一个入口（已批准）

Webhook 的 participant_joined/left 与 Refresh 的全量参与者集合归一为同一观察载荷，经统一转移表推进 Participants 增删、准入移除、active→ended(disconnected) 与驱逐。webhook 送达的 left 是权威事件，立即触发断开；Refresh 推断的缺席只对曾在 Participants 中出现过的一方触发断开，因此接听后双方取 token、进房的窗口不会被误判为离开。room_finished 保持直接删除、不发信令。信令与移除副作用在转移决策时物化，并按固定顺序执行。

理由：Refresh 是 webhook 漏事件的兜底，但原实现只重建参与者、不推进生命周期——漏 left 会让剩下一方停留在 active 通话；同时 Refresh 无法区分「刚接听还没进房」与「已进房后离开」，所以推断缺席需要「曾出现过」这一历史约束。这不改变决策 1/2/3 的取舍。

## 相关

- LiveKit 能力事实（ticket 12）
- 房间模型（06）、静音/禁言（07）、生命周期（04）
