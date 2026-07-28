# 服务器图标复用圆形遮罩 cropper 但以圆角矩形展示

服务器图标复用用户头像的 cropper(`ImageCropperModal.vue`,由 `AvatarCropperModal.vue` 重构而来),其预览遮罩沿用 `border-radius: 50%` 的正圆;而服务器图标在 sidebar(`.guild-button` 46px / `border-radius: 10px`)、平台面板列表(`.guild-initial` 38px / `border-radius: 4px`)、平台面板详情(`.platform-guild-mark` 52px / `border-radius: 6px`)等所有展示位均为圆角矩形。也就是说用户在 cropper 里看到的圆形预览与最终展示的圆角矩形**不严格一致**。

接受这一不对称,理由:cropper 输出始终是 512×512 方形 WebP,方形源图可被 CSS 任意 `border-radius` 裁剪展示,圆形预览只是视觉引导;真实图标(logo)通常自带角部留白,圆/圆角矩形展示差异极小;复用同一个 cropper 组件避免用户头像与服务器图标两套裁剪逻辑分裂,对称性优先。未来若要把预览遮罩改为圆角矩形,须同时更新用户头像与服务器图标两处调用方,且用户头像的展示形态仍是正圆,会反向引入新的不对称,因此本次决策不易反转。

## 考虑过的备选与取舍

- **给 cropper 加 `shape: 'circle' | 'rounded'` prop**:技术上可行,但会让一个本应简单的裁剪组件因一个视觉 prop 分叉;且服务器图标各展示位的圆角值还不一致(4/6/10px),没有一个"正确的圆角"可以传。舍弃。
- **新建独立的 `GuildIconCropperModal.vue`**:复制一份几乎完全相同的组件,仅改预览 `border-radius` 与文案。重复代码、后续维护要双改。舍弃。