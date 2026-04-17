# Agent Context Management 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 每次调 LLM 前自动注入书籍真相文件，并在前端展示 context 占用比例。

**Architecture:** 利用 pi-agent-core 的 `transformContext` hook 在每次 LLM 调用前从磁盘读取 `story/` 目录下的真相文件并注入到 messages 数组。server.ts 通过监听 `message_end` 事件提取 `usage.input`，结合 `contextWindow` 算出比例通过 SSE 广播给前端。

**Tech Stack:** TypeScript, pi-agent-core `transformContext`, Hono SSE, React/Zustand, Vitest

---

### Task 1: 创建 `context-transform.ts` — 核心 transformContext 工厂函数

**Files:**
- Create: `packages/core/src/agent/context-transform.ts`
- Test: `packages/core/src/__tests__/context-transform.test.ts`

- [ ] **Step 1: 写测试 — bookId 为 null 时直接返回原始 messages**

```ts
// packages/core/src/__tests__/context-transform.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBookContextTransform } from "../agent/context-transform.js";

describe("createBookContextTransform", () => {
  let projectRoot: string;
  const bookId = "test-book";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ctx-test-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns messages unchanged when bookId is null", async () => {
    const transform = createBookContextTransform(null, projectRoot);
    const messages = [
      { role: "user" as const, content: "hello", timestamp: Date.now() },
    ];
    const result = await transform(messages);
    expect(result).toBe(messages); // same reference, no copy
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test -- packages/core/src/__tests__/context-transform.test.ts
```

Expected: FAIL — `createBookContextTransform` 不存在。

- [ ] **Step 3: 写最小实现**

```ts
// packages/core/src/agent/context-transform.ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function createBookContextTransform(
  bookId: string | null,
  projectRoot: string,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  if (bookId === null) {
    return async (messages) => messages;
  }

  return async (messages) => messages; // placeholder for next step
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test -- packages/core/src/__tests__/context-transform.test.ts
```

Expected: PASS

- [ ] **Step 5: 追加测试 — bookId 存在时读取真相文件并注入 user message**

在 Step 1 创建的 `describe` 块内部（`it("returns messages unchanged when bookId is null", ...)` 之后），追加以下两个测试。不要新开 `describe` 块。所需的 `beforeEach/afterEach/import` 已经在 Step 1 里写好了，只需在已有 `beforeEach` 末尾加上创建真相文件的代码：

首先把 Step 1 的 `beforeEach` 扩展为创建真相文件：

```ts
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ctx-test-"));
    const storyDir = join(projectRoot, "books", bookId, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "story_bible.md"), "# Story Bible\nA hero's journey.");
    await writeFile(join(storyDir, "current_focus.md"), "Focus on chapter 3.");
  });
```

然后在 `describe` 块内追加两个测试：

```ts
  it("prepends a user message with truth file contents", async () => {
    const transform = createBookContextTransform(bookId, projectRoot);
    const original = [
      { role: "user" as const, content: "写下一章", timestamp: Date.now() },
    ];
    const result = await transform(original);

    // 原始 messages 不被修改
    expect(original).toHaveLength(1);
    // 新数组比原始多一条
    expect(result).toHaveLength(2);
    // 第一条是注入的 user message
    const injected = result[0] as { role: string; content: string };
    expect(injected.role).toBe("user");
    expect(injected.content).toContain("story_bible.md");
    expect(injected.content).toContain("A hero's journey.");
    expect(injected.content).toContain("current_focus.md");
    expect(injected.content).toContain("Focus on chapter 3.");
    // 第二条是原始消息
    expect(result[1]).toBe(original[0]);
  });

  it("sorts truth files in priority order", async () => {
    const storyDir = join(projectRoot, "books", bookId, "story");
    await writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline");
    await writeFile(join(storyDir, "book_rules.md"), "# Book Rules");
    await writeFile(join(storyDir, "extra_notes.md"), "# Extra");

    const transform = createBookContextTransform(bookId, projectRoot);
    const result = await transform([
      { role: "user" as const, content: "test", timestamp: Date.now() },
    ]);
    const content = (result[0] as { content: string }).content;

    const bibleIdx = content.indexOf("story_bible.md");
    const outlineIdx = content.indexOf("volume_outline.md");
    const rulesIdx = content.indexOf("book_rules.md");
    const focusIdx = content.indexOf("current_focus.md");
    const extraIdx = content.indexOf("extra_notes.md");

    expect(bibleIdx).toBeLessThan(outlineIdx);
    expect(outlineIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(focusIdx);
    expect(focusIdx).toBeLessThan(extraIdx);
  });
```

- [ ] **Step 6: 跑测试确认失败**

```bash
pnpm test -- packages/core/src/__tests__/context-transform.test.ts
```

