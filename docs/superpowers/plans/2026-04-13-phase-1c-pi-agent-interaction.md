# Phase 1c: pi-agent 交互层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 pi-agent-core 的 Agent 类替换 InkOS 的交互层，实现每个 session 一个 Agent 实例 + AgentTool 路由到 pipeline + 文件工具 + 流式输出。

**Architecture:** 每个 BookSession 对应一个 Agent 实例（内存缓存，消息从 session 文件恢复）。Agent 通过 `pipeline` tool 调用重操作，通过 `read`/`edit`/`grep`/`ls` 工具操作文件，无 tool 匹配时自然对话。流式输出通过 Agent.subscribe() 事件 → SSE 广播实现。目录结构为 `packages/core/src/agent/` 独立模块，Studio 和 TUI 均可接入。

**Tech Stack:** @mariozechner/pi-agent-core, @mariozechner/pi-ai, Zustand, Hono SSE

**设计 spec:** `docs/infra/studio-routing-and-session.md` Phase 1c 部分

---

## Agent 实例生命周期

```
用户打开 #/book/{bookId}
  → POST /api/agent { instruction, sessionId }
  → 检查内存中是否有该 sessionId 的 Agent
    → 有 → agent.prompt(instruction)
    → 无 → 从 BookSession 文件加载 messages → 创建 Agent → agent.prompt(instruction)

Agent 缓存策略：
  Map<sessionId, Agent>（内存）
  └── 5 分钟无活动后自动回收
  └── session 切换时旧 Agent 保留（可能回来）
```

## 流式输出

```
Agent.subscribe(event)
  │
  ├── message_update (text_delta)  → broadcast("draft:delta", { text })
  ├── tool_execution_start         → broadcast("tool:start", { tool, args })
  ├── tool_execution_update        → broadcast("tool:update", { tool, partialResult })
  ├── tool_execution_end           → broadcast("tool:end", { tool, result })
  ├── message_end                  → broadcast("agent:message", { text })
  └── agent_end                    → broadcast("agent:complete")
```

## 策略：独立模块，渐进替换

```
新模块 packages/core/src/agent/（Studio + 未来 TUI 共用）
  agent-session.ts       — Agent 实例管理（创建、缓存、恢复）
  agent-tools.ts         — pipeline tool + file tools
  agent-system-prompt.ts — system prompt 构建
  index.ts               — barrel exports

现有路径（TUI，暂保留，后续替换）
  packages/core/src/interaction/
    nl-router.ts, runtime.ts, project-control.ts, project-tools.ts
```

---

## File Structure

```
packages/core/src/agent/          ← 新建：独立 agent 模块
├── agent-session.ts              ← Agent 实例管理（per-session 缓存 + 恢复）
├── agent-tools.ts                ← pipeline tool + read + edit + grep + ls
├── agent-system-prompt.ts        ← system prompt 构建
└── index.ts                      ← barrel exports

packages/core/src/interaction/    ← 保留（TUI 兼容，后续渐进替换）
├── runtime.ts
├── nl-router.ts
├── project-tools.ts
└── project-control.ts

packages/studio/src/
├── api/server.ts                 ← 修改：POST /api/agent 走 agent-session
└── store/chat/
    └── slices/message/action.ts  ← 修改：监听流式事件
```

---

### Task 1: 安装 pi-agent-core + Agent system prompt

**Files:**
- Verify: `packages/core/package.json` (pi-agent-core 已安装)
- Create: `packages/core/src/agent/agent-system-prompt.ts`

- [ ] **Step 1: 确认 pi-agent-core 已安装**

```bash
grep "pi-agent-core" packages/core/package.json
```

如果没有：
```bash
pnpm --filter @actalk/inkos-core add @mariozechner/pi-agent-core
```

- [ ] **Step 2: 创建 system prompt**

