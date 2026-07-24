# 服务器栏布局重构

## 背景

当前 `.server-rail` 为单段 flex 列布局，所有元素（服务器列表、分隔线、创建按钮、管理按钮、连接状态）
平铺排列且均为 `flex: 0 0 auto`，无 overflow 处理。当服务器数量超过约 11 个时，底部元素被推出视口
且无法滚动回来，按钮直接丢失。

此外，v0.4 多服务器功能移除了原有的项目 LOGO（commit `649ea28` 引入、`9d6403c` 移除），
需要恢复以增强品牌识别。

## 设计决策

| 项目 | 结论 |
|------|------|
| 整体结构 | 两段式：固定顶部区 + 可滚动列表区 |
| LOGO | 纯装饰，恢复 v0.4 前形态（46px 圆角方块 + `/favicon.svg`），保留 hover 效果，无点击行为 |
| 连接状态 | 紧贴 LOGO 正下方（原位于 rail 最底部） |
| 分隔线① | LOGO/状态 与 管理按钮之间，始终显示 |
| 平台管理按钮 | 仅管理员可见，位于分隔线①下方 |
| 分隔线② | 管理按钮 与 服务器列表之间，条件渲染（非管理员时与管理按钮一同隐藏） |
| 服务器列表 | 放入独立滚动容器，`flex:1; min-height:0; overflow-y:auto`，滚动条隐藏 |
| 创建按钮 | 仅管理员，作为滚动容器内最后一项，跟随滚动（Discord 风格） |
| 滚动条 | 隐藏（`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`） |
| 移动端 | 不受影响（rail 在 ≤760px 时 `display: none`） |

## 目标布局

```
[LOGO]          ← 46px 圆角方块，favicon.svg
[📡 连接状态]
───────────     ← 分隔线①（始终）
[⚙ 平台管理]    ← 仅管理员
───────────     ← 分隔线②（仅管理员）
┌ 滚动区域 ─┐
│ 服务器…    │
│ [+] 创建   │  ← 仅管理员，跟随滚动
└────────────┘
```

非管理员视图坍缩为：LOGO → 状态 → 分隔线① → 滚动列表。

## 变更范围

### 前端

- `web/src/components/AppShell.vue` — 重构 `<nav class="server-rail">` 内 DOM 顺序：
  LOGO（装饰性 span + img）→ 状态 → 分隔线① → 管理按钮 → 分隔线②（v-if）→
  滚动容器（`.rail-scroll`，内含服务器 v-for + 创建按钮）
- `web/src/styles.css` — `.server-rail` 保持 flex column；新增 `.rail-scroll`
  （flex:1, min-height:0, overflow-y:auto, 隐藏滚动条, 内部 flex column + gap）；
  新增 `.rail-logo` 样式（复用 server-button 视觉，去除 button 语义）