Expected: FAIL — 注入逻辑未实现。

- [ ] **Step 7: 实现完整的 transformContext 逻辑**

```ts
// packages/core/src/agent/context-transform.ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Files read in this order; anything else in story/ comes after, sorted alphabetically. */
const PRIORITY_FILES = [
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "current_focus.md",
];

export function createBookContextTransform(
  bookId: string | null,
  projectRoot: string,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  if (bookId === null) {
    return async (messages) => messages;
  }

  const storyDir = join(projectRoot, "books", bookId, "story");

  return async (messages) => {
    const sections = await readTruthFiles(storyDir);
    if (sections.length === 0) return messages;

    const body =
      "[以下是当前书籍的真相文件，每次对话时自动从磁盘读取注入。请基于这些内容进行创作和判断。]\n\n" +
      sections.map((s) => `=== ${s.name} ===\n${s.content}`).join("\n\n");

    const injected: UserMessage = {
      role: "user",
      content: body,
      timestamp: Date.now(),
    };

    return [injected, ...messages];
  };
}

interface TruthFileSection {
  name: string;
  content: string;
}

async function readTruthFiles(storyDir: string): Promise<TruthFileSection[]> {
  let entries: string[];
  try {
    entries = await readdir(storyDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  // Sort: priority files first (in order), then remaining files alphabetically
  const prioritySet = new Set(PRIORITY_FILES);
  const prioritized = PRIORITY_FILES.filter((f) => mdFiles.includes(f));
  const rest = mdFiles.filter((f) => !prioritySet.has(f)).sort();
  const ordered = [...prioritized, ...rest];

  const sections: TruthFileSection[] = [];
  for (const fileName of ordered) {
    try {
      const content = await readFile(join(storyDir, fileName), "utf-8");
      sections.push({ name: fileName, content });
    } catch {
      // skip unreadable files
    }
  }
  return sections;
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
pnpm test -- packages/core/src/__tests__/context-transform.test.ts
```

Expected: PASS

- [ ] **Step 9: 追加测试 — story/ 目录不存在时返回原始 messages**

在同一个 `describe` 块内追加：

```ts
  it("returns original messages when story/ directory does not exist", async () => {
    const transform = createBookContextTransform("nonexistent-book", projectRoot);
    const original = [
      { role: "user" as const, content: "test", timestamp: Date.now() },
    ];
    const result = await transform(original);
    expect(result).toBe(original);
  });
```

- [ ] **Step 10: 跑测试确认通过**（这个测试应该已经能通过，因为 `readdir` 失败返回空数组）

```bash
pnpm test -- packages/core/src/__tests__/context-transform.test.ts
```

Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add packages/core/src/agent/context-transform.ts packages/core/src/__tests__/context-transform.test.ts
git commit -m "feat(core): add createBookContextTransform for truth file injection"
```

---

### Task 2: 接入 `transformContext` — 修改 `agent-session.ts`

**Files:**
- Modify: `packages/core/src/agent/agent-session.ts:230-253`
- Modify: `packages/core/src/agent/index.ts`

- [ ] **Step 1: 在 `agent-session.ts` 中导入 `createBookContextTransform` 并传入 Agent 构造函数**

在 `agent-session.ts` 顶部导入：

```ts
import { createBookContextTransform } from "./context-transform.js";
```

在 `new Agent({...})` 调用（当前约 :232）中增加 `transformContext` 参数：

```ts
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: buildAgentSystemPrompt(bookId, language),
        tools: [
          createSubAgentTool(pipeline, bookId, projectRoot),
          createReadTool(projectRoot),
          createWriteTruthFileTool(pipeline, projectRoot, bookId),
          createRenameEntityTool(pipeline, projectRoot, bookId),
          createPatchChapterTextTool(pipeline, projectRoot, bookId),
          createEditTool(projectRoot),
          createWriteFileTool(projectRoot),
          createGrepTool(projectRoot),
          createLsTool(projectRoot),
        ],
      },
      transformContext: createBookContextTransform(bookId, projectRoot),
      streamFn: streamSimple,
      getApiKey: (provider: string) => {
        if (config.apiKey) return config.apiKey;
        return getEnvApiKey(provider);
      },
    });
```

- [ ] **Step 2: 在 `index.ts` 中导出 `createBookContextTransform`**

在 `packages/core/src/agent/index.ts` 中添加：

```ts
export { createBookContextTransform } from "./context-transform.js";
```

- [ ] **Step 3: 跑全量测试确认无回归**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/agent/agent-session.ts packages/core/src/agent/index.ts
git commit -m "feat(core): wire transformContext into Agent for truth file injection"
```

---

### Task 3: 修复 legacy fallback 的 `contextWindow` — 修改 `server.ts`

