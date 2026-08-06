# 语音连接质量 unknown 渲染为中性灰点占位，机制保持服务端驱动、映射抽纯函数加单测

语音参与者行右侧的连接质量图标此前把 unknown 与 lost 一并画成 0 格三灰，与"测得但极差"不可区分；且 unknown 并非"测不到"，而是"服务端从未把该成员的质量推送到这台客户端"——经常出现的"成员一直 unknown"根因在服务端行为。决策：显示层兜底——unknown 渲染为中性灰点占位（16px 占位保持、行右布局不抖动），title 文案「连接质量未知」；lost 仍为 0 格；质量→显示映射抽为纯函数 `voiceQualityDisplay`（voice-utils.ts）并加 `node --test` 单测钉住五态语义；检测机制（服务端打分、推送规则、客户端不计算）不动。

## 检测机制（事实）

- **打分**：livekit-server v1.13.4（stock 容器，compose 固定镜像）`pkg/sfu/connectionquality`——每个参与者取「上行（自己发布的轨道，按丢包率打分）+ 下行（自己订阅的轨道，按 RTCP 接收报告的 RTT/抖动/丢包打分）」的最小值，每 5 秒节拍（`UpdateInterval`），映射 EXCELLENT/GOOD/POOR/LOST；打分器不会输出 unknown（分数从满分 100 起步 = EXCELLENT）。
- **推送**：`pkg/rtc/room.go` 的 `connectionQualityWorker` 每 5s 一次，只在「新成员出现或某成员质量变化」时，向「订阅了该成员轨道」的客户端（`GetSubscribedParticipants`）广播 `ConnectionQualityUpdate`；质量不变则静默。
- **消费**：livekit-client 2.20.1 不自行计算质量（轨道 monitor 只算码率），初始值 Unknown，仅凭服务端推送更新（`Room.handleConnectionQualityUpdate` → `setConnectionQuality`）。

## unknown 根因

- **服务器禁言成员**（voiceMuted，guildMuted）的 token 带 `CanPublish: false`（internal/media/livekit.go），没有任何发布轨道 → 没有任何客户端订阅他们 → 服务端永不推送其质量 → 对所有人永远 unknown。
- **节拍竞态**：新成员的订阅在加入后约 1s 内建立，而推送节拍相位任意；订阅若落在「新成员已进入 prev 表」的下一个节拍，该客户端就错过首推；初始质量满分且稳定网络下不变化，此后无推送 → 永久 unknown。
- **渲染误导**：客户端此前把 unknown 与 lost 都画成 0 格，视觉上被误读为"信号极差"。

## 决策

- unknown → 中性灰点（`.quality-dot`，`--faint-icon` 色），title「连接质量未知」；lost → 保持 0 格三灰（"测到了，很差"）。
- title 全部中文化：极佳/良好/较差/连接丢失/未知，前缀统一「连接质量」（见术语表：连接质量，Avoid 网络质量）。
- 映射抽为纯函数 `voiceQualityDisplay`（voice-utils.ts）：返回 `{ bars, title, unknown }`，组件只渲染；单测五态全钉（tests/voice-quality-display.test.ts）。
- 机制不动：不改服务端（stock 容器）、不客户端自测。

## 边界

- **不缓解节拍竞态**：客户端没有触发质量推送的途径（推送条件"质量变化/新成员"均发生在服务端，客户端不可请求）；服务端为 stock 容器不可改。接受"加入后短期 unknown、质量变化后出现"。
- **不自测质量**：客户端按 WebRTC 接收统计（jitter/丢包/RTT）自行打分需要复刻 SFU 打分模型，且只覆盖"我听到你"的接收视角，与全房间语义分裂；代价大、收益低。

## Considered Options

- **灰点占位（采用）**：区分"未测得"与"测得但差"，16px 占位不抖动；灰点仅表"尚无数据"，不编造质量。
- **隐藏图标位**：行右参差（有人有图标有人没有），且无从解释"为什么没有"；未采用。
- **保持 0 格只改 tooltip**：改动最小但视觉仍与 lost 混淆，误导依旧；未采用。
- **前端自测兜底**：见"边界"，未采用。
- **fork livekit-server 镜像改全量推送**：改第三方容器，升级/维护成本高；未采用。

## 修订记录

- **2026-08-06（初始）**：诊断记录与显示兜底决策。
