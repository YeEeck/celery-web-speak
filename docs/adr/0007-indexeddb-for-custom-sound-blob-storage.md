# 引入 IndexedDB 承担自定义提示音的 blob 存储

加入语音、退出语音与新文字消息三类操作提示音新增了"自定义音效"——用户为本机浏览器上传一个音频文件作为该事件的提示音来源。在此之前项目所有本地偏好（音频、音效、主题、按用户音量等）都使用 `localStorage`，但二进制音频文件塞不进 `localStorage` 的 5 MB 配额且会与其余键值混杂。引入 IndexedDB，建立一个 `cws.sounds` 数据库、单个 `customSounds` 对象存储，以事件名（`join`/`leave`/`message`）为主键、每条记录持有原始 Blob 与基本元数据。其他本地偏好仍留在 `localStorage`，IndexedDB 仅承担自定义音效 blob 这一项职责，避免在未明确需要的领域扩散使用。