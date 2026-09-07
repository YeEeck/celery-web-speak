# 操作提示音播放不等待输出路由；空 sink 只随路由世代

加入语音 / 退出语音会同步应用提示音的播放上下文。v0.4.39 为系统默认改指增加了「同一设备 id 先空 sink 再绑回」，同时每次 `followPlayback` 都开新路由代次，播放还要等整条 `setSinkId` 队列结束才排振荡器。进出语音时输出 id 经常仍是 `'default'`，空 sink 撞上 LiveKit 占用的输出，挂到退出拆掉混音上下文才完成，于是加入和退出叠在退出那一拍。

决定：`followPlayback` 带上语音设备管理已有的 `outputRoutingGeneration`。设备 id 与世代都不变则输出路由空操作；世代变了（id 仍可以是系统默认）才空 sink 再应用；id 变了直接 `setSinkId`。所有应用提示音（含试听、静音说话提醒）在当前已经绑上的 destination 上立即调度，不等待路由队列。真正改指的空 sink 进行中撞上的那一声可以听不见，不补播、不排队。

## Considered Options

- **播放等路由完成，保证这一声从会话输出出来**：否决。会把准时绑回设备，正是本回归。
- **每次 follow 到同一 id 都空 sink，只让播放不等待**：否决。进出语音仍会卸掉提示音输出。
- **撤掉空 sink**：否决。系统默认改指后 `setSinkId` 对相同 id 无效果，ADR-0043 仍需要再应用。
- **另开 `reapplyOutput()`，只在输出重绑时调用**：否决。调用方必须判断「这是不是改指」，和 ADR-0010 的分工相反。

## 相关

- ADR-0010（应用提示音 interface：`signal` 与 `followPlayback`）
- ADR-0043（系统默认是活别名；相同 id 必须能再应用 sink）