```typescript
// packages/core/src/agent/agent-system-prompt.ts

export function buildAgentSystemPrompt(bookId: string | null, language: string): string {
  const isZh = language === "zh";

  if (!bookId) {
    return isZh
      ? `你是 InkOS 建书助手。用户想创建一本新书。
通过对话了解用户的想法（题材、世界观、主角、核心冲突），然后调用 pipeline 工具的 create_book action 来创建书籍。
保持简短、自然的对话风格。不要一次问太多问题。`
      : `You are the InkOS book creation assistant. The user wants to create a new book.
Through conversation, understand their ideas (genre, world, protagonist, core conflict), then call the pipeline tool with the create_book action.
Keep responses brief and conversational.`;
  }

  return isZh
    ? `你是 InkOS 写作助手，当前正在处理书籍「${bookId}」。

你可以使用以下工具：
- **pipeline** — 执行重操作：写下一章(write_next)、修订章节(revise)、审计(audit)、建书(create_book)、导出(export)
- **read** — 读取书籍的设定文件或章节内容
- **edit** — 编辑设定文件（如修改角色名、调整世界观）
- **grep** — 搜索内容（如"哪一章提到了某个角色"）
- **ls** — 列出文件或章节

当用户的请求涉及写章节、修订、审计等重操作时，使用 pipeline 工具。
当用户问设定相关的问题时，先用 read 读取对应文件再回答。
当用户想做小修改时（改名字、调设定），用 edit 工具直接修改。
其他情况直接对话回答。`
    : `You are the InkOS writing assistant, working on book "${bookId}".

Available tools:
- **pipeline** — Heavy operations: write_next, revise, audit, create_book, export
- **read** — Read truth files or chapter content
- **edit** — Edit truth files (rename characters, adjust world settings)
- **grep** — Search content across chapters
- **ls** — List files or chapters

Use the pipeline tool for chapter writing, revision, and auditing.
Use read/edit for settings inquiries and small changes.
Chat directly for other questions.`;
}
```

- [ ] **Step 3: 导出**

在 `packages/core/src/index.ts` 添加：

```typescript
export { buildAgentSystemPrompt } from "./interaction/agent-system-prompt.js";
```

- [ ] **Step 4: 验证构建 + 测试**

```bash
pnpm --filter @actalk/inkos-core build 2>&1 | tail -3
pnpm --filter @actalk/inkos-core test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-system-prompt.ts packages/core/src/index.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add pi-agent system prompt for book interaction"
```

---

### Task 2: 定义 AgentTools — SubAgentTool + read + edit + grep + ls

**Files:**
- Create: `packages/core/src/agent/agent-tools.ts`

核心任务。SubAgentTool 负责委托子智能体工作流（architect/writer/auditor/reviser），文件工具直接操作。

- [ ] **Step 1: 创建 agent-tools.ts**

