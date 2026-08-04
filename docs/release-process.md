# 发版流程

本文档描述 Celery Web Speak 的版本发布步骤。每次发布新版本时，需按顺序完成以下操作。

## 版本号规范

项目使用语义化版本号（Semantic Versioning）：`MAJOR.MINOR.PATCH`。

- **MAJOR**：不兼容的 API 变更
- **MINOR**：向后兼容的功能新增
- **PATCH**：向后兼容的问题修复

## 发版步骤

以下示例以 `v0.4.4` 为目标版本。执行实际发版时，将示例版本和日期替换为目标值。

### 1. 更新前端包版本

编辑 `web/package.json`，并同步更新 `web/package-lock.json` 顶层及根包的 `version` 字段：

```json
{
  "version": "0.4.4"
}
```

### 2. 更新后端版本常量

编辑 `internal/httpapi/changelog.go`，更新 `appVersion` 常量：

```go
const appVersion = "0.4.4"
```

> **注意**：`web/package.json`、`web/package-lock.json` 的根包版本与后端 `appVersion` 常量必须保持一致。

### 3. 同步发布文档版本号

将 `README.md` 和 `docs/deployment.md` 中指向当前稳定版本的版本号同步更新为目标版本，包括：

- 当前稳定版本说明
- `git clone`、`git fetch` 和 `git checkout` 命令中的仓库标签
- `APP_IMAGE` 示例中的镜像标签
- 更新与回滚章节中的目标版本示例

例如，发布 `v0.4.4` 时，文档中的稳定版本、仓库标签和应用镜像标签都应使用 `v0.4.4`。历史版本的更新说明和升级路径不属于当前稳定版本引用，不要批量替换。

可在提交前检查目标版本和上一个稳定版本的引用，确认所有当前版本示例均已同步：

```bash
rg -n 'v0\.4\.4|v<上一个稳定版本>' README.md docs/deployment.md
```

### 4. 更新更新日志

编辑 `internal/httpapi/CHANGELOG.json`，在数组**顶部**追加新版本条目：

```json
[
  {
    "version": "0.4.4",
    "date": "2026-07-25",
    "changes": [
      "fix: 修正服务器成员管理权限提示",
      "fix: 显示服务器角色与平台管理员双重身份"
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

### 5. 构建与测试

> `internal/webui/dist` 是构建产物（由 `npm run build` 生成、经 `go:embed` 嵌入 Go 服务），不入库；`go test` 前需先完成前端构建。

```bash
cd web
npm ci
npm run typecheck
npm run build
cd ..
go test ./...
```

### 6. 提交与打标签

```bash
git add -A
git commit -m "chore: 更新版本号到 v0.4.4"
git tag v0.4.4
```

### 7. 推送发布

```bash
git push --atomic origin dev v0.4.4
```

原子推送确保 `dev` 和 tag 同时成功或同时失败。推送 tag 后，GitHub Actions 会自动构建并推送 Docker 镜像到 GHCR。

## 版本更新日志弹窗行为

- 用户登录后首次进入当前版本时，应用自动弹窗展示更新日志
- 是否为「首次」由浏览器 `localStorage` 中 `cws.lastSeenVersion` 与当前版本比对决定
- 用户关闭弹窗后写入当前版本，同一版本不再自动弹出
- 用户可在「用户设置 → 账号」中点击「更新日志」手动查看
