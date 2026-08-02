# 语音会话生命周期深化为 ctx 模块(与 ADR 0011/0020 同构)

voice store 的会话核心——join/leave/bindRoom、重连处理、参与者合成、麦克风发布与传输模式、频道设置漂移、静音说话提醒策略、音频上下文管理、pagehide 信标——约 500 行全部内联在 821 行的 store 里,零单元测试,仅由 e2e 在浏览器级兜底。决定把它深化为 `useVoiceSession(ctx)` 模块(`web/src/stores/voice-session.ts`),与 ADR 0011 的 mute/deafen 模块、ADR 0020 的设备模块同构:一切会话命名的状态与逻辑移入模块,voice store 只剩纯偏好、跨模块组合与对外接口转发。

## 边界划分

**进模块**:会话生命周期(join/leave/bindRoom/Reconnecting/Reconnected/Disconnected/pagehide 信标)、参与者合成(syncParticipants/toVoiceParticipant/attachTrack/detachTrack/麦克风活动监控)、发布行为(enableMicrophone/republishMicrophone/麦克风管线处理器/microphoneCaptureOptions/publishOptions/toggleTransmissionMode/applyPublishSettingsChange/updateConnectedChannelSettings)、静音说话提醒(6 条策略 computed + watch + 定时器)、会话簿记(rememberEndedSession/handleModeratorDisconnect)、音频上下文管理、连带状态(status/connectedChannelId/GuildId/Name/connectedPublishSettings/errorMessage/participantStates/transmissionMode 及 changing/error/mutedSpeakingReminderEnabled/Visible/voiceSession/recentEndedSession/appliedTransmissionMode/participantSoundsReady)。

**留 store**:与连接无关的纯偏好(microphoneGain/outputVolume/echoCancellation/noiseSuppressionOption,仅经 ctx getter 单向供模块读取)、五个子模块的 ctx 接线、对外接口转发。transmissionMode 与提醒偏好虽是"偏好",但被会话行为读写,整体随模块走,避免 ADR 0020 否决过的"状态仍散两处"。

**会话对外接口不变**:除降噪选项功能将旧布尔偏好迁移为枚举外,voice store 继续转发会话模块成员,组件与 e2e 无需感知 ctx 拆分;store 自身实现归零为组装 + 转发,与既有的 muteDeafen/devices 处理同构。导航性收益来自模块本身:一个概念一个文件。

## ctx seam 划分

app store 数据(findChannel、activeGuildInfo、currentUser、connectedUsers、requestVoiceRoomsRefresh)全部经 ctx getter 注入,模块不直接 import Pinia store;子模块回调(muteDeafen 的 applyConnectionPreferences/notifyPreferenceChange/connectionReset/transportRecovered、devices 的 resolvedPreferredDeviceId/applyPreferredDevicesToRoom、appAudio 的 stop/republishBackgroundAudio、participantVolume 的 applyAllVolumes/applyVolume、sounds 的 signal/followPlayback/audible)走 ctx;livekit Room 经工厂注入(测试用假 Room);localStorage 读写沿用 ADR 0011/0020 harness 的全局假造先例,不进 ctx;pagehide/querySelector 等浏览器 seam 在测试中全局假造。

## 顺带修复 ADR 0021 报告的隐藏依赖

voice-application-audio 是唯一破坏 ctx 纪律的模块:直接 import app store 读 `app.user?.voiceMuted`(三处),ctx 未声明该依赖,模块无法隔离测试。`muted` 值改经 ctx 注入,与 guildMuteValue 的既有做法一致。

## 测试

`web/tests/voice-session.test.ts`:假 Room(可注入 token/connect 失败与事件发射)+ 假浏览器 seam,覆盖 join 成功/失败回滚/会话中断提前返回、leave 清理、Disconnected 会话终止、Reconnected 恢复、传输模式切换与回滚、参与者合成与排序、静音说话提醒策略启停、pagehide 信标。