```typescript
// packages/core/src/agent/agent-tools.ts

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { StateManager } from "../pipeline/state.js";

// -- Helper --

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined as void };
}

// -- SubAgentTool (委托子智能体工作流) --

const SubAgentParams = Type.Object({
  agent: Type.String({ description: "子智能体: architect(建书) | writer(写章节) | auditor(审计) | reviser(修订) | exporter(导出)" }),
  instruction: Type.String({ description: "自然语言指令，描述要做什么" }),
  bookId: Type.Optional(Type.String({ description: "书籍 ID" })),
});

export function createSubAgentTool(
  pipeline: PipelineRunner,
  state: StateManager,
  projectRoot: string,
): AgentTool<typeof SubAgentParams> {
  return {
    name: "sub_agent",
    description: "委托子智能体执行写作工作流。architect 建书，writer 写下一章，auditor 审计章节质量，reviser 修订章节，exporter 导出书籍。",
    label: "子智能体",
    parameters: SubAgentParams,
    execute: async (toolCallId, { agent, instruction, bookId }, signal, onUpdate) => {
      switch (agent) {
        case "architect": {
          // 从 instruction 中提取建书参数（LLM 已组织好自然语言）
          // 简化版：直接用 instruction 作为 brief，需要 title/genre 等则由主 Agent 在 instruction 中说明
          const titleMatch = instruction.match(/[《「]([^》」]+)[》」]/) ?? instruction.match(/title[：:]\s*(.+)/i);
          const title = titleMatch?.[1]?.trim() ?? `book-${Date.now()}`;
          const id = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || `book-${Date.now()}`;
          
          onUpdate?.({ content: [{ type: "text", text: "正在生成基础设定..." }], details: undefined as void });
          
          await pipeline.initBook(
            { id, title, genre: "urban", platform: "other", language: "zh", chapterWordCount: 3000, targetChapters: 200, status: "outlining", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { externalContext: instruction },
          );
          return textResult(`书籍「${title}」(${id}) 已创建。Architect 已生成完整 foundation。`);
        }

        case "writer": {
          if (!bookId) return textResult("writer 需要 bookId，请先选择一本书。");
          onUpdate?.({ content: [{ type: "text", text: "正在写章节..." }], details: undefined as void });
          const result = await pipeline.writeNextChapter(bookId);
          return textResult(`第${result.chapterNumber}章「${result.title ?? ""}」已完成，${result.wordCount ?? 0}字。`);
        }

        case "auditor": {
          if (!bookId) return textResult("auditor 需要 bookId。");
          onUpdate?.({ content: [{ type: "text", text: "正在审计..." }], details: undefined as void });
          const result = await pipeline.auditDraft(bookId);
          return textResult(`审计完成（第${result.chapterNumber}章）：${JSON.stringify(result, null, 2).slice(0, 2000)}`);
        }

        case "reviser": {
          if (!bookId) return textResult("reviser 需要 bookId。");
          const isRewrite = /重写|rewrite/i.test(instruction);
          onUpdate?.({ content: [{ type: "text", text: isRewrite ? "正在重写..." : "正在修订..." }], details: undefined as void });
          await pipeline.reviseDraft(bookId, undefined, isRewrite ? "rewrite" : "local-fix");
          return textResult("修订完成。");
        }

        case "exporter": {
          if (!bookId) return textResult("exporter 需要 bookId。");
          return textResult("导出功能待实现。");
        }

        default:
          return textResult(`未知子智能体: ${agent}。可用: architect, writer, auditor, reviser, exporter`);
      }
    },
  };
}

// -- Read Tool --

const ReadParams = Type.Object({
  path: Type.String({ description: "相对于书籍目录的文件路径，如 story/story_bible.md 或 chapters/001.md" }),
});

export function createReadTool(projectRoot: string): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    description: "读取书籍的设定文件或章节内容",
    label: "读取文件",
    parameters: ReadParams,
    execute: async (toolCallId, { path }) => {
      try {
        const content = await readFile(join(projectRoot, "books", path), "utf-8");
        return textResult(content.slice(0, 10000));
      } catch {
        return textResult(`文件不存在: ${path}`);
      }
    },
  };
}

// -- Edit Tool --

const EditParams = Type.Object({
  path: Type.String({ description: "相对于书籍目录的文件路径" }),
  oldText: Type.String({ description: "要替换的原文" }),
  newText: Type.String({ description: "替换后的新文" }),
});

export function createEditTool(projectRoot: string): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    description: "编辑书籍设定文件（精确替换文本）",
    label: "编辑文件",
    parameters: EditParams,
    execute: async (toolCallId, { path, oldText, newText }) => {
      const filePath = join(projectRoot, "books", path);
      try {
        const content = await readFile(filePath, "utf-8");
        if (!content.includes(oldText)) {
          return textResult(`未找到要替换的文本: "${oldText.slice(0, 50)}..."`);
        }
        await writeFile(filePath, content.replace(oldText, newText));
        return textResult("已替换。");
      } catch {
        return textResult(`文件不存在: ${path}`);
      }
    },
  };
}

// -- Grep Tool --

const GrepParams = Type.Object({
  pattern: Type.String({ description: "搜索文本" }),
  bookId: Type.String({ description: "书籍 ID" }),
});

export function createGrepTool(projectRoot: string): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    description: "在书籍的章节和设定文件中搜索内容",
    label: "搜索内容",
    parameters: GrepParams,
    execute: async (toolCallId, { pattern, bookId }) => {
      const bookDir = join(projectRoot, "books", bookId);
      const results: string[] = [];
      for (const dir of ["story", "chapters"]) {
        let files: string[];
        try { files = await readdir(join(bookDir, dir)); } catch { continue; }
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const content = await readFile(join(bookDir, dir, file), "utf-8");
          if (content.includes(pattern)) {
            const matches = content.split("\n").filter(l => l.includes(pattern)).slice(0, 3);
            results.push(`${dir}/${file}: ${matches.join(" | ")}`);
          }
        }
      }
      return textResult(results.length > 0 ? results.join("\n") : `未找到 "${pattern}"。`);
    },
  };
}

// -- Ls Tool --

const LsParams = Type.Object({
  bookId: Type.String({ description: "书籍 ID" }),
  dir: Type.Optional(Type.String({ description: "子目录: story | chapters" })),
});

export function createLsTool(projectRoot: string): AgentTool<typeof LsParams> {
  return {
    name: "ls",
    description: "列出书籍的文件和章节",
    label: "列出文件",
    parameters: LsParams,
    execute: async (toolCallId, { bookId, dir }) => {
      const bookDir = join(projectRoot, "books", bookId);
      const output: string[] = [];
      for (const d of dir ? [dir] : ["story", "chapters"]) {
        try {
          const files = await readdir(join(bookDir, d));
          output.push(`${d}/: ${files.join(", ")}`);
        } catch {
          output.push(`${d}/: (不存在)`);
        }
      }
      return textResult(output.join("\n"));
    },
  };
}
```

