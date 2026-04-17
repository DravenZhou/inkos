# Studio 对话页面重构设计

## 概述

将 Studio 从"侧边栏 ChatBar + 独立路由页面"重构为"对话页面为主内容区 + 浮动信息面板"的布局，参考 Claude Cowork 模式。

## 布局结构

```
┌──────────┬──────────────────────────────────────────┐
│ 左侧导航  │      主内容区（对话页面）                    │
│          │                                          │
│ 书籍列表  │  对话消息流                     ╭─────────╮│
│ + 新建    │  （含 ::: 内嵌表单）           │ ▾ 章节   ││
│          │                               │  第1章 ✓ ││
│ ──────── │                               │  第2章 ◆ ││
│ 系统      │                               ╰─────────╯│
│ 题材      │                               ╭─────────╮│
│ 配置      │                               │ ▾ 执行   ││
│ ...      │                               │  写作中.. ││
│          │                               ╰─────────╯│
│          │                               ╭─────────╮│
│          │                               │ ▸ 草案   ││
│          │  ┌──────────────────────┐     ╰─────────╯│
│          │  │ 写下一章  审计  导出   │                 │
│          │  ├──────────────────────┤                 │
│          │  │ 输入框 + 发送         │                 │
│          │  └──────────────────────┘                 │
└──────────┴──────────────────────────────────────────┘
```

## 核心变化

### 删除

- `ChatBar.tsx` 侧边栏组件
- 右上角聊天图标按钮
- `BookCreate.tsx` 页面（合并进对话页面）

### 新增

- `ChatPage.tsx` — 主内容区对话页面，替代 ChatBar + BookCreate
- `ChatMessage.tsx` — 单条消息渲染，assistant 消息支持 `StreamMessage`（`:::` 内嵌表单）
- `FloatingPanels.tsx` — 右侧浮动可折叠面板组
- `BookInfoPanel.tsx` — 章节列表 + 执行状态面板（从 BookDetail 提取）

### 改造

- `BookDetail.tsx` — 从路由页面变为浮动面板数据源
- `App.tsx` — 路由逻辑调整，点书 → 对话页面（带书上下文），新建 → 对话页面（无书）

## 路由变化

| 动作 | 当前 | 新设计 |
|------|------|--------|
| 点"新建书籍" | → BookCreate 页面 | → ChatPage（无书引导） |
| 点某本书 | → BookDetail 页面 | → ChatPage + 浮动面板（有书上下文） |
| 右上角聊天按钮 | → 弹出 ChatBar 侧边栏 | 删除 |

## 对话页面两种模式

### 无书模式

- 消息流为空时显示居中引导："告诉我你想写什么——题材、世界观、主角、核心冲突"
- 快捷 chip 不显示（没有可操作的书）
- 用户输入后走 `/new` 流程，AI 回复含 `:::` 内嵌表单
- 右侧无浮动面板
- 草案就绪后出现"开始写这本书"按钮

### 有书模式

- 加载该书的 session 消息历史
- 右侧浮动面板显示：章节列表、执行状态、草案摘要
- 快捷 chip：写下一章、审计、导出、市场雷达
- 输入框 placeholder 随上下文变化

## 浮动面板设计

参考 Claude Cowork 右侧面板：

- **浮动定位**：`position: fixed` 或 `absolute`，右侧贴边，不挤压对话区宽度
- **独立折叠**：每个面板有标题栏 + 展开/折叠箭头，点击切换
- **无书时隐藏**：只在有活跃书籍时显示
- **面板内容**：
  - **章节**：章节列表 + 状态标记（✓ 完成、◆ 当前、○ 待写）
  - **执行**：当前执行阶段、进度
  - **草案**：创作草案字段摘要（书名、世界观、主角等）

## 消息渲染

对话消息和现有 ChatBar 逻辑一致，但宽度更大：

- 用户消息：右对齐气泡
- AI 消息：左对齐，支持 `StreamMessage`（`:::` 标记渲染为内嵌表单）
- 状态消息：小字灰色（⋯ 处理中、✓ 完成、✗ 错误）
- markdown 加粗渲染：`**text**` → `<strong>`

## 数据流

与现有 ChatBar 完全一致：
- POST `/agent` 发送指令
- 响应 `details.draftRaw`（含 `:::` 标记）用 `StreamMessage` 渲染
- `response`（纯文本）作为 fallback
- SSE `draft:delta` 可选用于流式显示（后续优化）

## 涉及文件

### 新建
- `packages/studio/src/pages/ChatPage.tsx`
- `packages/studio/src/components/chat/ChatMessage.tsx`
- `packages/studio/src/components/chat/FloatingPanels.tsx`
- `packages/studio/src/components/chat/BookInfoPanel.tsx`
- `packages/studio/src/components/chat/QuickActions.tsx`

### 删除
- `packages/studio/src/components/ChatBar.tsx`

### 修改
- `packages/studio/src/App.tsx` — 路由重构，删除 ChatBar 引用
- `packages/studio/src/pages/BookCreate.tsx` — 删除或 redirect 到 ChatPage
- 从 `BookDetail.tsx` 提取面板所需数据
