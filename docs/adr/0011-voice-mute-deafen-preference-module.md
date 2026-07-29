# 抽取语音静音/耳机静音偏好 Module

`web/src/stores/voice.ts` 现在把麦克风静音偏好、耳机静音偏好、服务器语音禁言投影、当前会话同步以及耳机静音后端同步混在一个 1214 行的 Pinia store 里，并通过 10 次复制的 `target = room / session = voiceSession` race-guard idiom 维护私有并发契约。同一份契约还散在 `toggleMute`、`toggleDeafen`、`syncGuildMute`、`bindRoom` 的 Reconnected 分支、`applyJoiningPreferences` 和耳机静音同步队列里；`voice.ts` 之外的 `AppShell.vue` 还用两个 watcher 协调"服务器语音禁言变更要重算偏好"和"业务 socket 恢复要重试耳机静音同步"——这两个时机决策都属于静音/耳机静音 module 自己的生命周期，与 ADR-0010 把应用提示音生命周期移出根应用的方向相反。

决定按 A 最窄边界抽出独立的 `useVoiceMuteDeafenModule`：只收麦克风静音偏好、耳机静音偏好、服务器语音禁言输入、当前会话投影和耳机静音后端同步队列；其他副作用（应用提示音 follow、应用音频 pause/resume/stop、麦克风 republish、麦克风增益 attach、参与者音量 applyAllVolumes）作为 context adapter 由 module 内部 await，不暴露给调用方。module 不接触 `Room` 类型——`bindRoom` 仍是 voice store 的职责，Reconnected 后只调 `module.transportRecovered()`，随之再做与静音无关的 syncParticipants、participantSoundsReady、requestVoiceRoomsRefresh。

Interface 由 5 个专用入口与若干只读 reactive state 组成：`userToggledMute()`、`userToggledDeafen()`、`guildMuteChanged(muted)`、`transportRecovered()`、`connectionReset()`；调用方不再看见 `target/session` race 检查。`muted/deafened/guildMuted/microphoneEnabledPreference/deafenedPreference/muteChanging/deafenChanging/voicePreferenceFeedback/deafenedSyncError` 直接 forward 到 voice store 导出，与 voice store 其他 ref 风格一致。

Race-guard idiom 完全内化：module 通过 context 的 `() => Room | null` 与 `() => number`（voiceSession）getter 拿现在引用，await 后在 module 内部自检过期并 silent return，调用方只看到 awaited method 返回。10 次复制彻底消失，interface 不暴露 session/room race 概念。

耳机静音同步后端通过 context 注入 `syncDeafenedToBackend(guildId, channelId, deafened): Promise<void>` adapter：生产包装现有 `request(...)` 的 PATCH `/api/guilds/{guildId}/channels/{channelId}/voice/state`，测试用内存 fake。HTTP 调用、队列合并、socket 恢复后重试都由 module 自己拥有，AppShell.vue 的 `app.socketStatus === 'online'` watcher 删除。

AppShell.vue 的 `app.user?.voiceMuted` watcher 同样删除：module 通过 context 注入 `() => boolean | undefined` getter，内部 `watch` 后自己 dispatch `guildMuteChanged`。AppShell.vue 不再协调静音 module 的生命周期。channel 设置漂移、频道不存在、guild 成员资格三个 watcher 与静音 module 无关，保留原状。

语音整体错误通道 `errorMessage` 共享：voice store 仍持有 ref，实例化 module 时通过 context 注入 `setErrorMessage(msg: string)` writer，module 在失败路径里调它。join/leave 不属于本 module，仍由 voice store 自己读写同一 ref；不需要为 mute/deafen 单独设置错误 ref。

Mute/deafen reconcile 过程触碰的其他 module 副作用通过 context adapter 外化，不进入 module interface：

- 应用提示音 follow：`syncApplicationSoundPlayback(deafened, outputDeviceId)` adapter
- 应用音频 pause/resume/stop：`pauseApplicationAudio, resumeApplicationAudio, stopApplicationAudio` adapter
- 麦克风 republish 与 attach gain：`republishMicrophone, attachMicrophoneGain` adapter
- 参与者音量 applyAllVolumes：`applyAllVolumes` adapter
- 麦克风音轨开关：`setMicrophoneEnabled, startAudio` adapter（module 决定开关，不拥有 `microphoneCaptureOptions`）
- `voiceAudioContextController.resumeIfNeeded` adapter

测试与 ADR-0010 一致：implementation 通过 context 接可控 fake adapter，external interface 是唯一可观察面。每个 input method 断言 (1) reactive state 最终值、(2) adapter 调用序列与参数、(3) race 失败 silent return 与 error recovery 路径。重点用例包括：未连接时 toggleMute 不触发任何 adapter、toggleDeafen 进入耳机静音时按顺序先关麦克风再 pause 应用音频、guildMute 启用先停应用音频再 reconcile、race 失败 silent return 不写 errorMessage、socket 恢复后只重试未完成同步。

实例化形如 `useApplicationAudio(ctx)` 与 `useParticipantVolume(ctx)`：file 放在 `web/src/stores/voice-mute-deafen.ts`，导出 `useVoiceMuteDeafenModule(ctx)`；voice store setup 内调用并把 module 的 ref 与 method forward 到自己的导出。测试直接 import composable，不依赖 Pinia。

考虑过把 module 直接收口到包括传输模式（DTX）偏好和发布设置变化的 microphone 分支，但二者各自属于独立的深 module（microphone publish、participant volume），不在本 module 关注的麦克风静音/耳机静音/服务器语音禁言投影之内；按 A 最窄边界先收拢偏好投影与会话同步，避免本 module 替代 voice store 成为新的 wide facade。

考虑过 interface 形如 `apply(intent: VoicePreferenceIntent)` 的判别联合，但调用方都要构 union、fixture 要先构 intent、对 test surface 不利；按 N1 选 5 个专用 method 让每个入口表达直接领域意图，与 ADR-0010 "按调用意图区分 interface" 一致。

CONTEXT.md 已有"麦克风静音、耳机静音、服务器语音禁言、语音状态偏好、语音会话"等术语覆盖本 module 关注的全部概念，本次深化不引入新领域词；作为本次实施副产物，`web/src/components/AppShell.vue` 的两个静音 watcher 删除，端到端语音 spec 维持不变。