**Files:**
- Modify: `packages/studio/src/api/server.ts:1460-1470`（legacy fallback 区域）
- Test: `packages/studio/src/api/server.test.ts`（确认现有测试不回归）

- [ ] **Step 1: 在 `server.ts` 顶部确认 `getModel` 已导入**

查看现有导入。如果没有导入 `getModel`，从 `@mariozechner/pi-ai` 添加：

```ts
import { getModel } from "@mariozechner/pi-ai";
```

- [ ] **Step 2: 修改 legacy fallback 代码**

当前代码（约 :1462-1468）：

```ts
      if (!resolvedModel) {
        // 4. Legacy fallback: use createLLMClient
        resolvedModel = client._piModel
          ? client._piModel
          : { provider: config.llm.provider ?? "anthropic", modelId: config.llm.model } as any;
        resolvedApiKey = client._apiKey;
      }
```

修改为：

```ts
      if (!resolvedModel) {
        // 4. Legacy fallback: use createLLMClient
        if (client._piModel) {
          resolvedModel = client._piModel;
        } else {
          const fallbackProvider = config.llm.provider ?? "anthropic";
          const fallbackModelId = config.llm.model;
          try {
            const piModel = getModel(fallbackProvider as any, fallbackModelId as any);
            resolvedModel = piModel ?? { provider: fallbackProvider, modelId: fallbackModelId } as any;
          } catch {
            resolvedModel = { provider: fallbackProvider, modelId: fallbackModelId } as any;
          }
        }
        resolvedApiKey = client._apiKey;
      }
```

**重要说明：**

不要给 fallback 对象加 `id` / `api` 字段。`agent-session.ts:95` 的 `resolveModel` 会检查 `"id" in spec && "api" in spec`：有这两个字段就当作完整 Model 直接用；没有的话会走 `getModel(provider, modelId)` 查询。fallback 对象只给 `provider` 和 `modelId` 保证查询路径被触发，如果 pi-ai 注册表查得到就拿到带正确 `contextWindow` 的完整 Model，查不到时 contextWindow 为 undefined，Task 4 的 `ratio` 会自动为 `null`，前端不显示比例。

- [ ] **Step 3: 跑全量测试**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/studio/src/api/server.ts
git commit -m "fix(studio): resolve contextWindow from pi-ai registry in legacy fallback"
```

---

### Task 4: 广播 `context:usage` SSE 事件 — 修改 `server.ts`

**Files:**
- Modify: `packages/studio/src/api/server.ts`（`POST /api/v1/agent` 的 onEvent 回调区域）

- [ ] **Step 1: 在 onEvent 回调最前面提取 `contextWindow`**

在 `POST /api/v1/agent` handler 里，`runAgentSession` 调用之前（约 :1445），添加提取 contextWindow 的代码：

```ts
      const contextWindow = (resolvedModel as any)?.contextWindow ?? 0;
```

- [ ] **Step 2: 在 onEvent 回调内增加 `message_end` 监听**

在现有的 `tool_execution_end` 处理之后（约 :1518），添加：

```ts
            if (event.type === "message_end") {
              const endMsg = event.message as any;
              if (endMsg?.role === "assistant" && endMsg?.usage) {
                broadcast("context:usage", {
                  sessionId: streamSessionId,
                  ratio: contextWindow > 0 ? endMsg.usage.input / contextWindow : null,
                });
              }
            }
```

- [ ] **Step 3: 跑全量测试**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/studio/src/api/server.ts
git commit -m "feat(studio): broadcast context:usage SSE event after each LLM call"
```

---

### Task 5: 前端接收 `context:usage` 事件 — 修改 store 和 SSE hook

**Files:**
- Modify: `packages/studio/src/hooks/use-sse.ts`
- Modify: `packages/studio/src/store/chat/types.ts`
- Modify: `packages/studio/src/store/chat/slices/message/initialState.ts`
- Modify: `packages/studio/src/store/chat/slices/message/action.ts`

- [ ] **Step 1: 在 SSE 事件列表中增加 `context:usage`**

在 `packages/studio/src/hooks/use-sse.ts` 的 `STUDIO_SSE_EVENTS` 数组里添加：

```ts
  "context:usage",
```

加在 `"llm:progress"` 之后即可。

- [ ] **Step 2: 在 store 类型中增加 context usage 状态**

在 `packages/studio/src/store/chat/types.ts` 的 `MessageState` 接口中添加：

```ts
  contextUsageRatio: number | null;
```

在 `MessageActions` 接口中添加：

```ts
  setContextUsageRatio: (ratio: number | null) => void;
```

- [ ] **Step 3: 在初始 state 中加入默认值**

`packages/studio/src/store/chat/slices/message/initialState.ts` 当前是：

