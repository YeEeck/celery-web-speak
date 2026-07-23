# 发版流程

本文档描述 Celery Web Speak 的版本发布步骤。每次发布新版本时，需按顺序完成以下操作。

## 版本号规范

项目使用语义化版本号（Semantic Versioning）：`MAJOR.MINOR.PATCH`。

- **MAJOR**：不兼容的 API 变更
- **MINOR**：向后兼容的功能新增
- **PATCH**：向后兼容的问题修复

## 发版步骤

### 1. 更新前端版本号

编辑 `web/package.json`，更新 `version` 字段：

```json
{
  "version": "0.4.0"
}
```

### 2. 更新后端版本常量

编辑 `internal/httpapi/changelog.go`，更新 `appVersion` 常量：

```go
const appVersion = "0.4.0"
```

> **注意**：前端 `package.json` 的 version 与后端 `appVersion` 常量必须保持一致。

### 3. 更新更新日志

编辑 `internal/httpapi/CHANGELOG.json`，在数组**顶部**追加新版本条目：

```json
[
  {
    "version": "0.4.0",
    "date": "2026-07-24",
    "changes": [
      "feat: 新增版本更新日志弹窗",
      "fix: 修复语音频道幽灵成员"
    ]
  }
]
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 版本号，与 package.json 一致，不含 `v` 前缀 |
| `date` | string | 发布日期，格式 `YYYY-MM-DD` |
| `changes` | string[] | 变更列表，每条带 `feat:` / `fix:` / `chore:` 等前缀 |

### 4. 构建与测试

```bash
go test ./...
cd web
npm ci
npm run typecheck
npm run build
```

### 5. 提交与打标签

```bash
git add -A
git commit -m "chore: 更新版本号到 v0.4.0"
git tag v0.4.0
```

### 6. 推送发布

```bash
git push origin dev
git push origin v0.4.0
```

推送 tag 后，GitHub Actions 会自动构建并推送 Docker 镜像到 GHCR。

## 版本更新日志弹窗行为

- 用户登录后首次进入当前版本时，应用自动弹窗展示更新日志
- 是否为「首次」由浏览器 `localStorage` 中 `cws.lastSeenVersion` 与当前版本比对决定
- 用户关闭弹窗后写入当前版本，同一版本不再自动弹出
- 用户可在「用户设置 → 账号」中点击「更新日志」手动查看
