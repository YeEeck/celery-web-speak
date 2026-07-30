# profile handler 鉴权收紧：带 guild_id 即要求 target 是该 guild 成员

`/api/users/{id}/profile` 在请求带 `guild_id` 时，鉴权从"SharedGuild 或本人/平台管理员即可读"收紧为"target 必须是该 guild 成员，否则 403 target_not_guild_member"。这是为了让消息作者触发的卡片也能携带 guild 上下文回带服务器语音时长与等级条（与成员名单行、语音参与者行对齐），付出的代价是：**退服/被踢的原作者，其历史消息点击后将整体 403——头像、简介、在线时长、等级条全看不到**，而非只少一条等级条。原本 SharedGuild 路径下"退服作者仍可读全局 profile"的保守语义被有意舍弃。

## Considered Options

- **带 guild_id 仅用于回填 voiceSecondsTotal，鉴权不收紧**：保旧语义。被否——前端三个触发面会因 guild_id 有无而回带字段不一致，等级条出现"有时显示有时不显示"的漂移；统一收紧换一致展示。
- **保留 SharedGuild 可读、等级条在无 guild 切片时显示 0**：被否——"该作者已不在此服"还显示 Lv.0 是语义错位，且与"等级是服务器级"矛盾。