- [ ] **Step 2: 验证构建 + 测试**

```bash
pnpm --filter @actalk/inkos-core build 2>&1 | tail -5
pnpm --filter @actalk/inkos-core test 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts
git commit -m "feat(core): define SubAgentTool + file tools (read/edit/grep/ls)"
```

---

### Task 3: Agent Session 管理 — per-session 缓存

**Files:**
- Create: `packages/core/src/agent/agent-session.ts`
- Create: `packages/core/src/agent/index.ts`

- [ ] **Step 1: 创建 agent-session.ts**

```typescript
// packages/core/src/agent/agent-session.ts

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model, Api } from "@mariozechner/pi-ai";
import { buildAgentSystemPrompt } from "./agent-system-prompt.js";
import { createPipelineTool, createReadTool, createEditTool, createGrepTool, createLsTool } from "./agent-tools.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { StateManager } from "../pipeline/state.js";

// -- Agent 实例缓存 --

const agentCache = new Map<string, { agent: Agent; lastActive: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟无活动回收

// 定期清理过期 Agent
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of agentCache) {
    if (now - entry.lastActive > CACHE_TTL) {
      agentCache.delete(id);
    }
  }
}, 60_000);

export interface AgentSessionConfig {
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly pipeline: PipelineRunner;
  readonly state: StateManager;
  readonly projectRoot: string;
  readonly bookId: string | null;
  readonly sessionId: string;
  readonly language: string;
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface AgentSessionResult {
  readonly responseText: string;
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
}

/**
 * 从 BookSession 消息恢复 Agent 的 messages 数组。
 */
function restoreAgentMessages(
  messages: ReadonlyArray<{ role: string; content: string }>,
  model: Model<Api>,
): AgentMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      if (m.role === "user") {
        return { role: "user" as const, content: m.content, timestamp: Date.now() };
      }
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: m.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
    });
}

/**
 * 从 Agent 的 messages 提取纯文本用于持久化。
 */
function extractPlainMessages(messages: AgentMessage[]): ReadonlyArray<{ role: string; content: string }> {
  return messages.map((m: any) => ({
    role: m.role as string,
    content: typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
        : "",
  }));
}

/**
 * 提取最后一条 assistant 消息的文本。
 */
function extractLastResponse(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m: any) => m.role === "assistant");
  if (!last || !("content" in last)) return "";
  const content = (last as any).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  }
  return "";
}

/**
 * 获取或创建 sessionId 对应的 Agent 实例。
 * 如果缓存中没有，从 initialMessages 恢复历史。
 */
function getOrCreateAgent(
  config: AgentSessionConfig,
  initialMessages?: ReadonlyArray<{ role: string; content: string }>,
): Agent {
  const cached = agentCache.get(config.sessionId);
  if (cached) {
    cached.lastActive = Date.now();
    // 更新事件监听（每次请求可能有不同的 onEvent）
    return cached.agent;
  }

  const agent = new Agent();
  agent.state.model = config.model;
  agent.state.systemPrompt = buildAgentSystemPrompt(config.bookId, config.language);
  agent.getApiKey = () => config.apiKey;
  agent.state.tools = [
    createPipelineTool(config.pipeline, config.state, config.projectRoot),
    createReadTool(config.projectRoot),
    createEditTool(config.projectRoot),
    createGrepTool(config.projectRoot),
    createLsTool(config.projectRoot),
  ];
  agent.transformContext = async (msgs) => msgs.slice(-20);

  // 恢复历史消息
  if (initialMessages && initialMessages.length > 0) {
    agent.state.messages = restoreAgentMessages(initialMessages, config.model);
  }

  agentCache.set(config.sessionId, { agent, lastActive: Date.now() });
  return agent;
}

/**
 * 执行一次 Agent 对话。
 * 优先使用缓存的 Agent 实例（保持完整上下文），无缓存则从 BookSession 恢复。
 */
export async function runAgentSession(
  config: AgentSessionConfig,
  userMessage: string,
  initialMessages?: ReadonlyArray<{ role: string; content: string }>,
): Promise<AgentSessionResult> {
  const agent = getOrCreateAgent(config, initialMessages);

  // 订阅事件（流式输出）
  let unsubscribe: (() => void) | undefined;
  if (config.onEvent) {
    unsubscribe = agent.subscribe(async (event) => {
      config.onEvent!(event);
    });
  }

  try {
    await agent.prompt(userMessage);

    return {
      responseText: extractLastResponse(agent.state.messages),
      messages: extractPlainMessages(agent.state.messages),
    };
  } finally {
    unsubscribe?.();
  }
}

/**
 * 清除某个 session 的 Agent 缓存（如 session 切换或删除）。
 */
export function evictAgentCache(sessionId: string): void {
  agentCache.delete(sessionId);
}
```

