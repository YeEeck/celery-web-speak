# 用户设置面板分类重组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将扁平的 4-section 用户设置面板重组为 4 个顶部 Tab（账号/音频/音效/主题），音频 Tab 内部用左栏分输入/输出子组，同时新增音频处理开关（回声抑制、降噪）、提示音预置选择和主题切换功能。

**Architecture:** 纯前端改动，后端不动。所有新设置项持久化到 localStorage。新增 `theme.ts` store 管理主题模式与强调色。`voice.ts` 暴露回声抑制/降噪开关。`sounds.ts` 增加预置音效库与按事件选择。`ProfilePanel.vue` 重写为 Tab 布局。`styles.css` 重构为 `[data-theme]` 主题变量 + `[data-accent]` 强调色覆盖。

**Tech Stack:** Vue 3 + Pinia + TypeScript + vue-tsc（类型检查）+ Playwright（e2e）。无单元测试框架，逐任务验证用 `npm run typecheck`。

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `web/src/stores/theme.ts` | 主题模式（系统/亮/暗）+ 强调色预设，持久化 + 应用到 `<html>` | 新建 |
| `web/src/stores/voice.ts` | 新增 `echoCancellation` / `noiseSuppression` ref + setter，Room 构造时读取 | 修改 |
| `web/src/stores/sounds.ts` | 新增预置音效库 + 按事件选择 preset，`scheduleSound` 使用选中 preset | 修改 |
| `web/src/components/ProfilePanel.vue` | 重写为 Tab 布局，4 个 Tab + 音频 Tab 内左栏子组 | 修改 |
| `web/src/styles.css` | `:root` 重构为 `[data-theme]` 块 + `[data-accent]` 覆盖 + `.profile-tabs` / `.profile-audio-layout` CSS | 修改 |
| `web/src/main.ts` | 启动时初始化主题 store | 修改 |
| `web/e2e/smoke.spec.ts` | 更新已有测试适配 Tab 导航 + 新增测试 | 修改 |
| `README.md` | 更新"客户端音频设置"章节 + 新增主题章节 | 修改 |

---

## Task 1: 创建计划文档与功能分支

**Files:**
- Create: `docs/superpowers/plans/2026-07-20-profile-settings-reorganization.md`（本文件）

- [ ] **Step 1: 确认当前分支干净**

Run: `git status --short`
Expected: 无未提交改动（或只有本文件）

- [ ] **Step 2: 创建功能分支**

Run: `git checkout -b feat/profile-settings-reorganization`
Expected: 切换到新分支

- [ ] **Step 3: 提交计划文档**

```bash
git add docs/superpowers/plans/2026-07-20-profile-settings-reorganization.md
git commit -m "docs: 用户设置面板分类重组实施计划"
```

---

## Task 2: 主题 store（`web/src/stores/theme.ts`）

**Files:**
- Create: `web/src/stores/theme.ts`

- [ ] **Step 1: 创建 theme store 文件**

```ts
import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'system' | 'light' | 'dark'
export type AccentPreset = 'indigo' | 'green' | 'rose' | 'amber'

const MODE_KEY = 'cws.theme.mode'
const ACCENT_KEY = 'cws.theme.accent'
const DEFAULT_MODE: ThemeMode = 'system'
const DEFAULT_ACCENT: AccentPreset = 'indigo'

const mediaQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(getSavedMode())
  const accent = ref<AccentPreset>(getSavedAccent())
  let mediaListener: ((event: MediaQueryListEvent) => void) | null = null

  function resolveMode(target: ThemeMode): 'light' | 'dark' {
    if (target === 'system') return mediaQuery?.matches ? 'light' : 'dark'
    return target
  }

  function apply() {
    const resolved = resolveMode(mode.value)
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.setAttribute('data-accent', accent.value)
  }

  function watchMedia() {
    if (mediaListener || !mediaQuery) return
    mediaListener = () => {
      if (mode.value === 'system') apply()
    }
    mediaQuery.addEventListener('change', mediaListener)
  }

  function unwatchMedia() {
    if (mediaListener && mediaQuery) mediaQuery.removeEventListener('change', mediaListener)
    mediaListener = null
  }

  function initialize() {
    apply()
    watchMedia()
  }

  function setMode(next: ThemeMode) {
    mode.value = next
    localStorage.setItem(MODE_KEY, next)
    apply()
  }

  function setAccent(next: AccentPreset) {
    accent.value = next
    localStorage.setItem(ACCENT_KEY, next)
    apply()
  }

  return { mode, accent, initialize, setMode, setAccent }
})

function getSavedMode(): ThemeMode {
  const saved = localStorage.getItem(MODE_KEY)
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return DEFAULT_MODE
}

function getSavedAccent(): AccentPreset {
  const saved = localStorage.getItem(ACCENT_KEY)
  if (saved === 'indigo' || saved === 'green' || saved === 'rose' || saved === 'amber') return saved
  return DEFAULT_ACCENT
}
```

- [ ] **Step 2: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS（新文件不破坏现有类型）

- [ ] **Step 3: 提交**

```bash
git add web/src/stores/theme.ts
git commit -m "feat: 新增主题 store 管理主题模式与强调色"
```

---

## Task 3: 主题 CSS 基础设施（`web/src/styles.css`）

**Files:**
- Modify: `web/src/styles.css` lines 1-24（`:root` 块重构为 `[data-theme]` + `[data-accent]`）

- [ ] **Step 1: 重构 `:root` 为主题变量块**

