# 语音经验管理策略集中于 store,HTTP 层只做映射(扩展 ADR-0019 原则到兄弟路径)

`handleGuildMemberVoiceXP` 原先在 handler 内重复实现 `SetGuildMemberVoiceXP` 事务内已强制执行的授权策略:目标成员关系查询、活跃谓词、角色矩阵、XP 边界检查共约 30 行,与 store 事务重检形成两份可漂移的实现。ADR-0019 的"策略集中在 store 读取模型、HTTP 层只做映射"原则统一了个人资料读取路径,但未应用到这条兄弟路径。决定:删除 handler 预检,策略唯一收归于 store 事务,HTTP 层塌缩为 解析参数 → 调用 → `writeStoreError` 哨兵映射 → 组装响应。

## 三闸门格局

- **路由闸(保留)**:中间件 `requireGuildVoiceXPAdmin` 校验"服务器管理员或平台管理员",守护路由可达性;普通成员请求在此被 403 拒绝。
- **事务闸(唯一策略实现)**:`SetGuildMemberVoiceXP` 在事务内重检 actor 状态、目标活跃、角色矩阵与 XP 边界,防并发角色变更绕过(TOCTOU)。
- **handler 预检(删除)**:目标成员关系、`GuildMemberActive`、角色矩阵、边界检查与事务闸谓词完全一致,是冗余第三份,删除。

## 行为差异(已接受)

- **403 文案**:从 handler 的"无权管理该服务器成员"变为 `writeStoreError` 的"无权管理该服务器成员的语音经验"(auth.go 已有映射),状态码与错误码不变。
- **错误优先级**:非法 XP(如 -1)且目标不存在/被封禁时,由"404 先于 400"变为"400 先于 404"——store 先检查边界再解析目标;输入校验先于领域解析更合理,现有测试未覆盖此组合。

## VoiceProgress 组装收敛

新增 `store.VoiceProgressAt(xp)` 纯函数(voice_level.go,与 `VoiceLevelAt` 同居),个人资料读取模型(profile.go)与语音经验响应组装共用,消除第二处重复组装。`服务器语音等级` 是 CONTEXT.md 定义的纯函数(闭式解 + 回退检验),组装收敛进其归属模块。

## 测试下沉

沿用 ADR-0019 测试模式:canManage 角色矩阵断言下沉到 store 级(presence_test.go 新增普通成员/admin 目标/owner 目标/平台管理员 actor 矩阵),HTTP 层保留哨兵→响应的薄映射测试,原有状态码断言逐字保留。

## Considered Options

- **保留 handler 预检**:与事务闸两份实现可漂移,预检相对事务重检是死重,否决。
- **`SetGuildMemberVoiceXP` 直接返回 `VoiceProgress` 字段**:接口承载可推导数据,且个人资料读取模型的组装仍需独立完成,重复不消除,否决。
- **中间件承担角色矩阵**:角色矩阵需要目标角色与 actor 身份,路由闸与目标无关,职责错配,否决。
