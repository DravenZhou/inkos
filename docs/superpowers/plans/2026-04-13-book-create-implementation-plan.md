# BookCreate 重构实施计划

基于 [设计文档](../specs/2026-04-13-book-create-redesign.md)，以下是按依赖顺序排列的实施步骤。

---

## Step 1: Core — 表单标记解析器

新建 `packages/core/src/interaction/draft-directive-parser.ts`

实现从 LLM 原始输出中提取结构化数据的共享 parser：

```typescript
interface ParsedDraftResponse {
  fields: Record<string, string>;  // key → value
  textContent: string;             // 去掉 ::: 标记的纯文本（TUI 用）
  summary: string;                 // 自动生成的轮次摘要（"确立了书名、世界观和主角"）
  raw: string;                     // LLM 原始输出（Studio 用）
}
```

逐行状态机：普通行累积 markdown buffer，`:::field{...}` / `:::pick{...}` / `:::number{...}` / `:::group{...}` 进入表单收集模式，关闭 `:::` 恢复。

**涉及文件**：
- 新建：`packages/core/src/interaction/draft-directive-parser.ts`
- 新建：`packages/core/src/__tests__/draft-directive-parser.test.ts`
- 修改：`packages/core/src/index.ts`（导出 parser）

---

## Step 2: Core — Session 数据结构扩展

修改 `packages/core/src/interaction/session.ts`，扩展 session 结构以支持对话轮次。

**当前**（session.ts:22-45）：
- `BookCreationDraftSchema` — 扁平的 Zod schema

**改为**：
- `BookCreationDraftSchema` 保持不变（`fields` 的值结构和现有一致，向后兼容）
- 新增 `DraftRoundSchema`：`{ roundId, userMessage, assistantRaw, fieldsUpdated, summary, timestamp }`
- `InteractionSessionSchema`（session.ts:47-58）新增可选字段 `draftRounds`

**涉及文件**：
- 修改：`packages/core/src/interaction/session.ts`（:22-60, :85-104）
- 修改：`packages/core/src/index.ts`（导出新类型）

---

## Step 3: Core — developBookDraft 改为流式输出

重写 `packages/core/src/interaction/project-tools.ts` 中的 `developBookDraft`（:450-519）。

**当前**：
- system prompt 要求返回 JSON `{assistantReply, draft}`
- `chatCompletion` 一次性返回，`parseCreationDraftResult` 解析 JSON
- `onTextDelta` 回调只有 `chat` 工具在用（project-tools.ts:596），`developBookDraft` 没有接入

**改为**：
- system prompt 替换为设计文档中的新 prompt（中文角色定位 + 业务原则 + `:::` 标记格式规范）
- `chatCompletion` 启用 `onTextDelta` 流式回调，通过 `hooks.onDraftTextDelta` 向外暴露
- 流式回调需要**实时过滤 `:::` 标记段**：普通文本立即推送，进入 `:::` 块时暂停推送，关闭后跳过该段。这样 TUI 端在流式阶段只看到自然语言文本
- 流式完成后，用 Step 1 的 parser 对完整输出提取 `fields`
- 返回结构调整：增加 `raw` 字段传递原始输出

**hooks 接口扩展**（`packages/cli/src/tui/tools.ts:12`，`packages/core/src/interaction/project-tools.ts` CliInteractionToolHooks）：
```typescript
interface CliInteractionToolHooks {
  readonly onChatTextDelta?: (text: string) => void;
  readonly onDraftTextDelta?: (text: string) => void;  // 新增
  // ...
}
```

**涉及文件**：
- 修改：`packages/core/src/interaction/project-tools.ts`（:450-519 developBookDraft, :48-119 可删除旧 JSON parser）
- 修改：`packages/core/src/__tests__/creation-draft-parser.test.ts`（适配新 parser）

---

## Step 4: Core — runtime 层适配轮次记录

修改 `packages/core/src/interaction/runtime.ts` 中的 `handleDraftLifecycleRequest`（:351-495）。