将 `web/src/styles.css` 的第 1-24 行（`:root { ... }` 块）替换为以下内容：

```css
:root {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

[data-theme="dark"] {
  color-scheme: dark;
  --rail: #1e1f22;
  --sidebar: #2b2d31;
  --main: #313338;
  --panel: #232428;
  --elevated: #383a40;
  --input: #1e1f22;
  --hover: #35373c;
  --active: #404249;
  --line: #3f4147;
  --text: #f2f3f5;
  --muted: #b5bac1;
  --faint: #80848e;
  --green: #23a559;
  --yellow: #f0b232;
  --red: #da373c;
  --red-hover: #a1282c;
}

[data-theme="light"] {
  color-scheme: light;
  --rail: #ffffff;
  --sidebar: #f2f3f5;
  --main: #ffffff;
  --panel: #f2f3f5;
  --elevated: #ebedef;
  --input: #dcdee1;
  --hover: #e0e1e5;
  --active: #d4d7dc;
  --line: #dcdee1;
  --text: #060607;
  --muted: #596162;
  --faint: #94989c;
  --green: #1d8a47;
  --yellow: #c69520;
  --red: #c0343a;
  --red-hover: #8f262b;
}

[data-accent="indigo"] {
  --brand: #5865f2;
  --brand-hover: #4752c4;
}

[data-accent="green"] {
  --brand: #23a559;
  --brand-hover: #1c8748;
}

[data-accent="rose"] {
  --brand: #e64855;
  --brand-hover: #c13a45;
}

[data-accent="amber"] {
  --brand: #d4a32e;
  --brand-hover: #a8821f;
}
```

注意：`--brand` 和 `--brand-hover` 从原 `:root` 中移除，改为由 `[data-accent]` 提供。原 `:root` 中的其他变量（`--green`、`--yellow`、`--red`、`--red-hover`）移入各主题块（暗色用原值，亮色用调整后的值）。

- [ ] **Step 2: 运行类型检查与构建**

Run: `cd web && npm run typecheck && npm run build`
Expected: PASS（CSS 变量重构不影响 TS 类型；构建应成功）

- [ ] **Step 3: 提交**

```bash
git add web/src/styles.css
git commit -m "feat: styles.css 重构为 data-theme 主题块与 data-accent 强调色覆盖"
```

---

## Task 4: 应用启动时初始化主题（`web/src/main.ts`）

**Files:**
- Modify: `web/src/main.ts`

- [ ] **Step 1: 在 mount 之前初始化主题**

将 `web/src/main.ts` 替换为：

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import { useThemeStore } from './stores/theme'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
useThemeStore().initialize()
app.mount('#app')
```

- [ ] **Step 2: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add web/src/main.ts
git commit -m "feat: 应用启动时初始化主题 store"
```

---

## Task 5: 音频处理开关（`web/src/stores/voice.ts`）

**Files:**
- Modify: `web/src/stores/voice.ts`

- [ ] **Step 1: 添加 localStorage 键常量与默认值**

在 `web/src/stores/voice.ts` 的第 24 行（`const DEAFENED_ATTRIBUTE = 'deafened'` 之后）添加：

```ts
const ECHO_CANCELLATION_KEY = 'cws.echoCancellation'
const NOISE_SUPPRESSION_KEY = 'cws.noiseSuppression'
```

- [ ] **Step 2: 添加 ref 与读取逻辑**

在 `voice.ts` 的 `outputVolume` ref 声明之后（约第 53 行，`const outputVolume = ref(getSavedLevel(OUTPUT_VOLUME_KEY))` 之后）添加：

```ts
  const echoCancellation = ref(getSavedBoolean(ECHO_CANCELLATION_KEY, true))
  const noiseSuppression = ref(getSavedBoolean(NOISE_SUPPRESSION_KEY, true))
```

- [ ] **Step 3: 在 Room 构造中使用 ref 值**

将 `voice.ts` 第 83-88 行的 `audioCaptureDefaults` 块：

```ts
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
```

替换为：

```ts
        audioCaptureDefaults: {
          echoCancellation: echoCancellation.value,
          noiseSuppression: noiseSuppression.value,
          autoGainControl: true,
          channelCount: 1,
        },
```

- [ ] **Step 4: 添加 setter 函数**

在 `voice.ts` 的 `setOutputVolume` 函数之后（约第 229 行）添加：

```ts
  function setEchoCancellation(value: boolean) {
    echoCancellation.value = value
    localStorage.setItem(ECHO_CANCELLATION_KEY, String(value))
  }

  function setNoiseSuppression(value: boolean) {
    noiseSuppression.value = value
    localStorage.setItem(NOISE_SUPPRESSION_KEY, String(value))
  }
```

- [ ] **Step 5: 在 store 返回对象中暴露新属性与函数**

在 `voice.ts` 的 return 块中（约第 427-455 行），在 `outputVolume,` 之后添加：

```ts
    echoCancellation,
    noiseSuppression,
```

在 `setOutputVolume,` 之后添加：

```ts
    setEchoCancellation,
    setNoiseSuppression,
```

- [ ] **Step 6: 添加 `getSavedBoolean` 辅助函数**

在 `voice.ts` 文件底部的辅助函数区域（`getSavedLevel` 函数之后，约第 466 行）添加：

```ts
function getSavedBoolean(key: string, defaultValue: boolean) {
  const saved = localStorage.getItem(key)
  if (saved === null) return defaultValue
  return saved !== 'false'
}
```

