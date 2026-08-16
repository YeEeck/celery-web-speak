# 通话信令解析与终态归类收归 call-signal module

一个 WS `call_*` 事件原先被四个模块各自理解一遍：`app.ts` 按前缀路由、`voice.ts` raw cast 并归一 `callId`、`voice-call.ts` 缓存并推进状态机且持有终态原因白名单、`call-message.ts` 做原因 × 侧别文案。`callId` 跨端精度回归（commit `5dd24c3`）只能靠 e2e 兜底，终态原因白名单在两处漂移。架构审查提出把「事件长什么样」的 shape 知识收归单一 deep module。

## 决策 1：宽 scope

call-signal module 拥有：raw WS payload 解析、终态 reason 归一、侧别判定、原因 × 侧别文案投影。`voice-call.ts` 只消费 typed signal 并推进状态机；信令缓存（`startCallInFlight` / `pendingSignals`）留在 `voice-call.ts`，因为那是通话会话竞态知识，不是事件形状知识。

## 决策 2：seam 在 `voice.ts` 的注册回调处

`app.ts` 保持 transport-only：继续按 `call_` 前缀把 raw `(type, data)` 转给模块级 handler，不 import call-signal。`voice.ts` 的 `setCallSignalHandler` 回调是 raw payload 与 typed signal 之间的 seam——回调入口调 `parseCallSignal`，之后只把 typed signal 传给 `voice-call`。raw 形状知识止步于 voice.ts 与 call-signal 之间。

## 决策 3：类型所有权与单向 import

call-signal 拥有 `CallSignal`、`CallPeer`、`CallEndReason`、`CallTerminalSide`、`CallTerminalMessage` 与 `CallStatus`。`voice-call.ts` 从 call-signal import 这些类型，不再导出；`StartCallResult` 留在 `voice-call.ts`——它是 `POST /api/calls` 的 HTTP 响应形状，不是 WS 事件形状。import 方向单向：`voice-call → call-signal`、`voice.ts → both`，无环。

## 决策 4：纯 module，四个入口

`web/src/stores/call-signal.ts` 不依赖 Vue / Pinia / LiveKit，无副作用，按调用意图提供四个小入口：

1. raw WS 事件解析：`(type, data)` → typed `CallSignal | null`；
2. HTTP 终态 reason 归一：供 `voice-call.startCall` 处理 `StartCallResult.reason`（这条路径不走 WS）；
3. 侧别判定：`previousStatus → caller / callee / null`；
4. 文案投影：`reason × side → toast 文案 | null`。

原因白名单只在此 module 内部存在一份；`voice-call.ts` 的 `isCallEndReason` 与两个 normalize 函数删除。`emptyCallPeer` 随 peer 回退逻辑内移，`voice.ts` 不再持有。

## 决策 5：未知输入语义（行为保持）

- 未知 type、缺失或空 `callId` → 解析返回 `null`，事件忽略（显式化现有行为）。
- peer 缺失 → 回退 `emptyCallPeer`，不丢事件。
- 已知终态事件缺失/未知 reason → 按 event type 回退；`call_end` 回退 `ended`；HTTP 路径未知 reason 回退 `ended`。
- typed signal 丢弃后端 `state` 字段——前端从未消费，保留只会加宽 interface。

## 决策 6：typed `CallSignal` 单接口 + 字面量联合

`type` 为九个后端事件名字面量联合（`call_invite | call_accept | call_busy | call_unavailable | call_unreachable | call_reject | call_cancel | call_timeout | call_end`）；`callId: string`；`peer: CallPeer`；`reason: CallEndReason | null`（终态事件解析时已归一）。不采用按 type 拆分的判别联合：类型更精确但 `handleSignal` 与测试都要跟随窄化，interface 认知成本上升。

## 决策 7：直接 import，不 re-export

callers 直接 `import type` from call-signal；`voice-call.ts` 不做类型转发。当前只有 `voice.ts` 一个外部消费点，re-export 只增加一个虚假的导航入口。

## 决策 8：测试迁移

- 新建 `web/tests/call-signal.test.ts`：raw 解析（含 number/string `callId`、空值、未知 type、peer 回退、`state` 丢弃）、HTTP reason 归一、侧别判定、文案投影。
- `voice-call.test.ts` 只保留「给定 typed signal 后会话状态机怎么变」与信令缓存竞态用例，fixture 去掉 `state` 字段。
- 删除 `web/tests/call-message.test.ts`。
- `web/e2e/call.spec.ts` 不动，继续作为 WS → UI 的接线兜底。

测试面与 interface 对齐：call-signal 测解析/归类，voice-call 测状态机，e2e 测接线。

## Considered Options

- **窄 scope（只做 raw 解析）**：终态白名单仍漂在两个 module，主要回归面未消灭，否决。
- **更宽 scope（连信令缓存一起收）**：把通话会话竞态从状态机主人搬进纯解析 module，违背 locality，否决。
- **更严格解析（缺 peer 即丢事件）**：改变线上行为，收益不抵风险，否决。
- **判别联合 typed signal**：见决策 6，interface 认知成本上升，否决。
- **`voice-call` re-export 类型**：见决策 7，多余导航入口，否决。

## 相关

- ADR-0032（1:1 通话采用独立 ad-hoc 房间 + 频道耳机静音叠加）
- CONTEXT.md：语音通话、通话浮层
