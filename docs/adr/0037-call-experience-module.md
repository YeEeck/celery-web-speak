# 通话阶段副作用收归 call-experience，不进 voice-call / call-signal

`voice.ts` 用三个 `watch(call.status)` 施加频道作用域耳机静音、通话提示音与终态 toast。政策赚到了 locality（删掉会散到通话浮层），但住在零测试的接线层；塞进 `voice-call` 会让会话知道频道，塞进 `call-signal` 会把副作用混进事件形状。决定：新 module `useCallExperience(ctx)` 旁挂会话，构造时注入 `status` / `endedReason`，内部 watch；`voice-call` 仍对频道无感知，`call-signal` 仍是纯解析。HTTP 发起失败 toast 仍留在 `startCall` 接线。结束音只在离开 `active` 时播（以当时代码为准，旧注释有误）。

## Considered Options

- **塞进 voice-call**：会话开始依赖 mute-deafen 与提示音，顶 ADR-0033，否决。
- **抽纯函数留在 voice.ts**：接线层仍是主人，删除测试不过，否决。
- **拆成三条、各回 mute-deafen / sounds / call-signal**：调用方继续拼合取，否决。
- **CONTEXT.md 新词条**：三条政策已有产品名；「通话体验」易与通话浮层撞，否决。
