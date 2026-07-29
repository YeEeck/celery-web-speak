# 滚动条浏览器兼容策略

## 背景

Chrome 121 起支持 `scrollbar-width` 和 `scrollbar-color`。当这两个标准属性取非
`auto` 值时，Chromium 会用标准滚动条绘制覆盖 `::-webkit-scrollbar-*`，导致
Windows Chrome 仍显示原生上下箭头，即使 `::-webkit-scrollbar-button` 的计算样式
为 `display: none`。

## 决策

- Chromium 与 Safari 仅使用 `::-webkit-scrollbar-*`，由伪元素控制宽度、轨道、滑块
  和按钮。
- Firefox 不支持 WebKit 滚动条伪元素，通过
  `@supports not selector(::-webkit-scrollbar)` 使用 `scrollbar-width` 和
  `scrollbar-color`。
- 消息编辑器保留 `scrollbar-gutter: stable`，但不在 Chromium 中设置标准滚动条宽度
  与颜色；其 `6px` 宽度和聚焦态继续由 WebKit 伪元素负责。
- 不实现自绘滚动条；滚动、键盘操作及辅助技术语义继续由浏览器原生滚动容器提供。

## 验收标准

- Windows Chrome 的垂直滚动条不显示原生上下箭头。
- Chromium 中标准滚动条属性保持初始值，WebKit 滚动条规则生效。
- Firefox 继续使用细滚动条、透明轨道和主题对应的滑块颜色。
- 消息编辑器保持 `6px` 滚动条、稳定 gutter，并在聚焦或悬停时增强滑块对比度。
- 服务器栏隐藏滚动条的既有特例不受影响。