```ts
import type { MessageState } from "../../types";

export const initialMessageState: MessageState = {
  sessions: {},
  sessionIdsByBook: {},
  activeSessionId: null,
  input: "",
  selectedModel: null,
  selectedService: null,
};
```

改为：

```ts
import type { MessageState } from "../../types";

export const initialMessageState: MessageState = {
  sessions: {},
  sessionIdsByBook: {},
  activeSessionId: null,
  input: "",
  selectedModel: null,
  selectedService: null,
  contextUsageRatio: null,
};
```

- [ ] **Step 4: 在 message action slice 中实现**

在 `packages/studio/src/store/chat/slices/message/action.ts` 的 `createMessageSlice` 返回对象中添加：

```ts
  setContextUsageRatio: (ratio) => set({ contextUsageRatio: ratio }),
```

- [ ] **Step 5: 在 `sendMessage` 中监听 `context:usage` 事件**

在 `sendMessage` 函数里，现有的 `streamEs.addEventListener("llm:progress", ...)` 之后添加：

```ts
    streamEs.addEventListener("context:usage", (event: MessageEvent) => {
      try {
        const data = event.data ? JSON.parse(event.data) : null;
        if (!sessionMatchesEvent(sessionId, data)) return;
        const ratio = typeof data?.ratio === "number" ? data.ratio : null;
        get().setContextUsageRatio(ratio);
      } catch {
        // ignore
      }
    });
```

- [ ] **Step 6: 跑全量测试**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add packages/studio/src/hooks/use-sse.ts packages/studio/src/store/chat/types.ts packages/studio/src/store/chat/slices/message/initialState.ts packages/studio/src/store/chat/slices/message/action.ts
git commit -m "feat(studio): receive context:usage SSE event in chat store"
```

---

### Task 6: Context 占用比例 UI 组件

**Files:**
- Create: `packages/studio/src/components/chat/ContextUsageBar.tsx`
- Modify: `packages/studio/src/pages/ChatPage.tsx`

- [ ] **Step 1: 创建 `ContextUsageBar.tsx`**

```tsx
// packages/studio/src/components/chat/ContextUsageBar.tsx

interface ContextUsageBarProps {
  ratio: number | null;
}

export function ContextUsageBar({ ratio }: ContextUsageBarProps) {
  if (ratio === null) return null;

  const percent = Math.round(ratio * 100);
  const color =
    ratio < 0.6
      ? "bg-emerald-500"
      : ratio < 0.85
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">上下文</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[120px]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <span className="shrink-0 tabular-nums">{percent}%</span>
    </div>
  );
}
```

- [ ] **Step 2: 在 `ChatPage.tsx` 中引入并展示**

在 `ChatPage.tsx` 导入处添加：

```ts
import { ContextUsageBar } from "../components/chat/ContextUsageBar";
```

从 store 取 `contextUsageRatio`：

```ts
  const contextUsageRatio = useChatStore((s) => s.contextUsageRatio);
```

在输入区域的底栏（model picker 所在的 `div`，约 :455）中，model picker 之后添加：

```tsx
                <ContextUsageBar ratio={contextUsageRatio} />
```

具体位置是在 `<div className="flex items-center gap-2 px-3 pb-2 border-t border-border/20 pt-1.5">` 内，model picker 条件渲染之后、`</div>` 闭合标签之前。

- [ ] **Step 3: 在浏览器中验证**

```bash
pnpm dev
```

打开 Studio，发一条消息，确认输入框底栏出现 context 占用比例条。如果模型 contextWindow 为 0，比例条不应显示。

- [ ] **Step 4: 提交**

```bash
git add packages/studio/src/components/chat/ContextUsageBar.tsx packages/studio/src/pages/ChatPage.tsx
git commit -m "feat(studio): add context usage ratio indicator in chat input area"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 跑全量测试确认无回归**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 2: 类型检查**

```bash
pnpm build
```

Expected: 无 TypeScript 编译错误。

- [ ] **Step 3: 手动端到端验证**

```bash
pnpm dev
```

打开 Studio（http://localhost:5173 或你配置的端口），按以下清单验证：

1. 选一个已有书籍的 session
2. 发一条消息（如"写下一章"）
3. 等 agent 回复完成后，确认输入框底栏的 model picker 右边出现 context 比例指示器
4. 比例值应该大于 0%（因为注入了真相文件）
5. 颜色：< 60% 绿、60%-85% 黄、> 85% 红
6. 切换到另一个使用 pi-ai 注册表里不存在的模型（比如自定义服务商）时，比例条应不显示（因为 contextWindow 为 0）
7. 建书模式（无 bookId）下发消息，比例条正常显示（不过比例会比带书籍时低，因为没注入真相文件）

如果发现问题，回到对应 task 修复，不要在此 task 里改。