- [ ] **Step 7: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add web/src/stores/voice.ts
git commit -m "feat: voice store 暴露回声抑制与降噪开关并持久化到 localStorage"
```

---

## Task 6: 提示音预置库（`web/src/stores/sounds.ts`）

**Files:**
- Modify: `web/src/stores/sounds.ts`

- [ ] **Step 1: 定义预置音效库与类型**

在 `web/src/stores/sounds.ts` 的 `const STORAGE_PREFIX = 'cws.notificationSounds'` 之后（第 8 行之后）添加：

```ts
export type SoundPresetId = 'rise-duo' | 'fall-duo' | 'bright-single' | 'low-pulse' | 'gentle-triple'

interface NotePattern { delay: number; duration: number; from: number; to: number }

export const SOUND_PRESETS: Record<SoundPresetId, { name: string; notes: NotePattern[] }> = {
  'rise-duo': {
    name: '上升双音',
    notes: [
      { delay: 0, duration: 0.1, from: 440, to: 500 },
      { delay: 0.075, duration: 0.14, from: 620, to: 700 },
    ],
  },
  'fall-duo': {
    name: '下降双音',
    notes: [
      { delay: 0, duration: 0.1, from: 560, to: 500 },
      { delay: 0.075, duration: 0.15, from: 390, to: 320 },
    ],
  },
  'bright-single': {
    name: '清脆单音',
    notes: [
      { delay: 0, duration: 0.13, from: 720, to: 840 },
    ],
  },
  'low-pulse': {
    name: '低沉脉冲',
    notes: [
      { delay: 0, duration: 0.18, from: 280, to: 220 },
      { delay: 0.12, duration: 0.18, from: 280, to: 220 },
    ],
  },
  'gentle-triple': {
    name: '柔和三音',
    notes: [
      { delay: 0, duration: 0.1, from: 520, to: 560 },
      { delay: 0.08, duration: 0.1, from: 620, to: 660 },
      { delay: 0.16, duration: 0.12, from: 740, to: 780 },
    ],
  },
}

const DEFAULT_PRESETS: Record<NotificationSound, SoundPresetId> = {
  join: 'rise-duo',
  leave: 'fall-duo',
  message: 'bright-single',
}
```

- [ ] **Step 2: 删除旧的硬编码 `soundNotes` 常量**

删除 `sounds.ts` 第 10-22 行的 `const soundNotes: Record<NotificationSound, ...>` 块（已被 `SOUND_PRESETS` + `DEFAULT_PRESETS` 取代）。

- [ ] **Step 3: 添加按事件的 preset 选择状态**

在 `sounds.ts` 的 store 内部，`messageEnabled` ref 之后（约第 29 行）添加：

```ts
  const joinPreset = ref<SoundPresetId>(getSavedPreset('join'))
  const leavePreset = ref<SoundPresetId>(getSavedPreset('leave'))
  const messagePreset = ref<SoundPresetId>(getSavedPreset('message'))
```

- [ ] **Step 4: 添加 preset setter**

在 `sounds.ts` 的 `setSoundEnabled` 函数之后（约第 82 行）添加：

```ts
  function setSoundPreset(sound: NotificationSound, preset: SoundPresetId) {
    if (sound === 'join') joinPreset.value = preset
    if (sound === 'leave') leavePreset.value = preset
    if (sound === 'message') messagePreset.value = preset
    localStorage.setItem(`${STORAGE_PREFIX}.preset.${sound}`, preset)
  }