**当前**（:361-399 develop_book case）：
- 调用 `developBookDraft` → `updateCreationDraft` 整体替换 draft

**改为**：
- 调用 `developBookDraft` → 用 parser 的 `fields` 增量合并到 `session.creationDraft`
- 追加新的 `DraftRound` 到 `session.draftRounds`
- `raw` 字段透传到 response 供 Studio 流式渲染

同时修改 `clearCreationDraft`（session.ts:95-104）一并清空 `draftRounds`。

**涉及文件**：
- 修改：`packages/core/src/interaction/runtime.ts`（:351-399）
- 修改：`packages/core/src/interaction/session.ts`（:85-104 updateCreationDraft, clearCreationDraft）

---

## Step 5: Studio API — agent 端点支持 SSE 流式推送

修改 `packages/studio/src/api/server.ts` 的 `/api/agent` POST 端点（:579-610）。

**当前**：
- 同步调用 `processProjectInteractionInput`，等完成后返回 JSON

**改为**：
- 对 `develop_book` intent，通过现有 SSE 基础设施（:395-417 `/api/events`）逐 token 广播 `draft:delta` 事件
- 需要在 `project-tools.ts` 的 `developBookDraft` 中把 `onTextDelta` hook 暴露出来
- 利用现有 `broadcast()` 函数（server.ts:28-38）推送
- 最终 response 仍返回完整结果（含 `raw`、`fields`、`round`）

**涉及文件**：
- 修改：`packages/studio/src/api/server.ts`（:579-610）
- 修改：`packages/studio/src/hooks/use-sse.ts`（:9-54 新增 `draft:delta` 事件类型）

---

## Step 6: Studio — 流式消息渲染组件

新建 Studio 前端组件，解析 `:::` 标记并渲染为表单控件。

**新建组件**：
- `packages/studio/src/components/book-create/StreamMessage.tsx` — 接收流式文本，逐行解析，markdown 段落和表单控件交替渲染
- `packages/studio/src/components/book-create/InlineField.tsx` — `:::field` → `<input>` / `<textarea>`
- `packages/studio/src/components/book-create/InlinePick.tsx` — `:::pick` → 可点选卡片组
- `packages/studio/src/components/book-create/InlineGroup.tsx` — `:::group` → 并排容器
- `packages/studio/src/components/book-create/RoundSummary.tsx` — 折叠的历史轮次
- `packages/studio/src/components/book-create/DraftReadyBar.tsx` — 草案就绪确认区块
- `packages/studio/src/components/book-create/ComposerBar.tsx` — 底部输入栏

**涉及文件**：
- 新建：`packages/studio/src/components/book-create/` 目录下 7 个组件
- 可参考：`packages/studio/src/components/ChatBar.tsx`（:300-335 SSE 监听模式）

---

## Step 7: Studio — BookCreate 页面重写

重写 `packages/studio/src/pages/BookCreate.tsx`（:289-549）。

**当前**：双栏 grid（草案卡片 + textarea + 3 个按钮）

**改为**：
- 单栏对话流布局
- 状态管理：`draft`（当前字段值）、`rounds`（轮次数组）、`streaming`（当前流式文本）、`ready`（是否就绪）
- 移除：`refreshDraft` 轮询逻辑（:308-350）、`buildCreationDraftSummary`（:201-226）、双栏 grid JSX
- 保留：`canCreateFromDraft`（:143-156）、`waitForBookReady`（:240-287）、`handleCreate`（:382-404）、`handleDiscard`（:406-420）
- 新增：SSE 监听 `draft:delta` 事件驱动 `StreamMessage` 渲染
- 新增：内嵌字段 onChange → 更新本地 draft state
- 新增：发送时把 draft 含用户修改一起 POST 到 `/agent`

**涉及文件**：
- 重写：`packages/studio/src/pages/BookCreate.tsx`
- 可删除的导出（如其他地方未引用）：`buildCreationDraftSummary`、`DraftSummaryRow`、`pickValidValue`、`defaultChapterWordsForLanguage`、`platformOptionsForLanguage`、`resolveDraftInstruction`

