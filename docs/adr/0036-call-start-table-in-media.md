# 通话发起表收在 media.StartCall，不进 store

httpapi 曾把可被呼叫设置与呼叫屏蔽 AND 成 `inboundAllowed`，资格拒绝（不同服）停在 handler 的 403 分支；media 只吃拼好的 bool。ADR-0021 会把人引向「策略进 store」，但忙碌是 media 内存协调态，必须与建通话同一把锁。决定：通话发起的优先级表是 `StartCall` 的 implementation；穿越 seam 的是同服、呼叫屏蔽、在线这些领域事实，外加被叫 User 上的可被呼叫设置。httpapi 只加载事实并映射哨兵（资格拒绝 → 403 `not_in_shared_guild`，主叫忙碌 → 409）。不新建包——一个 adapter 是假想 seam。`StartCall` 不再接受 `inboundAllowed`。

## Considered Options

- **表进 store**：忙碌无法进 SQL，表会再劈开，否决。
- **新建包**：生产只有 httpapi 一个调用方，假想 seam，否决。
- **handler 旁纯函数、StartCall 仍吃 inboundAllowed**：media 测试继续用 bool 绕过表，否决。
