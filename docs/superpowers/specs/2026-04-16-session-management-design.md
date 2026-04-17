# Session 管理优化设计

> 日期：2026-04-16
> 状态：待实施

## 概述

InkOS Studio 的 session（会话）管理从"一本书只有一段聊天"升级为"一本书多段聊天、互不干扰、可并行流式"。同时修复新建书籍时全局共享 `bookId=null` session 导致的消息混杂 bug。

## 需求

1. **单书多 session**：同一本书可以新建多段对话（比如一段讨论人物、一段写正文），各自独立
2. **多 session 并行**：一个 session 的 SSE 流正在推内容时，用户可以切到另一个 session 继续聊天，原来那条流不中断
3. **新建书籍 session 管理**：每次新建书籍都开全新 session，不复用；创建成功后 session 迁移到新书籍；中途放弃则变成孤儿文件留在磁盘

## 1. 数据与存储

### BookSession 结构变更

在 `packages/core/src/interaction/session.ts` 的 `BookSession` 类型上新增一个字段：

```ts
title: string | null   // AI 自动生成的标题；null 表示尚未生成，UI 回退显示"新会话 · HH:mm"
```

其余字段（sessionId、bookId、messages、draftRounds、events、creationDraft、currentExecution、createdAt、updatedAt）不变。

### 标题生成规则

- 首轮用户 ↔ AI 对话结束后，后端异步调一次 LLM 生成标题并写回 session 文件
- 只要 `title !== null`，就不再触发生成（无论是 AI 生成的还是用户手动改过的）
- 生成用项目配置的 fast model，提示词固定："用 6 个中文字以内概括这段对话的主题，只返回标题文本"
- 生成失败静默吞掉，title 保持 null，下次对话结束时再试

### 存储

- 位置不变：`.inkos/sessions/{sessionId}.json`
- 孤儿 session（`bookId=null`、用户放弃后不再引用的）磁盘文件保留，不自动清理；UI 不展示
- 所有对 session 文件的写操作（新建/改名/删除/迁移/追加消息/写标题）通过 p-queue 按 sessionId 串行化，防止并发写坏 JSON

## 2. 后端 API

### 已有端点改造

| 端点 | 改造内容 |
|---|---|
| `POST /api/v1/sessions` | 语义从"查找或创建"改为**永远新建**。底层调 `createBookSession` 而非 `findOrCreateBookSession` |
| `POST /api/v1/agent` | `sessionId` 参数改为**必填**，缺失返回 400。删掉 `findOrCreateBookSession` 回退逻辑 |
| `GET /api/v1/sessions?bookId=X` | 返回列表中每条补上 `title` 字段（目前只返回 sessionId/bookId/messageCount/createdAt/updatedAt） |
| `GET /api/v1/sessions/:sessionId` | 不动 |

### 新增端点

| 端点 | 作用 |
|---|---|
| `PUT /api/v1/sessions/:sessionId` | 改名：接收 `{ title: string }`，写入 session 文件 |
| `DELETE /api/v1/sessions/:sessionId` | 删除 session 文件 |

### 底层函数变更（book-session-store.ts）

| 函数 | 变更 |
|---|---|
| `findOrCreateBookSession` | **删除**，它是 bug 的根源 |
| `createBookSession`（session.ts 中已有） | 保持，暴露给 HTTP 层直接调用 |
| `loadBookSession` | 不动 |
| `persistBookSession` | 不动 |
| `listBookSessions` | 不动 |
| `renameBookSession(root, sessionId, title)` | 新增 |
| `deleteBookSession(root, sessionId)` | 新增 |
| `migrateBookSession(root, sessionId, newBookId)` | 新增；前置检查：只有 `bookId === null` 才允许迁移，否则抛 `SessionAlreadyMigratedError` |
| `generateSessionTitle(root, sessionId)` | 新增；异步调 LLM 生成标题，`title !== null` 时跳过 |

## 3. 前端 store 改造

### state 从单数改为按 sessionId 分片

```ts
// 每条 session 的运行时状态
type SessionRuntime = {
  sessionId: string
  bookId: string | null
  title: string | null
  messages: Message[]
  stream: EventSource | null
  isStreaming: boolean
  lastError: string | null
}

// MessageState 改造
type MessageState = {
  // 删掉旧的 currentSessionId / messages / _activeStream / isStreaming

  sessions: Record<string, SessionRuntime>       // 按 sessionId 分片
  activeSessionId: string | null                  // UI 当前展示哪条
  sessionIdsByBook: Record<string, string[]>      // 书籍 → session id 列表，侧边栏用
}
```

### 关键约定

- **组件读数据**：selector 读 `state.sessions[state.activeSessionId]?.messages ?? []`，签名不变
- **派生值用 useMemo**（遵守 CLAUDE.md 规范）：比如"某条 session 是否 streaming"放在组件内 useMemo，不在 selector 里 filter/map 产生新数组
- **sendMessage(sessionId, text)**：必须接收 sessionId 参数（不读 activeSessionId），往 `sessions[sessionId].stream` 开 SSE，消息写到 `sessions[sessionId].messages`
- **切 session**：只改 `activeSessionId`，不关任何 SSE；被切出去的 session 的流继续在后台推
- **关页面/关 tab**：浏览器回收所有 EventSource，服务器端连接断开；正在生成的消息到此为止

## 4. 侧边栏 UI