- [ ] **Step 2: 创建 barrel export**

```typescript
// packages/core/src/agent/index.ts

export { buildAgentSystemPrompt } from "./agent-system-prompt.js";
export { createPipelineTool, createReadTool, createEditTool, createGrepTool, createLsTool } from "./agent-tools.js";
export { runAgentSession, evictAgentCache, type AgentSessionConfig, type AgentSessionResult } from "./agent-session.js";
```

- [ ] **Step 3: 在 core index.ts 导出 agent 模块**

在 `packages/core/src/index.ts` 添加：

```typescript
// Agent (pi-agent integration)
export * from "./agent/index.js";
```

- [ ] **Step 4: 验证构建 + 测试**

```bash
pnpm --filter @actalk/inkos-core build 2>&1 | tail -5
pnpm --filter @actalk/inkos-core test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-session.ts packages/core/src/agent/index.ts packages/core/src/index.ts
git commit -m "feat(core): add per-session Agent cache with pi-agent"
```

---

### Task 4: Studio API — 切换 POST /api/agent 到 pi-agent

**Files:**
- Modify: `packages/studio/src/api/server.ts`

- [ ] **Step 1: 读取当前 POST /api/agent 端点**

读取 `server.ts` 中 POST /api/agent 的完整代码（约 line 627-711）。

