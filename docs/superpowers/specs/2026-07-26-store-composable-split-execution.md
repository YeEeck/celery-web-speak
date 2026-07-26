# Store Composable 拆分 — 执行计划

## 前置约束

- 纯结构重构，不改变运行时行为
- 每步完成后 `vue-tsc --noEmit` + `vite build` 必须通过
- 每步一次原子 commit（中文消息 + 英文前缀）

---

## Step 1：voice-utils.ts

**操作**：
1. 创建 `web/src/stores/voice-utils.ts`
2. 从 `voice.ts` 底部迁移以下内容：
   - 常量：`DEFAULT_VOLUME`、`MAX_VOLUME`、`MICROPHONE_GAIN_KEY`、`OUTPUT_VOLUME_KEY`、`DEAFENED_ATTRIBUTE`、`ECHO_CANCELLATION_KEY`、`NOISE_SUPPRESSION_KEY`、`TRANSMISSION_MODE_KEY`、`APPLICATION_AUDIO_VOLUME_KEY`、`APPLICATION_AUDIO_DEFAULT_VOLUME`、`APPLICATION_AUDIO_PORT_TIMEOUT_MS`、`DEFAULT_AUDIO_BITRATE_KBPS`
   - 类型：`VoiceTransmissionMode`、`VoiceParticipant`
   - 纯函数：`defaultConnectedPublishSettings`、`clampVolume`、`getSavedLevel`、`getSavedMuted`、`getSavedPreMuteVolume`、`getSavedBoolean`、`getSavedTransmissionMode`、`saveTransmissionMode`、`getSavedApplicationAudioVolume`、`clampApplicationAudioVolume`、`isBackgroundAudioPlaying`、`hasBackgroundAudio`、`isSourcePickerCancellation`、`applicationAudioSnapshotError`、`applicationAudioErrorMessage`、`isApplicationAudioError`、`compareParticipants`、`currentRole`、`roleRank`、`participantRole`、`participantJoinedAt`、`setAudioSink`
3. 全部 `export`
4. `voice.ts` 中删除上述内容，改为 `import { ... } from './voice-utils'`
5. `voice.ts` 添加 re-export：`export type { VoiceParticipant, VoiceTransmissionMode } from './voice-utils'`

**验证**：`vue-tsc --noEmit` + `vite build`

**Commit**：`refactor: 提取语音模块工具函数与共享类型至 voice-utils.ts`

---

## Step 2：voice-participant-volume.ts

**操作**：
1. 创建 `web/src/stores/voice-participant-volume.ts`
2. 定义 `ParticipantVolumeContext` 接口：
   ```ts
   {
     room: () => Room | null
     deafened: Ref<boolean>
     outputVolume: Ref<number>
     participantStates: Ref<VoiceParticipant[]>
   }
   ```
3. 迁移以下函数：
   - `setParticipantMicrophoneVolume`
   - `setParticipantBackgroundAudioVolume`
   - `toggleParticipantMicrophoneMute`
   - `toggleParticipantBackgroundAudioMute`
   - `resetParticipantMicrophoneVolume`
   - `resetParticipantBackgroundAudioVolume`
   - `applyVolume`
   - `applyAllVolumes`
4. 从 `voice-utils.ts` import 所需工具函数（`clampVolume`、`getSavedLevel`、`getSavedMuted`、`getSavedPreMuteVolume`、`DEFAULT_VOLUME`）
5. `voice.ts` 中删除上述函数，在 store setup 内调用 `useParticipantVolume(ctx)` 并展开返回值

**验证**：`vue-tsc --noEmit` + `vite build`

**Commit**：`refactor: 拆分参与者音量控制为 voice-participant-volume composable`

---

## Step 3：voice-application-audio.ts

**操作**：
1. 创建 `web/src/stores/voice-application-audio.ts`
2. 定义 `ApplicationAudioContext` 接口：
   ```ts
   {
     room: () => Room | null
     voiceSession: () => number
     deafened: Ref<boolean>
     status: Ref<string>
     connectedChannelId: Ref<number | null>
     connectedServerId: Ref<number | null>
     connectedPublishSettings: Ref<ConnectedPublishSettings>
     syncParticipants: () => void
   }
   ```
3. 迁移以下内容：
   - 状态：`applicationAudioSupported`、`applicationAudioState`、`applicationAudioError`、`applicationAudioVolume`、`applicationAudioOperating`、`applicationAudioSessionId` 及所有 `let` 变量（bridge、pipeline、track、publication、port 相关）
   - 函数：`initializeApplicationAudio`、`startApplicationAudio`、`pauseApplicationAudio`、`resumeApplicationAudio`、`stopApplicationAudio`、`setApplicationAudioVolume`、`applyApplicationAudioSnapshot`、`handleApplicationAudioPcmPort`、`waitForApplicationAudioPort`、`cleanupApplicationAudioMedia`、`synchronizeApplicationAudioPublication`、`rejectPendingApplicationAudioPort`、`disableApplicationAudio`、`handleApplicationAudioPageHide`
   - computed：`applicationAudioActive`、`applicationAudioPlaying`、`applicationAudioChanging`