---

## Step 8: TUI — 流式渲染 + `/new` 使用说明

TUI 已有流式基础设施（`chatStreamBridge` + `appendStreamingAssistantChunk`），但只给 `chat` intent 用。需要扩展到 `develop_book`。

### 8a. 接入流式渲染

**当前**（dashboard.tsx:361）：
```typescript
const assistantDraftTimestamp = routed.intent === "chat" ? userTimestamp + 1 : null;
```
只有 `chat` intent 设置 timestamp，`develop_book` 不会触发流式。

**改为**：
```typescript
const assistantDraftTimestamp = (routed.intent === "chat" || routed.intent === "develop_book")
  ? userTimestamp + 1 : null;
```

同时在 `app.ts` 的 tools 创建中接入新的 `onDraftTextDelta` hook：
```typescript
// app.ts launchTui 中
onDraftTextDelta: (text) => {
  chatStreamBridge.onTextDelta?.(text);
},
```

`onDraftTextDelta` 在 Step 3 中已做实时过滤——只推送普通文本，`:::` 标记段会被跳过。所以 TUI 端看到的是纯自然语言的逐字流式输出。

流式完成后，`handleSubmit` 的最终 `summary`（从 `formatTuiResult` 来的 `textContent`）会替换掉流式累积的内容。

### 8b. `/new` 命令使用说明

在 `slash-autocomplete.ts` 的 SLASH_COMMANDS 中为 `/new` 添加中文说明：

**当前**：
```typescript
"/new <idea>",
```

**改为**：
```typescript
"/new 输入你的想法  输入你的想法，自动构建新书",
```

同时在 `i18n.ts` 中新增 `/new` 的首次使用引导文案。当用户首次输入 `/new` 时，在 AI 回复前显示一条系统提示：

```
· 开始构思新书。直接描述你的想法——题材、世界观、主角、核心冲突都可以。
  AI 会逐步引导你完善草案，随时用 /draft 查看进度，/create 建书。
```

**涉及文件**：
- 修改：`packages/cli/src/tui/dashboard.tsx`（:361 assistantDraftTimestamp 条件）
- 修改：`packages/cli/src/tui/app.ts`（:135-141 chatStreamBridge + tools hooks）
- 修改：`packages/cli/src/tui/slash-autocomplete.ts`（:2 `/new` 说明）
- 修改：`packages/cli/src/tui/i18n.ts`（:96, :184 新增 `/new` 引导文案）

---

## 依赖关系

```
Step 1 (parser)
  ↓
Step 2 (session schema) ← 无依赖，可与 Step 1 并行
  ↓
Step 3 (developBookDraft + hooks) ← 依赖 Step 1 + 2
  ↓
Step 4 (runtime) ← 依赖 Step 3
  ├─────────────────────────┐
  ↓                         ↓
Step 5 (Studio API SSE)   Step 8 (TUI 流式 + /new 说明)
  ↓                         ← 依赖 Step 3，可与 5-7 并行
Step 6 (前端组件)
  ↓
Step 7 (BookCreate 重写)
```

## 可删除的代码

| 文件 | 内容 | 原因 |
|------|------|------|
| `project-tools.ts:48-93` | `extractBalancedJsonObject` | 被新 parser 替代 |
| `project-tools.ts:95-119` | `parseCreationDraftResult` | 被新 parser 替代 |
| `BookCreate.tsx:67-118` | `PAGE_COPY` 中 idle/helper 相关文案 | 页面结构变了，文案重写 |
| `BookCreate.tsx:158-226` | `MISSING_FIELD_ZH`、`localizeMissingField`、`stringify`、`buildCreationDraftSummary` | 不再需要字段翻译和摘要构建 |
| `BookCreate.tsx:308-350` | `refreshDraft` + 轮询 useEffect | 改为 SSE 驱动 |
| `creation-draft-parser.test.ts` | 全部 | 旧 JSON parser 的测试，被新 parser 测试替代 |