```

- [ ] **Step 5: 修改 `scheduleSound` 使用选中的 preset**

将 `sounds.ts` 底部的 `scheduleSound` 函数签名与首行（约第 144-150 行）：

```ts
function scheduleSound(context: AudioContext, sound: NotificationSound, volume: number) {
  const start = context.currentTime + 0.005
  const master = context.createGain()
  master.gain.setValueAtTime(volume * 0.18, start)
  master.connect(context.destination)

  const notes = soundNotes[sound]
```

替换为：

```ts
function scheduleSound(context: AudioContext, sound: NotificationSound, volume: number, preset: SoundPresetId) {
  const start = context.currentTime + 0.005
  const master = context.createGain()
  master.gain.setValueAtTime(volume * 0.18, start)
  master.connect(context.destination)

  const notes = SOUND_PRESETS[preset].notes
```

- [ ] **Step 6: 更新 `play` 函数传入 preset**

在 `sounds.ts` 的 `play` 函数中，找到调用 `scheduleSound` 的行（约第 62 行）：

```ts
      scheduleSound(target, sound, volume.value)
```

替换为：

```ts
      scheduleSound(target, sound, volume.value, getSoundPreset(sound))
```

- [ ] **Step 7: 添加 `getSoundPreset` 辅助函数**

在 `sounds.ts` 的 `isSoundEnabled` 函数之后（约第 108 行）添加：

```ts
  function getSoundPreset(sound: NotificationSound): SoundPresetId {
    if (sound === 'join') return joinPreset.value
    if (sound === 'leave') return leavePreset.value
    return messagePreset.value
  }
```

- [ ] **Step 8: 在 store 返回对象中暴露新属性与函数**

在 `sounds.ts` 的 return 块中，`messageEnabled,` 之后添加：

```ts
    joinPreset,
    leavePreset,
    messagePreset,
```

在 `setSoundEnabled,` 之后添加：

```ts
    setSoundPreset,
```

- [ ] **Step 9: 添加 `getSavedPreset` 辅助函数**

在 `sounds.ts` 底部的 `saveBoolean` 函数之后（约第 182 行）添加：

```ts
function getSavedPreset(sound: NotificationSound): SoundPresetId {
  const saved = localStorage.getItem(`${STORAGE_PREFIX}.preset.${sound}`)
  if (saved && saved in SOUND_PRESETS) return saved as SoundPresetId
  return DEFAULT_PRESETS[sound]
}
```

- [ ] **Step 10: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add web/src/stores/sounds.ts
git commit -m "feat: sounds store 新增预置音效库与按事件选择"
```

---

## Task 7: ProfilePanel Tab 骨架与 CSS（`web/src/components/ProfilePanel.vue` + `web/src/styles.css`）

**Files:**
- Modify: `web/src/components/ProfilePanel.vue`（完整重写模板与脚本）
- Modify: `web/src/styles.css`（新增 `.profile-tabs` 与 `.profile-audio-layout` CSS）

- [ ] **Step 1: 在 styles.css 添加 Tab 与音频布局 CSS**

在 `web/src/styles.css` 的 `.admin-tabs button.active { ... }` 行之后（约第 209 行）添加：

```css
.profile-tabs { display: flex; gap: 2px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: #292a2e; }
.profile-tabs button { min-height: 34px; border: 0; border-radius: 4px; padding: 0 12px; display: flex; align-items: center; gap: 7px; color: var(--muted); background: transparent; cursor: pointer; }
.profile-tabs button:hover { color: var(--text); background: var(--hover); }
.profile-tabs button.active { color: white; background: var(--active); }
.profile-audio-layout { display: grid; grid-template-columns: 200px minmax(0,1fr); gap: 20px; }
.profile-audio-nav { padding-right: 10px; border-right: 1px solid var(--line); }
.profile-audio-nav button { width: 100%; min-height: 42px; padding: 0 12px; border: 0; border-radius: 4px; background: transparent; display: flex; align-items: center; gap: 8px; color: var(--muted); text-align: left; cursor: pointer; }
.profile-audio-nav button:hover { background: var(--hover); color: var(--text); }
.profile-audio-nav button.active { background: var(--active); color: var(--text); }
.profile-save-row { display: flex; align-items: center; gap: 12px; }
.profile-save-row .primary-button { min-height: 34px; padding: 0 14px; }
.profile-hint { color: var(--faint); font-size: 11px; }
```

- [ ] **Step 2: 在 styles.css 移动端 fallback 中添加规则**

在 `web/src/styles.css` 的 `@media (max-width: 760px)` 块中，`.sound-toggle-list { grid-template-columns: 1fr; }` 之后添加：

```css
  .profile-audio-layout { grid-template-columns: 1fr; gap: 12px; }
  .profile-audio-nav { display: flex; gap: 4px; padding: 0 0 10px; border: 0; border-bottom: 1px solid var(--line); }
  .profile-audio-nav button { flex: 1; justify-content: center; }
  .profile-tabs { overflow-x: auto; }
  .profile-tabs button { white-space: nowrap; }
```

- [ ] **Step 3: 重写 ProfilePanel.vue 脚本部分**

将 `web/src/components/ProfilePanel.vue` 的 `<script setup lang="ts">` 块（第 1-44 行）替换为：

```ts
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { BellRing, Headphones, Mic, Palette, Save, UserRound, X } from '@lucide/vue'
import { useAppStore } from '../stores/app'
import { useSoundStore, type NotificationSound } from '../stores/sounds'
import { useThemeStore } from '../stores/theme'
import { useVoiceStore } from '../stores/voice'

defineEmits<{ close: [] }>()
const app = useAppStore()
const voice = useVoiceStore()
const sounds = useSoundStore()
const theme = useThemeStore()
const tab = ref<'account' | 'audio' | 'sound' | 'theme'>('account')
const audioSubNav = ref<'input' | 'output'>('input')

const displayName = ref(app.user!.displayName)
const currentPassword = ref('')
const newPassword = ref('')
const savingDisplayName = ref(false)
const savingPassword = ref(false)
const displayNameMessage = ref('')
const displayNameError = ref('')
const passwordMessage = ref('')
const passwordError = ref('')

onMounted(() => void voice.refreshDevices(false))

async function saveDisplayName() {
  if (!displayName.value.trim()) return
  savingDisplayName.value = true
  displayNameMessage.value = ''
  displayNameError.value = ''
  try {
    await app.updateProfile({ displayName: displayName.value })
    displayNameMessage.value = '显示名称已保存'
  } catch (error) {
    displayNameError.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    savingDisplayName.value = false
  }
}

async function savePassword() {
  if (newPassword.value.length < 10) {
    passwordError.value = '新密码至少 10 位'
    return
  }
  savingPassword.value = true
  passwordMessage.value = ''
  passwordError.value = ''
  try {
    await app.updateProfile({
      displayName: app.user!.displayName,
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    currentPassword.value = ''
    newPassword.value = ''
    passwordMessage.value = '密码已更新'
  } catch (error) {
    passwordError.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    savingPassword.value = false
  }
}

function setSoundEnabled(sound: NotificationSound, event: Event) {
  sounds.setSoundEnabled(sound, (event.target as HTMLInputElement).checked)
}
</script>
```

- [ ] **Step 4: 重写 ProfilePanel.vue 模板部分**

将 `web/src/components/ProfilePanel.vue` 的 `<template>` 块（第 46-141 行）替换为：

```html
<template>
  <div class="modal-backdrop" @mousedown.self="$emit('close')">
    <section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <header class="panel-header">
        <div><h2 id="profile-title">用户设置</h2><p>@{{ app.user!.username }}</p></div>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <nav class="profile-tabs">
        <button :class="{ active: tab === 'account' }" @click="tab = 'account'"><UserRound :size="17" />账号</button>
        <button :class="{ active: tab === 'audio' }" @click="tab = 'audio'"><Mic :size="17" />音频</button>
        <button :class="{ active: tab === 'sound' }" @click="tab = 'sound'"><BellRing :size="17" />音效</button>
        <button :class="{ active: tab === 'theme' }" @click="tab = 'theme'"><Palette :size="17" />主题</button>
      </nav>
      <div class="settings-scroll">
        <section v-if="tab === 'account'" class="settings-section">
          <h3><UserRound :size="18" />个人资料</h3>
          <label><span>显示名称</span><input v-model.trim="displayName" maxlength="32" /></label>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingDisplayName || !displayName.trim()" @click="saveDisplayName"><Save :size="17" />{{ savingDisplayName ? '保存中' : '保存显示名称' }}</button>
            <span v-if="displayNameError" class="form-error">{{ displayNameError }}</span>
            <span v-else-if="displayNameMessage" class="form-success">{{ displayNameMessage }}</span>
          </div>
          <h3><UserRound :size="18" />修改密码</h3>
          <div class="two-column">
            <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" /></label>
            <label><span>新密码</span><input v-model="newPassword" type="password" minlength="10" autocomplete="new-password" /></label>
          </div>
          <div class="profile-save-row">
            <button class="primary-button" :disabled="savingPassword || !currentPassword || !newPassword" @click="savePassword"><Save :size="17" />{{ savingPassword ? '保存中' : '保存密码' }}</button>
            <span v-if="passwordError" class="form-error">{{ passwordError }}</span>
            <span v-else-if="passwordMessage" class="form-success">{{ passwordMessage }}</span>
          </div>
        </section>

        <section v-else-if="tab === 'audio'" class="profile-audio-layout">
          <aside class="profile-audio-nav">
            <button :class="{ active: audioSubNav === 'input' }" @click="audioSubNav = 'input'"><Mic :size="16" />输入</button>
            <button :class="{ active: audioSubNav === 'output' }" @click="audioSubNav = 'output'"><Headphones :size="16" />输出</button>
          </aside>
          <div v-if="audioSubNav === 'input'">
            <section class="settings-section">
              <h3><Mic :size="18" />输入设备</h3>
              <label>
                <span>麦克风</span>
                <select :value="voice.activeInputId" :disabled="!voice.joined" @change="voice.switchInput(($event.target as HTMLSelectElement).value)">
                  <option v-if="!voice.inputDevices.length" value="">系统默认</option>
                  <option v-for="device in voice.inputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || '麦克风' }}</option>
                </select>
              </label>
              <label class="audio-level-control">
                <span><span>麦克风增益</span><strong>{{ Math.round(voice.microphoneGain * 100) }}%</strong></span>
                <input type="range" min="0" max="3" step="0.05" :value="voice.microphoneGain" aria-label="麦克风增益" @input="voice.setMicrophoneGain(Number(($event.target as HTMLInputElement).value))" />
              </label>
            </section>
          </div>
          <div v-else>
            <section class="settings-section">
              <h3><Headphones :size="18" />输出设备</h3>
              <label>
                <span>扬声器</span>
                <select :value="voice.activeOutputId" :disabled="!voice.joined || !voice.outputDevices.length" @change="voice.switchOutput(($event.target as HTMLSelectElement).value)">
                  <option v-if="!voice.outputDevices.length" value="">系统默认</option>
                  <option v-for="device in voice.outputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || '扬声器' }}</option>
                </select>
              </label>
              <label class="audio-level-control">
                <span><span>扬声器音量</span><strong>{{ Math.round(voice.outputVolume * 100) }}%</strong></span>
                <input type="range" min="0" max="3" step="0.05" :value="voice.outputVolume" aria-label="扬声器音量" @input="voice.setOutputVolume(Number(($event.target as HTMLInputElement).value))" />
              </label>
            </section>
          </div>
        </section>

        <section v-else-if="tab === 'sound'" class="settings-section sound-settings">
          <h3><BellRing :size="18" />全局</h3>
          <label class="setting-toggle">
            <span>启用提示音</span>
            <input type="checkbox" :checked="sounds.enabled" aria-label="启用提示音" @change="sounds.setEnabled(($event.target as HTMLInputElement).checked)" />
          </label>
          <label class="audio-level-control">
            <span><span>提示音音量</span><strong>{{ Math.round(sounds.volume * 100) }}%</strong></span>
            <input type="range" min="0" max="1" step="0.05" :value="sounds.volume" :disabled="!sounds.enabled" aria-label="提示音音量" @input="sounds.setVolume(Number(($event.target as HTMLInputElement).value))" />
          </label>
          <h3><BellRing :size="18" />各事件</h3>
          <div class="sound-toggle-list">
            <label><span>加入语音</span><input type="checkbox" :checked="sounds.joinEnabled" :disabled="!sounds.enabled" @change="setSoundEnabled('join', $event)" /></label>
            <label><span>退出语音</span><input type="checkbox" :checked="sounds.leaveEnabled" :disabled="!sounds.enabled" @change="setSoundEnabled('leave', $event)" /></label>
            <label><span>新文字消息</span><input type="checkbox" :checked="sounds.messageEnabled" :disabled="!sounds.enabled" @change="setSoundEnabled('message', $event)" /></label>
          </div>
        </section>

        <section v-else-if="tab === 'theme'" class="settings-section">
          <h3><Palette :size="18" />主题</h3>
          <p class="profile-hint">主题与强调色仅保存在当前浏览器。</p>
        </section>
      </div>
      <footer class="panel-footer"><span class="form-success">用户设置</span></footer>
    </section>
  </div>
</template>
```

注意：footer 暂时保留一个占位文字，后续 Task 10 完善。音效 Tab 的预置下拉、音频 Tab 的处理开关、主题 Tab 的控件在后续 Task 中添加。

- [ ] **Step 5: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add web/src/components/ProfilePanel.vue web/src/styles.css
git commit -m "feat: ProfilePanel 重写为 Tab 布架，账号区拆分保存按钮"
```

---

## Task 8: 音频 Tab 添加处理开关（`web/src/components/ProfilePanel.vue`）

**Files:**
- Modify: `web/src/components/ProfilePanel.vue`

- [ ] **Step 1: 在输入子组添加回声抑制与降噪开关**

在 `web/src/components/ProfilePanel.vue` 的输入设备 section 中，`麦克风增益` 的 `<label class="audio-level-control">` 块之后（`</section>` 之前）添加：

```html
              <div class="toggle-list">
                <label><span>回声抑制</span><input type="checkbox" :checked="voice.echoCancellation" @change="voice.setEchoCancellation(($event.target as HTMLInputElement).checked)" /></label>
                <label><span>降噪</span><input type="checkbox" :checked="voice.noiseSuppression" @change="voice.setNoiseSuppression(($event.target as HTMLInputElement).checked)" /></label>
              </div>
              <p v-if="voice.joined" class="profile-hint">处理开关更改将在下次加入语音时生效。</p>
```

- [ ] **Step 2: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add web/src/components/ProfilePanel.vue
git commit -m "feat: 音频输入子组新增回声抑制与降噪开关"
```

---

## Task 9: 音效 Tab 添加预置下拉（`web/src/components/ProfilePanel.vue`）

**Files:**
- Modify: `web/src/components/ProfilePanel.vue`

- [ ] **Step 1: 在脚本中导入 SOUND_PRESETS**

在 `web/src/components/ProfilePanel.vue` 脚本的 import 行中，修改 sounds store 的导入：

将：
```ts
import { useSoundStore, type NotificationSound } from '../stores/sounds'
```

替换为：
```ts
import { useSoundStore, type NotificationSound, type SoundPresetId, SOUND_PRESETS } from '../stores/sounds'
```

- [ ] **Step 2: 添加 preset 选项列表与辅助函数**

在 `web/src/components/ProfilePanel.vue` 脚本的 `setSoundEnabled` 函数之后添加：

```ts
function setSoundPreset(sound: NotificationSound, event: Event) {
  sounds.setSoundPreset(sound, (event.target as HTMLSelectElement).value as SoundPresetId)
}

const presetOptions = Object.entries(SOUND_PRESETS).map(([id, { name }]) => ({ id: id as SoundPresetId, name }))

function getSelectedPreset(sound: NotificationSound): SoundPresetId {
  if (sound === 'join') return sounds.joinPreset
  if (sound === 'leave') return sounds.leavePreset
  return sounds.messagePreset
}

function isSoundEnabled(sound: NotificationSound): boolean {
  if (sound === 'join') return sounds.joinEnabled
  if (sound === 'leave') return sounds.leaveEnabled
  return sounds.messageEnabled
}
```

- [ ] **Step 3: 在模板的"各事件"区域添加预置下拉**

在 `web/src/components/ProfilePanel.vue` 的音效 Tab 中，将 `各事件` 的 `sound-toggle-list` div 替换为：

```html
          <div class="sound-event-list">
            <div v-for="sound in (['join','leave','message'] as NotificationSound[])" :key="sound" class="sound-event-row">
              <label class="setting-toggle">
                <span>{{ sound === 'join' ? '加入语音' : sound === 'leave' ? '退出语音' : '新文字消息' }}</span>
                <input type="checkbox" :checked="isSoundEnabled(sound)" :disabled="!sounds.enabled" @change="setSoundEnabled(sound, $event)" />
              </label>
              <label><span>音效</span>
                <select :value="getSelectedPreset(sound)" :disabled="!sounds.enabled" @change="setSoundPreset(sound, $event)">
                  <option v-for="preset in presetOptions" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
                </select>
              </label>
            </div>
          </div>
```

- [ ] **Step 4: 在 styles.css 添加 sound-event-list CSS**

在 `web/src/styles.css` 的 `.sound-toggle-list label { ... }` 之后添加：

```css
.sound-event-list { display: grid; gap: 12px; }
.sound-event-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; }
.sound-event-row .setting-toggle { min-height: 42px; }
```

在 `@media (max-width: 760px)` 块中，`.sound-toggle-list { grid-template-columns: 1fr; }` 之后添加：

```css
  .sound-event-row { grid-template-columns: 1fr; }
```

- [ ] **Step 5: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add web/src/components/ProfilePanel.vue web/src/styles.css
git commit -m "feat: 音效 Tab 各事件新增预置音效下拉选择"
```

---

## Task 10: 主题 Tab 完善（`web/src/components/ProfilePanel.vue`）

**Files:**
- Modify: `web/src/components/ProfilePanel.vue`
- Modify: `web/src/styles.css`

- [ ] **Step 1: 在 styles.css 添加主题 Tab 控件样式**

在 `web/src/styles.css` 的 `.profile-hint { ... }` 之后添加：

```css
.theme-mode-group { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.theme-mode-group button { min-height: 44px; border: 1px solid var(--line); border-radius: 4px; background: var(--main); color: var(--muted); display: flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer; font-weight: 650; }
.theme-mode-group button:hover { background: var(--hover); color: var(--text); }
.theme-mode-group button.active { border-color: var(--brand); color: var(--text); background: var(--active); }
.accent-swatches { display: flex; gap: 14px; }
.accent-swatch { width: 36px; height: 36px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; display: grid; place-items: center; }
.accent-swatch.active { border-color: var(--text); }
.accent-swatch-inner { width: 26px; height: 26px; border-radius: 50%; }
```

在 `@media (max-width: 760px)` 块中添加：

```css
  .theme-mode-group { grid-template-columns: 1fr; }
```

- [ ] **Step 2: 在 ProfilePanel 脚本添加主题选项数据**

在 `web/src/components/ProfilePanel.vue` 脚本的 `presetOptions` 之后添加：

```ts
const themeModes: { value: 'system' | 'light' | 'dark'; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
]

const accentSwatches: { value: 'indigo' | 'green' | 'rose' | 'amber'; label: string; color: string }[] = [
  { value: 'indigo', label: '靛蓝', color: '#5865f2' },
  { value: 'green', label: '绿色', color: '#23a559' },
  { value: 'rose', label: '玫瑰', color: '#e64855' },
  { value: 'amber', label: '琥珀', color: '#d4a32e' },
]
```

- [ ] **Step 3: 完善 ProfilePanel 主题 Tab 模板**

将 `web/src/components/ProfilePanel.vue` 的主题 Tab section（`v-else-if="tab === 'theme'"`）替换为：

```html
        <section v-else-if="tab === 'theme'" class="settings-section">
          <h3><Palette :size="18" />外观模式</h3>
          <div class="theme-mode-group">
            <button v-for="mode in themeModes" :key="mode.value" :class="{ active: theme.mode === mode.value }" @click="theme.setMode(mode.value)">{{ mode.label }}</button>
          </div>
          <h3><Palette :size="18" />强调色</h3>
          <div class="accent-swatches">
            <button v-for="swatch in accentSwatches" :key="swatch.value" :class="['accent-swatch', { active: theme.accent === swatch.value }]" :title="swatch.label" :aria-label="swatch.label" @click="theme.setAccent(swatch.value)">
              <span class="accent-swatch-inner" :style="{ background: swatch.color }" />
            </button>
          </div>
          <p class="profile-hint">主题与强调色仅保存在当前浏览器。</p>
        </section>
```

- [ ] **Step 4: 清理 footer 占位文字**

将 `web/src/components/ProfilePanel.vue` 的 footer 行：

```html
      <footer class="panel-footer"><span class="form-success">用户设置</span></footer>
```

替换为：

```html
      <footer class="panel-footer"><span class="profile-hint">音频、音效与主题设置即时生效。账号修改使用各自保存按钮。</span></footer>
```

- [ ] **Step 5: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add web/src/components/ProfilePanel.vue web/src/styles.css
git commit -m "feat: 主题 Tab 实现模式三态切换与强调色预设"
```

---

## Task 11: 更新 e2e 测试（`web/e2e/smoke.spec.ts`）

**Files:**
- Modify: `web/e2e/smoke.spec.ts`

- [ ] **Step 1: 更新"本地音量增益"测试**

将 `web/e2e/smoke.spec.ts` 第 41-60 行的测试替换为：

```ts
test('本地音量增益默认 100% 并持久化到浏览器', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()
  await page.getByRole('button', { name: '音频', exact: true }).click()
  await page.getByRole('button', { name: '输入', exact: true }).click()

  const microphoneGain = page.getByLabel('麦克风增益')
  await expect(microphoneGain).toHaveValue('1')
  await expect(microphoneGain).toHaveAttribute('max', '3')

  await microphoneGain.fill('2.5')
  await expect(page.getByText('250%', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.microphoneGain'))).toBe('2.5')

  await page.getByRole('button', { name: '输出', exact: true }).click()
  const outputVolume = page.getByLabel('扬声器音量')
  await expect(outputVolume).toHaveValue('1')
  await expect(outputVolume).toHaveAttribute('max', '3')
  await outputVolume.fill('1.5')
  await expect(page.getByText('150%', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.outputVolume'))).toBe('1.5')
})
```

- [ ] **Step 2: 删除"分区标题间距"测试**

删除 `web/e2e/smoke.spec.ts` 第 62-73 行的 `test('用户设置分区标题与上方分隔线保持间距', ...)` 整个测试块（该测试依赖旧的扁平 section 结构，已不适用）。

- [ ] **Step 3: 更新"操作提示音"测试**

将 `web/e2e/smoke.spec.ts` 第 75-113 行的测试替换为：

```ts
test('操作提示音默认开启并持久化到浏览器', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()
  await page.getByRole('button', { name: '音效', exact: true }).click()

  const masterSwitch = page.getByLabel('启用提示音')
  const soundVolume = page.getByLabel('提示音音量')
  const joinSwitch = page.getByLabel('加入语音')
  const leaveSwitch = page.getByLabel('退出语音')
  const messageSwitch = page.getByLabel('新文字消息')
  await expect(masterSwitch).toBeChecked()
  await expect(soundVolume).toHaveValue('0.6')
  await expect(joinSwitch).toBeChecked()
  await expect(leaveSwitch).toBeChecked()
  await expect(messageSwitch).toBeChecked()

  await soundVolume.fill('0.35')
  await joinSwitch.uncheck()
  await messageSwitch.uncheck()
  await expect.poll(() => page.evaluate(() => ({
    volume: localStorage.getItem('cws.notificationSounds.volume'),
    join: localStorage.getItem('cws.notificationSounds.join'),
    message: localStorage.getItem('cws.notificationSounds.message'),
  }))).toEqual({ volume: '0.35', join: 'false', message: 'false' })

  await masterSwitch.uncheck()
  await expect(soundVolume).toBeDisabled()
  await expect(joinSwitch).toBeDisabled()
  await expect(leaveSwitch).toBeDisabled()
  await expect(messageSwitch).toBeDisabled()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.notificationSounds.enabled'))).toBe('false')

  await page.reload()
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()
  await page.getByRole('button', { name: '音效', exact: true }).click()
  await expect(page.getByLabel('启用提示音')).not.toBeChecked()
  await expect(page.getByLabel('提示音音量')).toHaveValue('0.35')
  await expect(page.getByLabel('加入语音')).not.toBeChecked()
  await expect(page.getByLabel('新文字消息')).not.toBeChecked()
})
```

- [ ] **Step 4: 添加主题切换测试**

在 `web/e2e/smoke.spec.ts` 的提示音测试之后添加：

```ts
test('主题模式与强调色持久化到浏览器', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()
  await page.getByRole('button', { name: '主题', exact: true }).click()

  await page.getByRole('button', { name: '亮色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.theme.mode'))).toBe('light')

  await page.getByRole('button', { name: '绿色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'green')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cws.theme.accent'))).toBe('green')

  await page.getByRole('button', { name: '暗色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
```

- [ ] **Step 5: 添加音频处理开关测试**

在主题测试之后添加：

```ts
test('音频处理开关持久化到浏览器', async ({ page, isMobile }) => {
  if (isMobile) await page.getByTitle('频道').click()
  await page.getByTitle('用户设置').click()
  await page.getByRole('button', { name: '音频', exact: true }).click()

  const echoToggle = page.getByLabel('回声抑制')
  const noiseToggle = page.getByLabel('降噪')
  await expect(echoToggle).toBeChecked()
  await expect(noiseToggle).toBeChecked()

  await echoToggle.uncheck()
  await noiseToggle.uncheck()
  await expect.poll(() => page.evaluate(() => ({
    echo: localStorage.getItem('cws.echoCancellation'),
    noise: localStorage.getItem('cws.noiseSuppression'),
  }))).toEqual({ echo: 'false', noise: 'false' })
})
```

- [ ] **Step 6: 运行类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add web/e2e/smoke.spec.ts
git commit -m "test: 更新 e2e 测试适配 Tab 导航并覆盖新功能"
```

---

## Task 12: 更新 README（`README.md`）

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新"客户端音频设置"章节**

将 `README.md` 第 21-33 行的"## 客户端音频设置"章节替换为：

```markdown
## 客户端音频设置

用户设置面板分为四个页签：账号、音频、音效与主题。音频、音效与主题设置即时生效并保存在当前浏览器的 `localStorage`，不会写入服务器或同步到其他浏览器。账号修改（显示名称、密码）使用各自独立的保存按钮。

### 音频

- 麦克风与扬声器选择仅在加入语音频道后可用。麦克风增益与扬声器音量支持 0%-300% 调节，始终可配置。
- 回声抑制与降噪开关可随时调整，更改在下次加入语音频道时生效。自动增益控制保持开启，不暴露开关。
- 主题模式可选跟随系统、亮色或暗色。强调色提供靛蓝、绿色、玫瑰与琥珀四种预设。主题与强调色仅保存在当前浏览器。

### 音效

操作提示音默认开启，默认音量为 60%。用户可以关闭全部提示音，也可以分别控制加入语音、退出语音和新文字消息三类提示。每个事件可以从预置音效库中选择不同的提示音。

- 自己成功加入语音频道时播放一次加入音效，自己退出时不播放退出音效。
- 其他用户在初始成员同步完成后加入或退出时播放对应音效；初次进入频道和网络重连不会为已有成员逐个提示。
- 其他用户发送新文字消息时播放消息音效，自己发送的消息不提示。是否已连接语音、是否正在查看文字频道不影响该行为。
- 耳机静音会同时静音语音和操作提示音。提示音优先跟随已选择的输出设备，不支持指定输出设备的浏览器会使用系统默认设备。
- 同类提示音在 300ms 内最多播放一次，避免批量上下线或连续消息形成叠音。

浏览器会限制未经用户交互的音频自动播放。Celery Web Speak 会在首次点击或按键时启用提示音；此前无法播放的事件会直接跳过，不会延迟补播。Android 切到后台后的播放能力由 Chrome 和系统策略决定。
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: 更新客户端音频设置章节以反映新的 Tab 结构与功能"
```

---

## Verification

完成所有 Task 后，运行完整验证：

- [ ] **类型检查**

Run: `cd web && npm run typecheck`
Expected: PASS

- [ ] **构建**

Run: `cd web && npm run build`
Expected: PASS

- [ ] **Go 测试（确认后端无回归）**

Run: `go test ./...`
Expected: PASS

- [ ] **e2e 测试（需要运行中的服务器）**

Run: `cd web && npm run test:e2e`
Expected: 所有测试通过（如无运行中的服务器，跳过此步但确认测试代码类型正确）
