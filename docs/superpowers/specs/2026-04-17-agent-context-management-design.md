# Agent Context Management 设计

## 背景

InkOS 的 Studio agent（pi-agent-core）目前没有任何 context window 管理。`transformContext` 和 `convertToLlm` 都没有配置，使用 pi-agent 的默认行为（透传所有 user/assistant/toolResult 消息）。

这导致两个问题：

1. agent 在做关键决策（写章节、审计、修订）时，context 里不一定有 story_bible、volume_outline 等真相文件的最新内容。agent 要么靠 `read` 工具自己去读（浪费一轮调用且不一定记得），要么靠之前某轮对话里读过的 toolResult（随对话增长被淹没）。
2. 用户无法看到当前 context 的占用情况，不知道什么时候该开新 session。

## 设计

### 1. transformContext 注入真相文件

在 `agent-session.ts` 创建 Agent 时传入 `transformContext` 函数。

**工厂函数签名：**

```ts
function createBookContextTransform(
  bookId: string | null,
  projectRoot: string,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
```

**行为：**

- `bookId === null`（建书模式）：直接返回原始 messages，不做任何处理。
- `bookId !== null`：
  1. 扫描 `books/{bookId}/story/` 目录下所有 `.md` 文件
  2. 按固定优先级排序读取：`story_bible.md` → `volume_outline.md` → `book_rules.md` → `current_focus.md` → 其余文件按文件名字母序
  3. 把所有文件内容拼成一条 user message
  4. 插入到 messages 数组最前面
  5. 返回新数组（不修改原始 messages）

**注入的 user message 格式：**

```
[以下是当前书籍的真相文件，每次对话时自动从磁盘读取注入。请基于这些内容进行创作和判断。]

=== story_bible.md ===
{文件内容}

=== volume_outline.md ===
{文件内容}

=== book_rules.md ===
{文件内容}

=== current_focus.md ===
{文件内容}
```

**错误处理：**

- 单个文件读取失败（不存在或权限问题）：跳过该文件，不影响其他文件。
- `story/` 目录不存在：返回原始 messages，不注入。
- 所有文件都读取失败：返回原始 messages，不注入。

**为什么用 user message：**

pi-agent 默认的 `convertToLlm` 只保留 user/assistant/toolResult 三种 role。用 user message 不需要额外覆盖 `convertToLlm`。

**为什么每次从磁盘重读：**

写作过程中 agent 可能通过 `write_truth_file` 工具更新真相文件。每次 LLM 调用前重读，保证 context 里的真相文件永远是最新版本。本地文件读取延迟可忽略。

### 2. Context 占用比例 UI

**数据获取：**

server.ts 的 `onEvent` 回调增加对 pi-agent `message_end` 事件的监听：

```ts
if (event.type === "message_end") {
  const msg = event.message as AssistantMessage;
  if (msg.role === "assistant" && msg.usage) {
    broadcast("context:usage", {
      sessionId: streamSessionId,
      ratio: contextWindow > 0 ? msg.usage.input / contextWindow : null,
    });
  }
}
```

- `usage.input`：LLM 返回的实际输入 token 数，精确值。
- `contextWindow`：从 `resolvedModel.contextWindow` 取，在 onEvent 之前已确定。
- `ratio` 为 `null` 表示 contextWindow 未知，前端不显示比例。

**前端：**

在聊天界面展示比例指示器，每次收到 `context:usage` SSE 事件时更新。

颜色分档：
- 绿色：< 60%
- 黄色：60%~85%
- 红色：> 85%
- `ratio` 为 `null` 时：不显示

### 3. contextWindow 来源修复

**当前问题：**

- `resolveServiceModel` 路径：从 pi-ai 注册表查 `contextWindow`，模型在注册表里时值正确，不在时回退到 `0`。
- legacy fallback 路径（server.ts:1412-1417）：构造的对象没有 `contextWindow` 字段，或从 `provider.ts:160` 硬编码 `128_000`。

**修复：**

legacy fallback 里也尝试从 pi-ai 注册表查一次：

```ts
if (client._piModel) {
  resolvedModel = client._piModel;
} else {
  const provider = config.llm.provider ?? "anthropic";
  const modelId = config.llm.model;
  try {
    const piModel = getModel(provider, modelId);
    resolvedModel = piModel ?? { provider, modelId, contextWindow: 0, maxTokens: 16384, /* 其他必要字段 */ };
  } catch {
    resolvedModel = { provider, modelId, contextWindow: 0, maxTokens: 16384, /* 其他必要字段 */ };
  }
}
```

**contextWindow 获取优先级：**

1. pi-ai 注册表查到 → 用注册表的值
2. 查不到 → `contextWindow: 0` → 前端 `ratio: null` → 不显示比例

不硬编码错误的默认值。

## 涉及的文件

| 文件 | 改动 |
|---|---|
| `packages/core/src/agent/agent-session.ts` | 创建 Agent 时传入 `transformContext` |
| `packages/core/src/agent/context-transform.ts` | 新文件：`createBookContextTransform` 工厂函数 |
| `packages/studio/src/api/server.ts` | onEvent 增加 `message_end` 监听，广播 `context:usage`；修复 legacy fallback 的 contextWindow |
| `packages/studio/src/hooks/use-sse.ts` | STUDIO_SSE_EVENTS 数组增加 `context:usage` |
| `packages/studio/src/store/chat/` | 新增 context usage 状态管理 |
| `packages/studio/src/components/` | 新增 context 占用比例 UI 组件 |

## 不做的事情

- 不做自动裁剪、token 预算控制
- 不修改 `convertToLlm`
- 不修改 system prompt
- 不修复 `listModelsForService` 返回 `contextWindow: 0` 的问题（不影响 agent 端点）
