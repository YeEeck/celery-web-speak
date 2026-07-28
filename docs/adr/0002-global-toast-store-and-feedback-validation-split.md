# 全局统一 toast 由 Pinia store 承载，操作反馈走 toast、校验错误保内联

前端此前只有 AppShell 内一个 `actionToast` ref（单条、互替、`setTimeout` 关闭），而配置页面另起三套各自重复的 `run(action, success)` 助手与 `message`/`errorMessage` ref，把结果渲染在 `<footer class="panel-footer">` 内联区。为统一体验并移除重复，新增 Pinia store `useToastStore` 作为唯一载体：有界队列堆叠（可见上限 3，超出淘汰最早一条）、分级自动关闭（success≈2s、warning≈4s、error≈6s）、全部可×手动关、hover 暂停计时，类型仅 success/error/warning 复用现有 CSS。离调用最近的 `busy` 仍在各面板/注入本地持有（不在 store），`toastStore.runAction(action, successMessage)` 内部 try/catch 并发 toast、返回 Promise，供调用处用 `busy=true; await runAction(); busy=false` 包裹。

按“操作反馈 vs 校验错误”分界界定转 toast 的范围：已完成动作的成功/失败（“服务器名称已更新”/“操作失败”、加载/刷新失败、删除账号失败、退出/登出失败）走 toast；依附于具体输入且需用户改正的错误（ProfilePanel 头像大小/类型、新密码≥10 位等调用前客户端校验，以及 AuthScreen 登录/注册错误）保持内联。据此移除 GuildAdminPanel/PlatformAdminPanel/PlatformGuildsPanel 的 `message`/`errorMessage` ref 与 `<footer class="panel-footer">`，`GuildAdminContext` 改为只注入 `busy`、子 Tab 直接用 store；ProfilePanel 仅保留前置校验的 `avatarError`/`passwordError` 内联用途、post-call 成功/失败改走 toast；AppShell 现有 `actionToast`/`showActionToast` 全部改调 store。toast 渲染层 `z-index: 100` 已高于 `.modal-backdrop` 的 50，配置面板之上照常可见。

## 考虑过的备选与取舍

- **AppShell ref + provide/inject**：保留现有单 ref 形态、改动最小，但每个配置面板都要 inject 且与本仓 Pinia 全局状态（app/voice/sounds/theme）的模式不一致。舍弃。
- **模块级 composable（useToast）**：不经 Pinia、用模块级状态，但与团队已标准化的 store/composable 拆分（`refactor/store-composable-split`）重复，等于绕过既有约定。舍弃。
- **单条互替而非有界队列**：实现最简，但两个动作几乎同时完成时后发会瞬间覆盖先发的，丢失信息；与“完善”目标相悖。舍弃。
- **错误持久不自动关闭**：更安全，但连续多次失败会占满队列上限、阻塞后续反馈；改以分级时长 + 手动× + hover 暂停兼顾注意力与流通。
- **新增 info 类型**：目前没有“既不成功也不失败”的中性提示需求，新增会带来无用的 CSS/rule；保留 success/error/warning 复用现有三色。
- **`run` 移入 store 并托管 `busy`**：会让任意面板动作的全局 `busy` 互相牵连（管理面板动作会禁用语音按钮）。`busy` 必须本地化，故只把成功/失败发言上移到 `runAction`，`busy` 留在调用方。
- **删除账号对话框失败保留内联**：对话框失败后仍开启等用户重试，内联更直观；但为实现上的统一，统一改走 toast（用户显式选择一致性）。
- **把所有页面内错误（含 AuthScreen 登录错误）都转 toast**：与“统一”一致，但登录错误随 toast 消失会让用户重试时看不到原因；AuthScreen 例外保持内联。
- **仅转三个管理面板 footer**：未覆盖 ProfilePanel 的“头像已更新”等操作反馈，与“全局统一”目标不符。舍弃。