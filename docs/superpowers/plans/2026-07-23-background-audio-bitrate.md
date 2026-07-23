# 背景音码率分离配置

## 背景

当前语音频道的 `audioBitrateKbps` 同时用于麦克风语音和背景音（应用音频共享）。
语音 Opus 在 48–64 kbps 即达透明质量，而音乐 Opus 立体声至少需要 128 kbps 才"能听"，
理想 192–256 kbps。共享同一码率导致两者无法独立优化。

## 设计决策

| 项目 | 结论 |
|------|------|
| 背景音码率范围 | 64–256 kbps，步进 16 |
| 默认值 | 128 kbps（固定，不继承语音码率） |
| 配置粒度 | 频道级（每个语音频道独立） |
| DB 迁移 | `COALESCE(background_audio_bitrate_kbps, 128)`，不填存量 |
| 码率变更生效 | 实时（复用 `applyBitrateChange` unpublish + republish） |
| 状态栏显示 | 仅显示语音码率，不显示背景音码率 |
| 管理面板 | 语音频道设置区新增第二个 slider |
| 死代码清理 | 移除 `settings.go`、`ChannelSettings`、`PATCH /api/settings`、bootstrap `settings` 字段、前端对应类型 |

## 变更范围

### 后端

- `internal/store/models.go` — `Channel` 增加 `BackgroundAudioBitrateKbps` 字段；移除 `ChannelSettings`
- `internal/store/store.go` — 迁移：`ALTER TABLE channels ADD COLUMN background_audio_bitrate_kbps INTEGER`
- `internal/store/channels.go` — 查询加 `COALESCE(..., 128)`；创建时写入 128；更新时校验 64–256 步进 16
- `internal/store/settings.go` — 删除
- `internal/httpapi/handlers.go` — 移除 `handleUpdateSettings`；bootstrap 不再返回 `settings`
- `internal/httpapi/server.go` — 移除 `PATCH /api/settings` 路由
- `internal/httpapi/channels.go` — `handleUpdateChannel` 输入增加 `backgroundAudioBitrateKbps`
- `internal/store/store_test.go` — 移除 `TestSettingsValidation`；`TestMessageRetention` 改用 `UpdateChannel`

### 前端

- `web/src/types.ts` — 移除 `ChannelSettings`；`Channel` 增加 `backgroundAudioBitrateKbps?`；`BootstrapData` 移除 `settings`
- `web/src/stores/voice.ts` — `applicationAudioPublishOptions()` 读取 `backgroundAudioBitrateKbps`
- `web/src/components/AdminPanel.vue` — 新增背景音码率 slider（64–256，步进 16）；保存时传入新字段
