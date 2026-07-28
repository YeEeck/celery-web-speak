# 头像存储为 SQLite BLOB 且后端仅校验不二次编码

为支持用户自定义头像,在 `users` 表新增 `avatar_version`(单调计数,上传与删除各 +1,不归零)、`avatar_bytes BLOB NULL`、`avatar_mime TEXT NULL`。头像字节直接 BLOB 存入 SQLite,沿用单一二进制部署与 `SetMaxOpenConns(1)` 的串行写入模型。后端用 `image.DecodeConfig` 解析图头校验尺寸 ≤1024×1024、宽高比 1:1 容差 <0.02、MIME ∈ {image/png,image/jpeg,image/webp},但**不二次编码**;前端负责输出 512×512 方形 WebP(q≈85),字节原样入库。

User JSON 携带单调 `avatarVersion` 与派生 `hasAvatar`,读取路由为 `GET /api/users/{id}/avatar?v={avatarVersion}` 并配 `Cache-Control: public, max-age=31536000, immutable`;版本不归零是为了避免"删除-再上传"循环后 URL 复用导致 stale cache。上传为 `POST /api/me/avatar`(multipart)、本人删除为 `DELETE /api/me/avatar`,二者后均 `BroadcastUser("user_updated", user)` 通知所有客户端刷新。平台管理员可通过 `requirePlatformAdmin` 保护的 `DELETE /api/users/{id}/avatar` 移除他人头像,`MemberAdminTab.vue` 暴露「移除头像」动作满足内容审核场景。

## 考虑过的备选与取舍

- **文件系统目录存储**:DB 只存指向,字节落盘。需新增 `config`(存储路径)与一次 Docker 卷挂载,且权限/备份要单独处理;与项目"单一二进制、SQLite 即数据库"的部署气质冲突。舍弃。
- **后端二次编码为规范 512×512 WebP 并派生缩略**:更彻底的"信任零客户端"姿态,但引入编译期依赖、运行时 CPU 与写入路径(多版本 BLOB 或缩放路由)的复杂度;用户体验受服务器 CPU 限制。当前取舍:相信客户端裁剪与压缩输出,服务端仅在校验层防御性拒绝越界。
- **仅信任 multipart Content-Type 而不解析图头**:实现最少,但任何 `curl` 都能伪装 `Content-Type: image/webp` 上传任意字节绕过尺寸/比例限制,违反"后端接口加好限制"的产品需求。舍弃。
- **不允许 WebP、仅接受 PNG/JPEG(标准库)**:零新依赖,但 512×512 PNG/JPEG 文件显著大于 WebP,JPEG 还丢 alpha。新增 `golang.org/x/image` 的成本只有一行 `_ "golang.org/x/image/webp"` 注册,性价比足够。舍弃。