# Store Composable 拆分重构

## 背景

经过多轮功能迭代，两个核心 Pinia store 文件产生了明显膨胀：

- `web/src/stores/app.ts`（634 行）：混合了 WebSocket 连接管理、消息状态、服务器引导、频道管理、用户/在线状态、认证、草稿持久化等职责。
- `web/src/stores/voice.ts`（1256 行）：混合了语音房间连接、麦克风/耳机静音、设备管理、参与者状态与音量、应用背景音全生命周期、传输模式等职责。

单文件过大导致认知负担高、修改时容易误触无关逻辑，需要及时拆分以控制技术债务。

## 设计决策

| 项目 | 结论 |
|------|------|
| 拆分形态 | composable 组合模式（非独立 Pinia store） |
| 对外接口 | store 接口完全不变，组件层零改动 |
| composable 接口风格 | 参数注入式：显式上下文对象（getter 函数 + ref） |
| 文件组织 | 扁平结构，以 store 名为前缀（如 `voice-application-audio.ts`） |
| 共享工具函数 | 独立 `voice-utils.ts` / `app-utils.ts` 存放纯函数 |
| 共享类型 | 放入对应 utils 文件，主文件 re-export 保持外部路径不变 |
| 行为变更 | 无——纯结构重构，不改变任何运行时行为 |

## 模块划分

### app.ts（634 行 → 主文件 ~330 行）

| 新文件 | 职责 | 大致行数 |
|--------|------|----------|
| `app-utils.ts` | `mapGuildMember`、`savedChannelID`、`savedServerID`、`activeChannelKey`、`isCompleteUser`、`emptyMessageState` | ~50 |
| `app-messages.ts` | 消息状态管理：`messageStates`、`loadChannelMessages`、`sendMessage`、`loadEarlier`、`markActiveChannelRead`、`ensureMessageState`、`ensureReadState`、`applyReadState`、`trimMessagesToRetention`、channelReadStates | ~120 |
| `app-socket.ts` | WebSocket 连接/重连/同步：`connectSocket`、`synchronizeSocket`、`stopSocket`、`handleEvent`、页面生命周期（pagehide/pageshow）、`requestVoiceRoomsRefresh` | ~180 |

主文件保留：`initialize`、`bootstrap`、`loadServerBootstrap`、`selectServer`、`applyBootstrap`、`login`/`register`/`logout`、`selectTextChannel`、频道 CRUD（`upsertChannel`/`removeChannel`/`normalizeChannelState`）、用户 CRUD（`upsertUser`/`removeUser`/`applyAccountUpdate`）、`updateProfile`、草稿/滚动持久化、所有 computed 定义。

### voice.ts（1256 行 → 主文件 ~750 行）

| 新文件 | 职责 | 大致行数 |
|--------|------|----------|
| `voice-utils.ts` | 纯工具函数 + 共享类型：`clampVolume`、`getSavedLevel`、`getSavedMuted`、`getSavedPreMuteVolume`、`getSavedBoolean`、`getSavedTransmissionMode`、`saveTransmissionMode`、`getSavedApplicationAudioVolume`、`clampApplicationAudioVolume`、`isBackgroundAudioPlaying`、`hasBackgroundAudio`、`isSourcePickerCancellation`、`applicationAudioErrorMessage`、`compareParticipants`、`roleRank`、`participantRole`、`participantJoinedAt`、`setAudioSink`、`VoiceParticipant` 接口、`VoiceTransmissionMode` 类型、常量 | ~160 |
| `voice-participant-volume.ts` | 参与者音量/静音控制：`setParticipantMicrophoneVolume`、`setParticipantBackgroundAudioVolume`、`toggleParticipantMicrophoneMute`、`toggleParticipantBackgroundAudioMute`、`resetParticipantMicrophoneVolume`、`resetParticipantBackgroundAudioVolume`、`applyVolume`、`applyAllVolumes` | ~180 |
| `voice-application-audio.ts` | 背景音全生命周期：`initializeApplicationAudio`、`startApplicationAudio`、`pauseApplicationAudio`、`resumeApplicationAudio`、`stopApplicationAudio`、`setApplicationAudioVolume`、`applyApplicationAudioSnapshot`、PCM port 管理、bridge 通信、pagehide 清理 | ~300 |

主文件保留：`join`/`leave`、`bindRoom`、`toggleMute`、`toggleDeafen`（含 deafened sync）、`switchInput`/`switchOutput`、`refreshDevices`、`syncParticipants`、`toggleTransmissionMode`、`applyPublishSettingsChange`、`updateConnectedChannelSettings`、`syncServerMute`、publish options 构造。

## 接口设计示例

```ts
// voice-participant-volume.ts
import type { Ref } from 'vue'
import type { Room } from 'livekit-client'
import type { VoiceParticipant } from './voice-utils'

export interface ParticipantVolumeContext {
  room: () => Room | null
  deafened: Ref<boolean>
  outputVolume: Ref<number>
  participantStates: Ref<VoiceParticipant[]>
  syncParticipants: () => void
}

export function useParticipantVolume(ctx: ParticipantVolumeContext) {
  // ... 实现
  return {
    setParticipantMicrophoneVolume,
    setParticipantBackgroundAudioVolume,
    toggleParticipantMicrophoneMute,
    toggleParticipantBackgroundAudioMute,
    resetParticipantMicrophoneVolume,
    resetParticipantBackgroundAudioVolume,
    applyAllVolumes,
  }
}
```

主 store 内调用：

```ts
// voice.ts (store setup)
const volume = useParticipantVolume({
  room: () => room,
  deafened,
  outputVolume,
  participantStates,
  syncParticipants,
})
// 展开到 store return
```

## 验证策略

- 每步拆分后执行 `vue-tsc --noEmit` + `vite build` 确认编译通过
- 全部完成后执行 Playwright e2e 测试确认功能无回归
- 每拆一个 composable 做一次原子 commit
