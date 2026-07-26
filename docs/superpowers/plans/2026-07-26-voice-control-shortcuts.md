# 语音控制快捷交互执行计划

> 对应设计：`docs/account-rail-voice-controls-design.md`

## 目标

让语音工具栏在未加入频道时仍可配置本地状态；为麦克风和耳机按钮增加悬停音量滑块、右键设备菜单与音频设置深链接；将断开语音操作迁移到连接卡片，并确保首选设备、静音偏好和权限状态在连接竞态中一致。

## 阶段一：语音偏好与设备状态

### 变更文件

- `web/src/stores/voice-utils.ts`
- `web/src/stores/voice.ts`
- `internal/media/livekit.go`
- `internal/httpapi/guild_api.go`
- 对应 Go 测试与前端 E2E 测试

### 工作项

1. 增加浏览器本地的麦克风、耳机、首选输入设备和首选输出设备偏好。
2. 初始化主界面时请求麦克风权限、立即停止临时轨道，并监听设备热插拔。
3. 建立标准化设备选项，支持系统默认、不可用首选、当前实际设备、空名称和重复名称。
4. 离线切换只更新偏好；在线切换采用事务式更新；连接中以最新偏好为准并隔离旧会话结果。
5. 入会前应用静音、设备、音量与传输参数；扩展令牌请求，让耳机静音作为 LiveKit 初始属性随参与者出现。
6. 保留在线耳机状态 PATCH，同步管理员解除禁言后的用户麦克风偏好。

### 提交

`feat: 持久化语音状态与首选设备`

## 阶段二：快捷浮层与设置入口

### 变更文件

- `web/src/components/VoiceDeviceMenu.vue`（新增）
- `web/src/components/UserControls.vue`
- `web/src/components/ProfilePanel.vue`
- `web/src/components/AppShell.vue`
- `web/src/styles.css`

### 工作项

1. 让语音工具栏常驻，离线状态继续支持静音、传输模式、音量和设备偏好。
2. 为麦克风增益和扬声器音量实现互斥的纵向悬停滑块，支持键盘与关闭延迟。
3. 实现输入、输出设备右键菜单、视口定位、长列表、单选键盘语义和权限重试。
4. 让设置页设备下拉框离线可用并复用首选、当前、错误和权限状态。
5. 从设备菜单打开设置时直达音频输入或输出子页，并正确恢复焦点。

### 提交

`feat: 添加语音音量与设备快捷控制`

## 阶段三：连接卡片与验证

### 变更文件

- `web/src/components/AppShell.vue`
- `web/src/components/UserControls.vue`
- `web/src/styles.css`
- `web/e2e/smoke.spec.ts`
- `web/e2e/voice.spec.ts`
- `web/dist/**`

### 工作项

1. 将断开按钮移动到连接卡片右侧，改用红色 `LogOut` 图标。
2. 区分正在连接、已连接和正在恢复连接，初连按钮执行取消连接。
3. 覆盖离线工具栏、偏好持久化、浮层互斥、菜单键盘操作、深链接、回退和响应式布局。
4. 运行 Go 测试、前端类型检查、相关 Playwright 测试与生产构建。
5. 检查最终工作区并提交生成产物。

### 提交

- `feat: 调整语音连接卡片操作`
- `test: 覆盖语音快捷控制流程`
- `chore: 重建前端产物`
