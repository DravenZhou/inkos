# Tool Calling 驱动的建书流程

## 概述

将建书从 `chatCompletion` + `:::` 文本标记改为 `chatWithTools` + tool calling。LLM 通过调用 `create_book` tool 返回结构化参数，前端渲染为可编辑表单，用户确认后调 `initBook()`。与 CLI `inkos book create` 完全对齐。

## 数据流

```
用户："港风悬疑，主角是O记警探"
    ↓
chatWithTools(messages, [create_book_tool])
    ↓
LLM 返回：
  content: "好的，我帮你生成了一份建书表单..."
  toolCalls: [{
    name: "create_book",
    arguments: { title, genre, platform, targetChapters, chapterWordCount, brief }
  }]
    ↓
前端：content 渲染为文本 + arguments 渲染为可编辑表单
    ↓
用户修改表单 / 或自然语言继续对话
    ↓
用户点"开始写" → initBook(BookConfig, { externalContext: brief })
```

## Tool 定义

```typescript
const CREATE_BOOK_TOOL: ToolDefinition = {
  name: "create_book",
  description: "根据用户描述生成建书参数。系统会将参数渲染为可编辑表单，用户确认后建书。",
  parameters: {
    type: "object",
    properties: {
      title:            { type: "string", description: "书名" },
      genre:            { type: "string", description: "题材标识，如 xuanhuan, progression, romance" },
      platform:         { type: "string", enum: ["tomato", "qidian", "feilu", "other"] },
      targetChapters:   { type: "number", description: "目标章数，默认 200" },
      chapterWordCount: { type: "number", description: "每章字数，默认 3000" },
      language:         { type: "string", enum: ["zh", "en"], description: "写作语言" },
      brief:            { type: "string", description: "创意简述，会传给 Architect 生成 foundation 五文件" },
    },
    required: ["title", "genre", "platform", "brief"],
  },
};
```

## System Prompt

精简为一段：

```
你是 InkOS 的建书助手。用户会描述想写的书，你需要调用 create_book 工具来生成建书参数。

规则：
1. 从用户描述中推断所有字段，大胆预填合理默认值。
2. brief 字段要详细——它会传给 Architect 智能体生成完整的世界观、主角、冲突等 foundation 文件。把用户提到的所有创意要素都写进 brief。
3. 如果用户后续要求修改某些字段，重新调用 create_book 工具，只更新被提到的字段，其余保持不变。
4. 不要只回复文字讨论——必须调用 create_book 工具输出结构化参数。
```

## 改动范围

### Core 层

**`packages/core/src/interaction/project-tools.ts`**

`developBookDraft` 改造：
- 从 `chatCompletion` + `:::` prompt → `chatWithTools` + `CREATE_BOOK_TOOL`
- System prompt 替换为上述精简版
- 返回值增加 `toolCall` 字段：`{ name, arguments }`
- 保留 `onDraftTextDelta` 用于流式显示 LLM 的 content 部分

**返回结构变更**：
```typescript
return {
  __interaction: {
    responseText: result.content,  // LLM 的自然语言回复
    details: {
      toolCall: result.toolCalls[0],  // { name: "create_book", arguments: {...} }
    },
  },
};
```

### Studio 前端

**`packages/studio/src/components/chat/ChatMessage.tsx`**

消息类型扩展：
```typescript
interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCall?: { name: string; arguments: Record<string, unknown> };  // 新增
}
```

当 `toolCall` 存在且 `name === "create_book"` 时，渲染 `BookFormCard` 组件。

**`packages/studio/src/components/chat/BookFormCard.tsx`**（新建）

静态表单，映射 tool_call.arguments 到输入控件：
- title → text input
- genre → select/dropdown（从可用题材列表）
- platform → radio group（番茄/起点/飞卢/其他）
- targetChapters → number input
- chapterWordCount → number input
- language → radio（中/英）
- brief → textarea

底部按钮："开始写这本书"

**`packages/studio/src/pages/ChatPage.tsx`**

- `sendMessage` 处理：从 API response 的 `details.toolCall` 提取参数
- 存入 message 的 `toolCall` 字段
- "开始写"按钮 → POST `/books/create`（或直接调 `/agent` with `/create`）

### Server 层

**`packages/studio/src/api/server.ts`**

`/api/agent` response 已经包含 `details`（之前加的）。`details.toolCall` 会自然传到前端。

### TUI

TUI 暂不渲染表单——显示 LLM 的 content 文本 + 打印 tool_call 参数的文本摘要。用户通过继续输入来修改，或直接 `/create` 确认。

### 清理

- `:::` 相关 prompt 从 `BOOK_DRAFT_SYSTEM_PROMPT` 中移除
- `draft-directive-parser.ts` 保留（其他场景可能用）但建书不再依赖
- `creationDraft` / `draftRounds` 在建书流程中弱化——tool_call.arguments 替代 draft
- `StreamMessage.tsx` / `InlineField.tsx` 等保留

## 与 CLI 对齐

| | CLI | Studio/TUI (新) |
|---|---|---|
| 输入 | `--title X --genre Y --brief Z` | LLM 从一句话推断 → tool_call.arguments |
| 验证 | CLI flag 解析 | Zod schema 验证 tool_call |
| 执行 | `PipelineRunner.initBook()` | 同一个 `initBook()` |
| 产物 | foundation 5 文件 | 完全一致 |
