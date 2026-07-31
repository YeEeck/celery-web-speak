# 个人资料读取集中在 store 读取模型，HTTP 层只做映射

个人资料（个人信息卡片的读取来源）原先的可见性策略散落在 `handleGetUserProfile` 的约 100 行内联条件里，谓词、查询与组装横跨 httpapi、presence.go、voice_level.go 三个文件；且同一代码路径混用两种"活跃成员"定义（请求者用 `ActiveAt` 只查服务器级禁言，目标用 `GuildMemberActive` 还查全局停用）。决定把读取深化为 store 读取模型：`ProfileView`（全局资料：共享服务器或平台管理员绕过）与 `GuildProfileView`（服务器上下文资料：请求者与目标均为该服务器活跃成员，组装服务器语音时长/经验/等级进度），HTTP 层塌缩为 解析参数 → 调用 → `errors.Is` 映射哨兵错误 → 写响应，四条 403/404 消息逐字保留。

## 谓词统一

请求者与目标统一使用 `GuildMemberActive` 一种定义，删除目标侧冗余的 `ActiveAt` 复查。全局封禁/停用会删除该用户全部会话，用户级状态对请求者实际永不生效，因此这是行为保持的收敛，消除"两种活跃定义"的分歧类。平台管理员绕过只存在于全局模式，服务器上下文模式保持严格成员资格（ADR 0016）。

## 错误谱系

新增两个哨兵错误 `ErrNotGuildMember`（→403 `not_guild_member`）与 `ErrProfileNotInSharedGuild`（→403 `not_in_shared_guild`），其余不活跃/不存在一律复用 `ErrNotFound`（→404），与仓库既有哨兵约定一致。

## Considered Options

- **新建 internal/profile 包**：为内容全是 SQL 谓词的模块引入一个假想 seam（只有一个 adapter），违背"一个 adapter = 假想 seam"的原则，否决。
- **单条富查询直读**：把 SQL 知识复制进读取模型且原语失去复用性；模块深度来自策略集中而非查询融合，组合现有原语（`GuildMembership` + `GuildMemberActive` + `UserProfile` + `SharedGuild` + 语音秒/经验查询 + `VoiceLevelAt`）足够，代价是请求者统一谓词后多一次索引查询，否决。
- **策略测试留在 HTTP 层**：测试面继续隔着中间件与脚手架，否决；策略断言下沉到 store 级，HTTP 层只保留哨兵→响应的薄映射测试。