- [ ] **Step 2: 添加 pi-agent 路径**

在现有 POST /api/agent 端点中，添加一个 `usePiAgent` 判断。初期通过 query param `?agent=pi` 启用新路径，方便 A/B 测试：

```typescript
app.post("/api/agent", async (c) => {
  const { instruction, activeBookId, sessionId } = await c.req.json<{
    instruction: string;
    activeBookId?: string;
    sessionId?: string;
  }>();

  if (!instruction?.trim()) {
    return c.json({ error: "instruction is required" }, 400);
  }

  const usePiAgent = c.req.query("agent") === "pi" || true; // 默认启用

  if (usePiAgent) {
    return handlePiAgentRequest(c, root, instruction, activeBookId, sessionId, broadcast, state);
  }

  // ... 旧路径保留 ...
});
```

新的 handler 函数：

```typescript
import { runAgentInteraction, type AgentInteractionConfig } from "@actalk/inkos-core";

async function handlePiAgentRequest(
  c: any,
  root: string,
  instruction: string,
  activeBookId: string | undefined,
  sessionId: string | undefined,
  broadcast: (event: string, data: unknown) => void,
  state: StateManager,
) {
  broadcast("agent:start", { instruction, activeBookId });

  try {
    const config = await loadCurrentProjectConfig({ requireApiKey: true });
    const pipeline = new PipelineRunner(buildPipelineConfig(config));

    // 构建 pi-ai Model
    const { createLLMClient } = await import("@actalk/inkos-core");
    const client = createLLMClient(config.llm);

    // 加载 BookSession 历史
    let bookSession = sessionId
      ? await loadBookSession(root, sessionId) ?? await findOrCreateBookSession(root, activeBookId ?? null)
      : await findOrCreateBookSession(root, activeBookId ?? null);

    const initialMessages = bookSession.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    // 执行 pi-agent 对话
    const result = await runAgentInteraction(
      {
        model: client._piModel,
        apiKey: client._apiKey,
        pipeline,
        state,
        projectRoot: root,
        bookId: activeBookId ?? null,
        language: config.language ?? "zh",
        onEvent: (event) => {
          if (event.type === "message_update") {
            const evt = event.assistantMessageEvent;
            if (evt.type === "text_delta") {
              broadcast("draft:delta", { text: evt.delta });
            }
          }
          if (event.type === "tool_execution_start") {
            broadcast("tool:start", { tool: event.toolName, args: event.args });
          }
          if (event.type === "tool_execution_end") {
            broadcast("tool:end", { tool: event.toolName });
          }
        },
      },
      instruction,
      initialMessages,
    );

    // 持久化到 BookSession
    const userMsg = { role: "user" as const, content: instruction, timestamp: Date.now() };
    bookSession = appendBookSessionMessage(bookSession, userMsg);
    if (result.responseText) {
      const assistantMsg = { role: "assistant" as const, content: result.responseText, timestamp: Date.now() + 1 };
      bookSession = appendBookSessionMessage(bookSession, assistantMsg);
    }
    await persistBookSession(root, bookSession);

    broadcast("agent:complete", { instruction, activeBookId });

    return c.json({
      response: result.responseText,
      session: { sessionId: bookSession.sessionId },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    broadcast("agent:error", { instruction, activeBookId, error: msg });
    return c.json({ error: { code: "AGENT_ERROR", message: msg } }, 500);
  }
}
```

- [ ] **Step 3: 验证构建**

```bash
pnpm --filter @actalk/inkos-studio build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add packages/studio/src/api/server.ts
git commit -m "feat(studio): route POST /api/agent through pi-agent interaction"
```

---

### Task 5: Frontend Store — 处理新的事件流

**Files:**
- Modify: `packages/studio/src/store/chat/slices/message/action.ts`

- [ ] **Step 1: 更新 sendMessage 处理新事件**

