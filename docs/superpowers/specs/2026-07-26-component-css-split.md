# 前端组件样式拆分设计

## 背景

当前前端样式全部位于 `web/src/styles.css`。主题变量、基础规则、共享控件、组件样式和响应式覆盖共用一个文件，新增或定位组件样式时需要在全局文件中搜索，也难以从目录结构判断样式所有权。

本次只调整样式文件组织，不改变界面视觉、选择器、作用域、交互或运行时依赖。

## 目录结构

样式入口迁移到 `web/src/styles/index.css`，由入口按固定顺序导入基础层、组件层和响应式覆盖：

```text
web/src/styles/
├── index.css
├── tokens.css
├── base.css
├── controls.css
├── overlays.css
├── responsive.css
└── components/
    ├── App.css
    ├── AuthScreen.css
    ├── AppShell.css
    ├── VoiceChannel.css
    ├── UserControls.css
    ├── UserAvatar.css
    ├── ChatPane.css
    ├── MemberList.css
    ├── ServerActionMenu.css
    ├── AccountMenu.css
    ├── dialogs.css
    ├── ProfilePanel.css
    ├── AdminPanel.css
    ├── PlatformServersPanel.css
    └── ChangelogModal.css
```

没有专属样式的 Vue 组件不创建空 CSS 文件。结构一致且共享组合规则的离开服务器与退出登录对话框归入 `dialogs.css`。

## 样式所有权

- `tokens.css` 保存根级过渡变量、明暗主题变量和强调色变量。
- `base.css` 保存 reset、页面根节点和原生元素基础规则。
- `controls.css` 保存跨组件复用的按钮、表单控件、状态文字和设置控件。
- `overlays.css` 保存模态遮罩、面板头尾等跨组件浮层骨架。
- `components/*.css` 保存对应 Vue 组件专属的选择器；跨组件组合选择器保留为一条规则，不复制声明。
- `responsive.css` 保存全部媒体查询，并由入口最后导入，继续覆盖基础层和组件层。

入口导入顺序必须保持现有层叠关系。迁移时不重命名选择器，不合并或展开声明，不引入 `scoped`、CSS Modules、Sass 或 `@layer`。

## 验收

1. 对比拆分前后的选择器、声明和层叠依赖，确认迁移没有遗漏或重复规则。
2. 运行前端类型检查和生产构建。
3. 在后端测试环境可用时运行现有桌面与移动端 Playwright 用例。
4. 重建 `internal/webui/dist`，并将生成物作为独立提交保存。

## 提交边界

1. `docs:` 提交本设计文档。
2. `refactor:` 提交样式源码拆分与入口调整。
3. `chore:` 提交重新生成的嵌入式前端静态产物。