```
┌── 侧边栏 ──────────────────────────┐
│                                    │
│  📚 书籍                           │
│  ──────────────────────────────    │
│                                    │
│  ▸ 山海神游 · 3 个会话             │  ← 折叠，只看书名
│                                    │
│  ▾ 都市重生 · 2 个会话             │  ← 展开
│      · 初稿大纲讨论         ●      │  ← 当前选中高亮
│      · 第三章正文         ⟳       │  ← 正在流式输出（活跃指示）
│      + 新建会话                    │  ← 展开后文件夹内部最后一项
│                                    │
│  ▸ 星穹列车 · 1 个会话             │
│                                    │
│  ──────────────────────────────    │
│  + 新建书籍                        │
│                                    │
└────────────────────────────────────┘
```

- 书名行点击 → 展开/折叠
- 当前选中的 session 整行高亮 + 右侧 `●`
- 正在流式输出的 session 右侧显示 `⟳` 转圈图标，即使用户切到别的 session 也继续显示，流结束后消失
- `+ 新建会话` 在展开后文件夹内部最后一项，点击创建空白 session 并切换过去
- session 行右键（或 hover 出菜单）→ 改名 / 删除
- 标题默认 AI 生成；首轮对话前显示"新会话 · HH:mm"占位

## 5. 新建书籍流程

### 完整流程

```
用户点"+ 新建书籍"
  └→ 前端 POST /api/v1/sessions { bookId: null } → 返回 sessionId
     └→ localStorage.setItem("currentBookCreateSessionId", sessionId)
        └→ navigate("/books/new")
           └→ 页面挂载 SessionRuntime，展示空聊天
              └→ 用户跟 AI 讨论题材、主角……
                 └→ AI 调用 create_book 工具
                    └→ 后端：
                       1. 创建书籍，得到 newBookId
                       2. migrateBookSession(sessionId, newBookId)
                       3. SSE broadcast { type: "book:created", bookId, sessionId }
                    └→ 前端收到 book:created：
                       1. localStorage.removeItem("currentBookCreateSessionId")
                       2. store: sessions[sessionId].bookId = bookId
                       3. store: sessionIdsByBook[bookId] = [sessionId]
                       4. 刷新侧边栏书列表
                       5. navigate("/books/${bookId}", { replace: true })
```

### 规则

- **每次点"+ 新建书籍"都创建全新 session**，覆盖 localStorage，旧的变孤儿
- **侧边栏不展示草稿节点**：新建书籍讨论中，侧边栏没有任何对应节点；直到 `create_book` 成功，新书籍节点才出现
- **刷新页面不丢失**：`/books/new` 路由读 localStorage 里的 sessionId，有效则继续，无效则自动新建
- **用户中途切走**：`bookId=null` 的 session 在 store 里还在（SSE 流继续），但用户无法通过侧边栏回去；重新点"+ 新建书籍"会新建另一条

### 边缘情况

- **AI 流还没结束就 `create_book` 成功**：SSE 继续推，消息写到同一条 session，bookId 已经改了，不影响
- **同一条 session 连续调两次 `create_book`**：`migrateBookSession` 前置检查 `bookId === null`，第二次抛 `SessionAlreadyMigratedError`，agent 收到错误信息自行处理
- **localStorage 里的 sessionId 对应的文件被删**：`/books/new` 页面检测到 404，清 localStorage，自动新建

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| POST /sessions 失败 | 前端 alert，UI 停在当前页面不跳转；localStorage 不写入 |
| GET /sessions/:id 返回 404 | 清掉 store 里这条；URL 回到 / 或书籍首页 |
| PUT /sessions/:id 改名失败 | 侧边栏标题回滚旧值，toast 提示 |
| DELETE /sessions/:id 失败 | 侧边栏恢复显示该条，toast 提示 |
| SSE 连接中途断开 | `sessions[id].isStreaming` 置 false，`lastError` 写入错误文本；活跃指示关掉；最后一条消息标为"生成中断"；不自动重连 |
| `migrateBookSession` 时 bookId 非 null | 抛 `SessionAlreadyMigratedError` |
| 标题生成 LLM 调用失败 | 静默，title 保持 null，下次对话结束再试 |
| 并发写同一 session 文件 | p-queue 按 sessionId 串行化所有写操作 |

## 7. 测试

### book-session-store.test.ts

- `createBookSession` 每次生成不同 id，不复用已有
- `renameBookSession` 写入 title 并更新 updatedAt
- `deleteBookSession` 删除文件后 `loadBookSession` 返回 null
- `migrateBookSession` 只在 `bookId === null` 时成功，否则抛错
- `findOrCreateBookSession` 相关测试全部删除
- 并发写同一 session 不损坏 JSON（p-queue 串行验证）

### store/chat/slices/message/action.test.ts

- `sendMessage(sessionA, ...)` 只写到 `sessions[sessionA].messages`，不影响 sessionB
- 切 `activeSessionId` 不关闭旧 session 的 stream
- 两个 session 各自 SSE 同时推消息，messages 正确归位
- `onBookCreated` 事件：清 localStorage、更新 bookId、sessionIdsByBook 正确插入

### studio/src/api/server.test.ts

- `POST /sessions` 每次返回不同 sessionId（即使 bookId 相同）
- `POST /agent` 不带 sessionId 返回 400
- `PUT /sessions/:id` 改名后 GET 读到新标题
- `DELETE /sessions/:id` 删除后 GET 返回 404
- `GET /sessions?bookId=X` 按 updatedAt 倒序