当前 sendMessage 已经监听 `draft:delta` SSE 事件。pi-agent 路径也广播 `draft:delta`，所以**前端不需要大改**。

但需要额外处理新的 tool 事件：

```typescript
// 在 sendMessage 的 EventSource 监听中添加
streamEs.addEventListener("tool:start", (e: MessageEvent) => {
  try {
    const d = e.data ? JSON.parse(e.data) : null;
    if (d?.tool) {
      // 可以更新 UI 显示正在执行哪个工具
      // 目前只做日志，后续侧边栏 Progress 会用到
      console.log("[tool:start]", d.tool);
    }
  } catch { /* ignore */ }
});
```

这一步改动很小，主要是确保前端和新后端兼容。

- [ ] **Step 2: 验证构建**

```bash
pnpm --filter @actalk/inkos-studio build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add packages/studio/src/store/chat/slices/message/action.ts
git commit -m "feat(studio): handle tool events from pi-agent in message store"
```

---

### Task 6: 测试

**Files:**
- Create: `packages/core/src/__tests__/agent-interaction.test.ts`

- [ ] **Step 1: 编写 Agent 交互测试**

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildAgentSystemPrompt } from "../interaction/agent-system-prompt.js";

describe("agent-system-prompt", () => {
  it("builds Chinese prompt for new book", () => {
    const prompt = buildAgentSystemPrompt(null, "zh");
    expect(prompt).toContain("建书助手");
    expect(prompt).toContain("pipeline");
  });

  it("builds Chinese prompt for existing book", () => {
    const prompt = buildAgentSystemPrompt("my-book", "zh");
    expect(prompt).toContain("my-book");
    expect(prompt).toContain("read");
    expect(prompt).toContain("edit");
    expect(prompt).toContain("grep");
    expect(prompt).toContain("pipeline");
  });

  it("builds English prompt", () => {
    const prompt = buildAgentSystemPrompt("novel", "en");
    expect(prompt).toContain("novel");
    expect(prompt).toContain("pipeline");
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
pnpm --filter @actalk/inkos-core test 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/agent-interaction.test.ts
git commit -m "test(core): add agent system prompt tests"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 全量构建**

```bash
pnpm build 2>&1 | tail -10
```

- [ ] **Step 2: 全量测试**

```bash
pnpm test 2>&1 | tail -10
```

- [ ] **Step 3: 手动验证**

```bash
# 重启 Studio
pkill -f "inkos" 2>/dev/null; sleep 1; inkos studio &
sleep 3

# 测试 pi-agent 对话
curl -s -X POST http://localhost:4567/api/agent \
  -H "Content-Type: application/json" \
  -d '{"instruction":"你好","activeBookId":"九龙城夜行"}' \
  --max-time 60 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response','')[:200])"

# 测试 pipeline tool
curl -s -X POST http://localhost:4567/api/agent \
  -H "Content-Type: application/json" \
  -d '{"instruction":"读一下世界观设定","activeBookId":"九龙城夜行"}' \
  --max-time 60 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response','')[:300])"
```

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix(core): phase 1c polish from e2e testing"
```

---

## 风险与注意事项

1. **pi-agent Agent 的 prompt() 是阻塞的** — 会等待所有 tool 执行完成才返回。对于写章节（可能几分钟），前端需要通过 SSE 事件感知进度。
2. **Agent 无状态** — 每次请求创建新 Agent 实例，历史消息通过 BookSession 传入。后续可以改为 Agent 实例池缓存在内存中。
3. **tool 执行错误** — pi-agent 的 tool.execute 抛异常会被 agent 捕获并告知 LLM。LLM 可能会重试或向用户解释。
4. **旧路径保留** — TUI 继续使用 nl-router + runtime，不受影响。Studio 切换到 pi-agent 路径。
5. **@sinclair/typebox** — pi-agent-core 依赖 typebox 做 tool 参数 schema 定义，确保版本兼容。