4. `voice.ts` 中删除上述内容，在 store setup 内调用 `useApplicationAudio(ctx)` 并展开返回值
5. 注意：`toggleDeafen` 中调用 `pauseApplicationAudio(true)` / `resumeApplicationAudio(true)`，需通过 composable 返回值引用
6. `applyPublishSettingsChange` 中操作 `applicationAudioTrack`，需通过 composable 暴露的方法或 getter 访问

**验证**：`vue-tsc --noEmit` + `vite build`

**Commit**：`refactor: 拆分应用背景音为 voice-application-audio composable`

---

## Step 4：app-utils.ts

**操作**：
1. 创建 `web/src/stores/app-utils.ts`
2. 从 `app.ts` 底部迁移：
   - `emptyMessageState`
   - `savedChannelID`
   - `activeChannelKey`
   - `savedServerID`
   - `isCompleteUser`
   - `mapGuildMember`
   - `MessageState` 接口
3. 全部 `export`
4. `app.ts` 中删除上述内容，改为 import

**验证**：`vue-tsc --noEmit` + `vite build`

**Commit**：`refactor: 提取应用模块工具函数至 app-utils.ts`

---

## Step 5：app-messages.ts

**操作**：
1. 创建 `web/src/stores/app-messages.ts`
2. 定义 `MessagesContext` 接口：
   ```ts
   {
     activeServerId: Ref<number | null>
     activeTextChannelId: Ref<number | null>
     channels: Ref<Channel[]>
   }
   ```
3. 迁移以下内容：
   - 状态：`messageStates`、`channelReadStates`、`messageLoadVersions`
   - 函数：`ensureMessageState`、`ensureReadState`、`applyReadState`、`trimMessagesToRetention`、`loadChannelMessages`、`sendMessage`、`loadEarlier`、`markActiveChannelRead`、`clearChannelState`（消息相关部分）
4. `app.ts` 中删除上述内容，在 store setup 内调用 `useMessages(ctx)` 并展开返回值
5. 注意：`handleEvent`（尚在 app.ts 中）和 `applyBootstrap` 需要调用 `ensureMessageState`/`trimMessagesToRetention`，通过 composable 返回值引用

**验证**：`vue-tsc --noEmit` + `vite build`

**Commit**：`refactor: 拆分消息状态管理为 app-messages composable`

---

## Step 6：app-socket.ts

**操作**：
1. 创建 `web/src/stores/app-socket.ts`
2. 定义 `SocketContext` 接口：
   ```ts
   {
     user: Ref<User | null>
     servers: Ref<ServerSummary[]>
     activeServerId: Ref<number | null>
     socketStatus: Ref<'offline' | 'connecting' | 'online'>
     bootstrap: () => Promise<void>
     loadServerBootstrap: (serverId: number) => Promise<void>
     loadChannelMessages: (channelId: number, force?: boolean) => Promise<void>
     applyBootstrap: (data: BootstrapData, invalidate?: boolean) => void
     clearServerState: () => void
     handleEvent: (type: string, data: unknown, serverId?: number) => void
     // ... 其他需要的回调
   }
   ```
3. 迁移以下内容：
   - 状态：`socket`（let）、`reconnectTimer`、`synchronizingSocket`、`socketActivityVersion`、`voiceRoomsRefreshTimer`、`serverBootstrapVersion`、`pageLifecycleInstalled`
   - 函数：`connectSocket`、`synchronizeSocket`、`stopSocket`、`installPageLifecycle`、`closeSocketForPageExit`、`reconnectSocketAfterRestore`、`requestVoiceRoomsRefresh`、`detectClientType`
4. `handleEvent` 保留在 `app.ts` 主文件中（它是事件分发胶水层，操作 messages/channels/users 多个模块），通过 ctx 回调传入 socket composable
5. `app.ts` 中删除 socket 相关内容，在 store setup 内调用 `useSocket(ctx)` 并展开返回值

**验证**：`vue-tsc --noEmit` + `vite build`

**Commit**：`refactor: 拆分 WebSocket 连接管理为 app-socket composable`

---

## Step 7：最终验证

1. 完整执行 `vue-tsc --noEmit`
2. 完整执行 `vite build`
3. 执行 Playwright e2e 测试（`npx playwright test`）
4. 确认无回归后，重构完成
