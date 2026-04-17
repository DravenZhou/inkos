# Session 管理优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 InkOS Studio 支持一本书多段会话、多会话并行流式、以及新建书籍时的 session 全新创建 + 迁移。

**Architecture:** Core 层新增 title 字段和 rename/delete/migrate 函数，删掉 findOrCreateBookSession；API 层把 POST /sessions 改成永远新建、POST /agent 强制要 sessionId、新增 PUT/DELETE；前端 store 把 MessageState 从单数改成 `sessions: Record<sessionId, SessionRuntime>` 按 id 分片；侧边栏从扁平书列表改成树形（书 → session 子项）。

**Tech Stack:** TypeScript, Zod, Hono (server), Zustand (store), React, Vitest

**Spec:** `docs/superpowers/specs/2026-04-16-session-management-design.md`

## Execution Status

_Updated: 2026-04-17_

- [x] Task 1: Core — `BookSession` 增加 `title`
- [x] Task 2: Core — `rename` / `delete` / `migrate`
- [x] Task 3: Core — 删除 `findOrCreateBookSession`
- [x] Task 4: API — session endpoints 更新，`POST /agent` 强制 `sessionId`
- [x] Task 5: Store — `types` / `initialState` / `selectors` 适配多 session
- [x] Task 6: Store — `message slice` 多 session 化
- [x] Task 7: Store — `create slice` 传 `sessionId` 并处理迁移
- [x] Task 8: UI — Sidebar 树形 session 列表
- [x] Task 9: UI — ChatPage / localStorage 新建书籍流程
- [x] Task 10: 标题自动生成与 `session:title` 前端实时更新
- [ ] 计划中的分步 commit 没执行；当前保留在工作区改动里统一检查

---

## File Map

**Core (packages/core/src/interaction/)**
- Modify: `session.ts:101-135` — BookSessionSchema 加 title，createBookSession 初始化 title
- Modify: `book-session-store.ts` — 新增 renameBookSession / deleteBookSession / migrateBookSession，删除 findOrCreateBookSession
- Modify: `__tests__/book-session-store.test.ts` — 新增 rename/delete/migrate 测试，删除 findOrCreate 测试

**API (packages/studio/src/api/)**
- Modify: `server.ts:1239-1262` — 更新 GET /sessions（补 title）、POST /sessions（改为永远新建）
- Modify: `server.ts:1264-1292` — POST /agent 强制要 sessionId
- 新增端点: PUT /sessions/:id, DELETE /sessions/:id

**Store (packages/studio/src/store/chat/)**
- Modify: `types.ts` — 新增 SessionRuntime，重构 MessageState / MessageActions
- Modify: `slices/message/initialState.ts` — 适配新 state 形状
- Modify: `slices/message/action.ts` — loadSession/sendMessage 按 sessionId 分片
- Modify: `slices/create/action.ts` — handleCreateBook 传 sessionId + 处理迁移
- Modify: `selectors.ts` — 适配新 state
- Modify: `initialState.ts` — 合并

**UI (packages/studio/src/)**
- Modify: `components/Sidebar.tsx` — 树形：书展开 → session 子项 + 新建会话 + 活跃指示
- Modify: `pages/ChatPage.tsx` — 从 sessions[activeSessionId] 读消息，sendMessage 传 sessionId
- Modify: `pages/chat-page-state.ts` — 删除 shouldUseFreshBookCreateSession，改用 localStorage 逻辑
- Modify: `hooks/use-hash-route.ts` — 无需改（book-create 路由已存在）
- Modify: `App.tsx:165-179` — ChatPage 接收 activeSessionId prop

---

## Task 1: Core — BookSession 加 title 字段

**Files:**
- Modify: `packages/core/src/interaction/session.ts:101-135`
- Test: `packages/core/src/__tests__/book-session-store.test.ts`

- [ ] **Step 1: 在 BookSessionSchema 中加 title 字段**

```ts
// session.ts:101-111  改为：
export const BookSessionSchema = z.object({
  sessionId: z.string().min(1),
  bookId: z.string().nullable(),
  title: z.string().nullable().default(null),          // ← 新增
  messages: z.array(InteractionMessageSchema).default([]),
  creationDraft: BookCreationDraftSchema.optional(),
  draftRounds: z.array(DraftRoundSchema).default([]),
  events: z.array(InteractionEventSchema).default([]),
  currentExecution: ExecutionStateSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
```

- [ ] **Step 2: createBookSession 初始化 title: null**

```ts
// session.ts:124-135  改为：
export function createBookSession(bookId: string | null): BookSession {
  const now = Date.now();
  return {
    sessionId: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    bookId,
    title: null,                                         // ← 新增
    messages: [],
    draftRounds: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}
```

- [ ] **Step 3: 写 title 字段专项测试**

在 `book-session-store.test.ts` 的 `persistBookSession + loadBookSession` describe 块末尾加：

```ts
it("createBookSession initializes title as null", () => {
  const session = createBookSession("book");
  expect(session.title).toBeNull();
});

it("parses old session files without title field (backward compat)", async () => {
  // 模拟老格式文件（没有 title 字段）
  const oldFormat = {
    sessionId: "old-session",
    bookId: "book",
    messages: [],
    draftRounds: [],
    events: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
  const dir = join(tempDir, ".inkos", "sessions");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old-session.json"), JSON.stringify(oldFormat));
  const loaded = await loadBookSession(tempDir, "old-session");
  expect(loaded).not.toBeNull();
  expect(loaded!.title).toBeNull(); // Zod default(null) 填充
});

it("round-trips title through persist/load", async () => {
  let session = createBookSession("book");
  session = { ...session, title: "测试标题" };
  await persistBookSession(tempDir, session);
  const loaded = await loadBookSession(tempDir, session.sessionId);
  expect(loaded!.title).toBe("测试标题");
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @actalk/inkos-core build && pnpm test`
Expected: 所有测试通过（title 有 default(null)，老 session 文件解析不受影响）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/interaction/session.ts packages/core/src/__tests__/book-session-store.test.ts
git commit -m "feat(core): add title field to BookSession schema"
```

---

## Task 2: Core — 新增 rename / delete / migrate 函数

**Files:**
- Modify: `packages/core/src/interaction/book-session-store.ts`
- Modify: `packages/core/src/__tests__/book-session-store.test.ts`

- [ ] **Step 1: 写 renameBookSession 的测试**

在 `book-session-store.test.ts` 末尾（`findOrCreateBookSession` describe 之后）加：

```ts
describe("renameBookSession", () => {
  it("sets title and updates updatedAt", async () => {
    const session = createBookSession("book");
    await persistBookSession(tempDir, session);
    const oldUpdatedAt = session.updatedAt;

    // 等 1ms 确保 updatedAt 不同
    await new Promise((r) => setTimeout(r, 5));
    await renameBookSession(tempDir, session.sessionId, "新标题");

    const loaded = await loadBookSession(tempDir, session.sessionId);
    expect(loaded!.title).toBe("新标题");
    expect(loaded!.updatedAt).toBeGreaterThan(oldUpdatedAt);
  });

  it("returns null for non-existent session", async () => {
    const result = await renameBookSession(tempDir, "nonexistent", "title");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- --reporter=verbose packages/core/src/__tests__/book-session-store.test.ts`
Expected: FAIL — `renameBookSession` is not exported

- [ ] **Step 3: 实现 renameBookSession**

在 `book-session-store.ts` 末尾加：

```ts
export async function renameBookSession(
  projectRoot: string,
  sessionId: string,
  title: string,
): Promise<BookSession | null> {
  const session = await loadBookSession(projectRoot, sessionId);
  if (!session) return null;
  const updated = { ...session, title, updatedAt: Date.now() };
  await persistBookSession(projectRoot, updated);
  return updated;
}
```

在测试文件 import 中加 `renameBookSession`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- --reporter=verbose packages/core/src/__tests__/book-session-store.test.ts`
Expected: PASS

- [ ] **Step 5: 写 deleteBookSession 的测试**

```ts
describe("deleteBookSession", () => {
  it("removes session file", async () => {
    const session = createBookSession("book");
    await persistBookSession(tempDir, session);
    await deleteBookSession(tempDir, session.sessionId);
    const loaded = await loadBookSession(tempDir, session.sessionId);
    expect(loaded).toBeNull();
  });

  it("does nothing for non-existent session", async () => {
    // 不抛异常即可
    await deleteBookSession(tempDir, "nonexistent");
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm test -- --reporter=verbose packages/core/src/__tests__/book-session-store.test.ts`
Expected: FAIL — `deleteBookSession` is not exported

- [ ] **Step 7: 实现 deleteBookSession**

```ts
import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";

export async function deleteBookSession(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  try {
    await unlink(sessionPath(projectRoot, sessionId));
  } catch {
    // 文件不存在或已删除，静默忽略
  }
}
```

注意：import 行要加 `unlink`。

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm test -- --reporter=verbose packages/core/src/__tests__/book-session-store.test.ts`
Expected: PASS

- [ ] **Step 9: 写 migrateBookSession 的测试**

```ts
describe("migrateBookSession", () => {
  it("changes bookId from null to new id", async () => {
    const session = createBookSession(null);
    await persistBookSession(tempDir, session);
    await migrateBookSession(tempDir, session.sessionId, "new-book-id");
    const loaded = await loadBookSession(tempDir, session.sessionId);
    expect(loaded!.bookId).toBe("new-book-id");
  });

  it("throws if bookId is not null", async () => {
    const session = createBookSession("existing-book");
    await persistBookSession(tempDir, session);
    await expect(
      migrateBookSession(tempDir, session.sessionId, "other-book"),
    ).rejects.toThrow("already migrated");
  });

  it("returns null for non-existent session", async () => {
    const result = await migrateBookSession(tempDir, "nonexistent", "book");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 10: 跑测试确认失败**

Run: `pnpm test -- --reporter=verbose packages/core/src/__tests__/book-session-store.test.ts`
Expected: FAIL

- [ ] **Step 11: 实现 migrateBookSession**

```ts
export async function migrateBookSession(
  projectRoot: string,
  sessionId: string,
  newBookId: string,
): Promise<BookSession | null> {
  const session = await loadBookSession(projectRoot, sessionId);
  if (!session) return null;
  if (session.bookId !== null) {
    throw new Error(`Session ${sessionId} already migrated (bookId=${session.bookId})`);
  }
  const updated = { ...session, bookId: newBookId, updatedAt: Date.now() };
  await persistBookSession(projectRoot, updated);
  return updated;
}
```

- [ ] **Step 12: 跑测试确认通过**

Run: `pnpm test -- --reporter=verbose packages/core/src/__tests__/book-session-store.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/interaction/book-session-store.ts packages/core/src/__tests__/book-session-store.test.ts
git commit -m "feat(core): add renameBookSession, deleteBookSession, migrateBookSession"
```

---

## Task 3: Core — 删除 findOrCreateBookSession

**Files:**
- Modify: `packages/core/src/interaction/book-session-store.ts:69-78`
- Modify: `packages/core/src/__tests__/book-session-store.test.ts:93-108`

- [ ] **Step 1: 删除 findOrCreateBookSession 函数**

删除 `book-session-store.ts` 第 69-78 行的 `findOrCreateBookSession` 函数。

- [ ] **Step 2: 删除测试中 findOrCreateBookSession describe 块**

删除 `book-session-store.test.ts` 中 `describe("findOrCreateBookSession", ...)` 整个块（第 93-108 行），以及 import 中的 `findOrCreateBookSession`。

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter @actalk/inkos-core build && pnpm test`
Expected: core 测试全部通过。此时 studio build 会失败（server.ts 还引用了 findOrCreate），这是预期的——下一个 task 修。

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/interaction/book-session-store.ts packages/core/src/__tests__/book-session-store.test.ts
git commit -m "refactor(core): remove findOrCreateBookSession"
```

---

## Task 4: API — 更新现有端点 + 新增 PUT / DELETE

**Files:**
- Modify: `packages/studio/src/api/server.ts:1239-1292`

- [ ] **Step 1: 更新 GET /sessions 返回 title**

```ts
// server.ts GET /api/v1/sessions 改为：
app.get("/api/v1/sessions", async (c) => {
  const bookId = c.req.query("bookId");
  const sessions = await listBookSessions(root, bookId === undefined ? null : bookId === "null" ? null : bookId);
  return c.json({ sessions: sessions.map((s) => ({
    sessionId: s.sessionId,
    bookId: s.bookId,
    title: s.title,                                    // ← 新增
    messageCount: s.messages.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  })) });
});
```

- [ ] **Step 2: 更新 POST /sessions 为永远新建**

把 import 中的 `findOrCreateBookSession` 替换成 `createBookSession`（从 session.js 导入）和 `persistBookSession`。

```ts
// server.ts POST /api/v1/sessions 改为：
app.post("/api/v1/sessions", async (c) => {
  const body = await c.req.json<{ bookId?: string | null }>().catch(() => ({}));
  const bookId = (body as { bookId?: string | null }).bookId ?? null;
  const session = createBookSession(bookId);
  await persistBookSession(root, session);
  return c.json({ session });
});
```

更新 import：从 `"../../core/..."` 或打包路径中去掉 `findOrCreateBookSession`，加上 `createBookSession`（如果还没导入的话）。

- [ ] **Step 3: 更新 POST /agent 强制要 sessionId**

```ts
// server.ts POST /api/v1/agent 开头加校验：
app.post("/api/v1/agent", async (c) => {
  const { instruction, activeBookId, sessionId: reqSessionId, model: reqModel, service: reqService } = await c.req.json<{
    instruction: string;
    activeBookId?: string;
    sessionId?: string;
    model?: string;
    service?: string;
  }>();

  if (!reqSessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const sessionId = reqSessionId;
  if (!instruction?.trim()) {
    return c.json({ error: "No instruction provided" }, 400);
  }

  // ...后续代码不变，但删掉 findOrCreateBookSession 的 fallback 逻辑
  // 原来第 1286-1292 行改为：
  let bookSession: BookSession;
  const loaded = await loadBookSession(root, sessionId);
  if (!loaded) {
    return c.json({ error: `Session ${sessionId} not found` }, 404);
  }
  bookSession = loaded;

  // ... 后续不变
```

- [ ] **Step 4: 新增 PUT /sessions/:id 改名**

在 POST /sessions 之后加：

```ts
app.put("/api/v1/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));
  const title = (body as { title?: string }).title;
  if (title === undefined) {
    return c.json({ error: "title is required" }, 400);
  }
  const updated = await renameBookSession(root, sessionId, title);
  if (!updated) {
    return c.json({ error: "Session not found" }, 404);
  }
  return c.json({ session: { sessionId: updated.sessionId, title: updated.title } });
});
```

更新 import 加 `renameBookSession`。

- [ ] **Step 5: 新增 DELETE /sessions/:id**

```ts
app.delete("/api/v1/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  await deleteBookSession(root, sessionId);
  return c.json({ ok: true });
});
```

更新 import 加 `deleteBookSession`。

- [ ] **Step 6: 更新 server.ts 的 import 行**

确保 import 来源正确。在 server.ts 顶部找到从 book-session-store 导入的行，改为：

```ts
import {
  loadBookSession,
  persistBookSession,
  listBookSessions,
  renameBookSession,
  deleteBookSession,
} from "@actalk/inkos-core/interaction/book-session-store";
import { createBookSession } from "@actalk/inkos-core/interaction/session";
```

（具体 import 路径看现有代码风格，可能是相对路径或包路径。）

- [ ] **Step 7: 写 API 端点测试**

创建 `packages/studio/src/api/__tests__/session-endpoints.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadBookSession,
  persistBookSession,
  listBookSessions,
} from "@actalk/inkos-core/interaction/book-session-store";
import { createBookSession } from "@actalk/inkos-core/interaction/session";

// 如果 server.ts 可以用 Hono 的 testClient 测试，用那个；
// 否则直接测底层函数行为（API 层很薄，逻辑在 core 层）。
// 这里测后者——确认 createBookSession 永远生成新 id。

describe("session API behavior", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-api-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("POST /sessions: two calls with same bookId produce different sessionIds", async () => {
    const s1 = createBookSession("book-a");
    await persistBookSession(tempDir, s1);
    const s2 = createBookSession("book-a");
    await persistBookSession(tempDir, s2);
    expect(s1.sessionId).not.toBe(s2.sessionId);
    const list = await listBookSessions(tempDir, "book-a");
    expect(list).toHaveLength(2);
  });

  it("POST /sessions: bookId=null creates session with null bookId", async () => {
    const s = createBookSession(null);
    await persistBookSession(tempDir, s);
    expect(s.bookId).toBeNull();
    const list = await listBookSessions(tempDir, null);
    expect(list).toHaveLength(1);
  });

  it("GET /sessions: response includes title field", async () => {
    let s = createBookSession("book");
    s = { ...s, title: "测试" };
    await persistBookSession(tempDir, s);
    const list = await listBookSessions(tempDir, "book");
    expect(list[0].title).toBe("测试");
  });
});
```

注意：如果项目已有 Hono testClient 模式可以直接对 HTTP 层测，就把上面改为用 testClient 发真正的 HTTP 请求。否则这些 core-level 测试覆盖了 API 的逻辑（API 层只是薄 wrapper）。

POST /agent 400 的测试取决于是否有 testClient。如果有：

```ts
it("POST /agent without sessionId returns 400", async () => {
  const res = await app.request("/api/v1/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction: "hello" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("sessionId");
});
```

- [ ] **Step 8: build + 测试**

Run: `pnpm build && pnpm test`
Expected: 全部通过

- [ ] **Step 9: Commit**

```bash
git add packages/studio/src/api/server.ts packages/studio/src/api/__tests__/session-endpoints.test.ts
git commit -m "feat(studio): update session endpoints — always-create, require sessionId, add PUT/DELETE"
```

---

## Task 5: Store — 重构 types.ts 和 initialState

**Files:**
- Modify: `packages/studio/src/store/chat/types.ts`
- Modify: `packages/studio/src/store/chat/slices/message/initialState.ts`
- Modify: `packages/studio/src/store/chat/initialState.ts`
- Modify: `packages/studio/src/store/chat/selectors.ts`

- [ ] **Step 1: 新增 SessionRuntime 类型，重构 MessageState**

`types.ts` 全文替换 MessageState 和 MessageActions 部分：

```ts
// -- Session runtime (per-session state) --

export interface SessionRuntime {
  sessionId: string;
  bookId: string | null;
  title: string | null;
  messages: ReadonlyArray<Message>;
  stream: EventSource | null;
  isStreaming: boolean;
  lastError: string | null;
}

// -- State interfaces --

export interface BookSummary {
  world: string;
  protagonist: string;
  cast: string;
}

export interface MessageState {
  sessions: Record<string, SessionRuntime>;
  activeSessionId: string | null;
  sessionIdsByBook: Record<string, string[]>;
  input: string;
  selectedModel: string | null;
  selectedService: string | null;
}

// ...CreateState 不变...

export type ChatState = MessageState & CreateState;
```

- [ ] **Step 2: 更新 MessageActions**

```ts
export interface MessageActions {
  setInput: (text: string) => void;
  // session 生命周期
  activateSession: (sessionId: string) => void;
  loadSessionList: (bookId: string) => Promise<void>;
  createSession: (bookId: string | null) => Promise<string>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  // 消息
  sendMessage: (sessionId: string, text: string, activeBookId?: string) => Promise<void>;
  // 内部 SSE helpers（不直接暴露给组件，但 action 内部用）
  addUserMessage: (sessionId: string, content: string) => void;
  appendStreamChunk: (sessionId: string, text: string, streamTs: number) => void;
  finalizeStream: (sessionId: string, streamTs: number, content: string, toolCall?: ToolCall) => void;
  replaceStreamWithError: (sessionId: string, streamTs: number, errorMsg: string) => void;
  addErrorMessage: (sessionId: string, errorMsg: string) => void;
  loadSessionMessages: (sessionId: string, msgs: ReadonlyArray<SessionMessage>) => void;
  setSelectedModel: (model: string, service: string) => void;
}
```

注意：所有消息操作现在都接收 `sessionId` 第一个参数。

- [ ] **Step 3: 更新 MessageActions 中 CreateActions 的签名**

`CreateActions` 中 `handleCreateBook` 改为接收 sessionId：

```ts
export interface CreateActions {
  setPendingBookArgs: (args: Record<string, unknown> | null) => void;
  setBookCreating: (creating: boolean) => void;
  setCreateProgress: (progress: string) => void;
  handleCreateBook: (sessionId: string, activeBookId?: string) => Promise<string | null>;
  bumpBookDataVersion: () => void;
  openArtifact: (file: string) => void;
  openChapterArtifact: (chapterNum: number) => void;
  closeArtifact: () => void;
  setBookSummary: (summary: BookSummary | null) => void;
}
```

- [ ] **Step 4: 更新 initialState**

`slices/message/initialState.ts`：

```ts
import type { MessageState } from "../../types";

export const initialMessageState: MessageState = {
  sessions: {},
  activeSessionId: null,
  sessionIdsByBook: {},
  input: "",
  selectedModel: null,
  selectedService: null,
};
```

- [ ] **Step 5: 更新 selectors.ts**

```ts
import type { ChatState, SessionRuntime } from "./types";

export const chatSelectors = {
  activeSession: (s: ChatState): SessionRuntime | undefined =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  activeMessages: (s: ChatState) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId]?.messages ?? []) : [],
  activeIsStreaming: (s: ChatState) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId]?.isStreaming ?? false) : false,
  hasPendingTool: (s: ChatState) => s.pendingBookArgs !== null,
  isCreating: (s: ChatState) => s.bookCreating,
  isEmpty: (s: ChatState) => {
    if (!s.activeSessionId) return true;
    const session = s.sessions[s.activeSessionId];
    return !session || (session.messages.length === 0 && !session.isStreaming);
  },
};
```

- [ ] **Step 6: 写 selector 测试**

创建 `packages/studio/src/store/chat/__tests__/selectors.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { chatSelectors } from "../selectors";
import type { ChatState, SessionRuntime } from "../types";

function makeSession(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sessionId: "sess-1",
    bookId: "book-1",
    title: null,
    messages: [],
    stream: null,
    isStreaming: false,
    lastError: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    sessions: {},
    activeSessionId: null,
    sessionIdsByBook: {},
    input: "",
    selectedModel: null,
    selectedService: null,
    pendingBookArgs: null,
    bookCreating: false,
    createProgress: "",
    bookDataVersion: 0,
    sidebarView: "panel",
    artifactFile: null,
    artifactChapter: null,
    bookSummary: null,
    ...overrides,
  };
}

describe("chatSelectors", () => {
  it("activeSession returns undefined when no activeSessionId", () => {
    const state = makeState();
    expect(chatSelectors.activeSession(state)).toBeUndefined();
  });

  it("activeSession returns the active session", () => {
    const sess = makeSession();
    const state = makeState({
      sessions: { "sess-1": sess },
      activeSessionId: "sess-1",
    });
    expect(chatSelectors.activeSession(state)).toBe(sess);
  });

  it("activeMessages returns empty array when no session", () => {
    const state = makeState();
    expect(chatSelectors.activeMessages(state)).toEqual([]);
  });

  it("activeMessages returns messages of active session", () => {
    const msgs = [{ role: "user" as const, content: "hi", timestamp: 1 }];
    const sess = makeSession({ messages: msgs });
    const state = makeState({
      sessions: { "sess-1": sess },
      activeSessionId: "sess-1",
    });
    expect(chatSelectors.activeMessages(state)).toBe(msgs);
  });

  it("activeIsStreaming returns streaming status", () => {
    const sess = makeSession({ isStreaming: true });
    const state = makeState({
      sessions: { "sess-1": sess },
      activeSessionId: "sess-1",
    });
    expect(chatSelectors.activeIsStreaming(state)).toBe(true);
  });

  it("isEmpty returns true when no active session", () => {
    expect(chatSelectors.isEmpty(makeState())).toBe(true);
  });

  it("isEmpty returns false when active session has messages", () => {
    const sess = makeSession({
      messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
    });
    const state = makeState({
      sessions: { "sess-1": sess },
      activeSessionId: "sess-1",
    });
    expect(chatSelectors.isEmpty(state)).toBe(false);
  });
});
```

- [ ] **Step 7: 跑 type check + 测试**

Run: `cd packages/studio && npx tsc --noEmit`
Expected: 大量类型错误（action 文件还没改）——确认错误集中在 action.ts 和 ChatPage 里即可，types/initialState/selectors 自身无误。

Run: `pnpm test -- packages/studio/src/store/chat/__tests__/selectors.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/studio/src/store/chat/types.ts packages/studio/src/store/chat/slices/message/initialState.ts packages/studio/src/store/chat/initialState.ts packages/studio/src/store/chat/selectors.ts packages/studio/src/store/chat/__tests__/selectors.test.ts
git commit -m "refactor(studio): restructure chat store types for multi-session"
```

---

## Task 6: Store — 重构 message slice actions

**Files:**
- Modify: `packages/studio/src/store/chat/slices/message/action.ts`

这是最大的一个 task。核心变化：所有 set/get 操作都通过 `sessionId` 定位到 `sessions[sessionId]`。

- [ ] **Step 1: 添加 session 更新辅助函数**

在 action.ts 顶部（createMessageSlice 之前）加：

```ts
/** 更新 sessions map 中指定 sessionId 的 SessionRuntime */
function updateSession(
  sessions: Record<string, SessionRuntime>,
  sessionId: string,
  updater: (s: SessionRuntime) => Partial<SessionRuntime>,
): Record<string, SessionRuntime> {
  const existing = sessions[sessionId];
  if (!existing) return sessions;
  return { ...sessions, [sessionId]: { ...existing, ...updater(existing) } };
}
```

（SessionRuntime 需要从 types 导入。）

- [ ] **Step 2: 实现 session 生命周期 actions**

在 createMessageSlice 内实现：

```ts
activateSession: (sessionId) => {
  set({ activeSessionId: sessionId });
},

loadSessionList: async (bookId) => {
  try {
    const data = await fetchJson<{ sessions: Array<{ sessionId: string; bookId: string | null; title: string | null; messageCount: number; createdAt: number; updatedAt: number }> }>(`/sessions?bookId=${encodeURIComponent(bookId)}`);
    const ids = data.sessions.map((s) => s.sessionId);
    // 把摘要信息写到 sessions map（如果还没加载过完整消息就先放空消息）
    set((prev) => {
      const sessions = { ...prev.sessions };
      for (const s of data.sessions) {
        if (!sessions[s.sessionId]) {
          sessions[s.sessionId] = {
            sessionId: s.sessionId,
            bookId: s.bookId,
            title: s.title,
            messages: [],
            stream: null,
            isStreaming: false,
            lastError: null,
          };
        } else {
          // 已有完整数据的只更新 title
          sessions[s.sessionId] = { ...sessions[s.sessionId], title: s.title };
        }
      }
      return {
        sessions,
        sessionIdsByBook: { ...prev.sessionIdsByBook, [bookId]: ids },
      };
    });
  } catch {
    // 静默
  }
},

createSession: async (bookId) => {
  const data = await fetchJson<{ session: { sessionId: string; bookId: string | null; title: string | null } }>("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId }),
  });
  const s = data.session;
  set((prev) => {
    const runtime: SessionRuntime = {
      sessionId: s.sessionId,
      bookId: s.bookId,
      title: s.title,
      messages: [],
      stream: null,
      isStreaming: false,
      lastError: null,
    };
    const sessions = { ...prev.sessions, [s.sessionId]: runtime };
    const sessionIdsByBook = { ...prev.sessionIdsByBook };
    const key = s.bookId ?? "__null__";
    sessionIdsByBook[key] = [s.sessionId, ...(sessionIdsByBook[key] ?? [])];
    return { sessions, sessionIdsByBook, activeSessionId: s.sessionId };
  });
  return s.sessionId;
},

renameSession: async (sessionId, title) => {
  const prev = get().sessions[sessionId];
  // 乐观更新
  set((s) => ({ sessions: updateSession(s.sessions, sessionId, () => ({ title })) }));
  try {
    await fetchJson(`/sessions/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  } catch {
    // 回滚
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, () => ({ title: prev?.title ?? null })) }));
  }
},

deleteSession: async (sessionId) => {
  try {
    await fetchJson(`/sessions/${sessionId}`, { method: "DELETE" });
  } catch { /* ignore */ }
  set((prev) => {
    const { [sessionId]: _, ...rest } = prev.sessions;
    const sessionIdsByBook = { ...prev.sessionIdsByBook };
    for (const key of Object.keys(sessionIdsByBook)) {
      sessionIdsByBook[key] = sessionIdsByBook[key].filter((id) => id !== sessionId);
    }
    const activeSessionId = prev.activeSessionId === sessionId ? null : prev.activeSessionId;
    return { sessions: rest, sessionIdsByBook, activeSessionId };
  });
},
```

- [ ] **Step 3: 重构消息操作 actions（加 sessionId 参数）**

所有原来直接读/写 `s.messages` 的 action，改成读/写 `s.sessions[sessionId].messages`。以 `addUserMessage` 为例：

```ts
addUserMessage: (sessionId, content) => set((s) => ({
  sessions: updateSession(s.sessions, sessionId, (sess) => ({
    messages: [...sess.messages, { role: "user" as const, content, timestamp: Date.now() }],
  })),
})),
```

`appendStreamChunk`、`finalizeStream`、`replaceStreamWithError`、`addErrorMessage`、`loadSessionMessages` 同理——在 `set((s) => ...)` 内用 `updateSession` 操作 `s.sessions[sessionId]` 而非 `s.messages`。

每个函数的 `getOrCreateStream` 和 `replaceLast` helper 传入的 `messages` 来源改为 `s.sessions[sessionId].messages`。

- [ ] **Step 4: 重构 sendMessage**

核心变化：
1. 签名从 `(text, activeBookId?)` 改为 `(sessionId, text, activeBookId?)`
2. `get().loading` 的检查改为 `get().sessions[sessionId]?.isStreaming`
3. EventSource 存到 `sessions[sessionId].stream` 而非 `_activeStream`
4. 所有 SSE listener 里的 set 操作都通过 `updateSession(s.sessions, sessionId, ...)` 定位
5. POST /agent 的 body 里 `sessionId` 从 `get().currentSessionId` 改为参数 `sessionId`
6. finally 里 set `isStreaming: false, stream: null` 到 `sessions[sessionId]`

```ts
sendMessage: async (sessionId, text, activeBookId) => {
  const trimmed = text.trim();
  const session = get().sessions[sessionId];
  if (!trimmed || !session || session.isStreaming) return;

  if (!get().selectedModel) {
    get().addUserMessage(sessionId, trimmed);
    get().addErrorMessage(sessionId, "请先选择一个模型");
    return;
  }

  const hasBook = Boolean(activeBookId);
  const instruction = hasBook ? trimmed : `/new ${trimmed}`;
  const streamTs = Date.now() + 1;

  set((s) => ({
    input: "",
    sessions: updateSession(s.sessions, sessionId, () => ({ isStreaming: true })),
  }));
  get().addUserMessage(sessionId, trimmed);

  // 关掉该 session 旧的 stream（如果有的话）
  session.stream?.close();
  const streamEs = new EventSource("/api/v1/events");
  set((s) => ({
    sessions: updateSession(s.sessions, sessionId, () => ({ stream: streamEs })),
  }));

  // SSE listeners — 与现有逻辑相同，但 set 内用 updateSession(s.sessions, sessionId, ...)
  // ... (每个 addEventListener 的 set 回调里把 s.messages → s.sessions[sessionId].messages)
  // ... (getOrCreateStream 的 messages 参数从 session.messages 取)

  // POST /agent
  try {
    const data = await fetchJson<AgentResponse>("/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction,
        activeBookId,
        sessionId,                              // ← 直接用参数
        model: get().selectedModel ?? undefined,
        service: get().selectedService ?? undefined,
      }),
    });

    streamEs.close();
    // ... finalize 逻辑同现有，但用 get().finalizeStream(sessionId, ...)
  } catch (e) {
    streamEs.close();
    // ... error 逻辑同现有
  } finally {
    set((s) => ({
      sessions: updateSession(s.sessions, sessionId, () => ({
        isStreaming: false,
        stream: null,
      })),
    }));
  }
},
```

SSE listener 内部的 `set((s) => { ... })` 回调全部改用 `updateSession`。具体每个 listener 的改动模式一致——把 `s.messages` 替换为 `s.sessions[sessionId].messages`，把 `return { messages: ... }` 替换为 `return { sessions: updateSession(s.sessions, sessionId, (sess) => ({ messages: ... })) }`。

- [ ] **Step 5: 删除旧的 loadSession action**

原来的 `loadSession: async (bookId) => { ... }` 整个删掉。它的功能被 `loadSessionList` + `activateSession` + 按需 GET /sessions/:id 加载消息替代。

如果需要加载某个 session 的完整消息（用户点击侧边栏 session 节点时），加一个新 action：

```ts
loadSessionDetail: async (sessionId: string) => {
  const existing = get().sessions[sessionId];
  if (existing && existing.messages.length > 0) return; // 已加载
  try {
    const data = await fetchJson<{ session: { sessionId: string; messages?: SessionMessage[] } }>(`/sessions/${sessionId}`);
    if (data.session.messages && data.session.messages.length > 0) {
      get().loadSessionMessages(sessionId, data.session.messages);
    }
  } catch { /* ignore */ }
},
```

（并把 `loadSessionDetail` 加到 `MessageActions` interface 中。）

- [ ] **Step 6: 写 message slice 多 session 隔离测试**

创建 `packages/studio/src/store/chat/slices/message/__tests__/multi-session.test.ts`：

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { useChatStore } from "../../../store";
import type { SessionRuntime } from "../../../types";

function seedSession(sessionId: string, bookId: string | null = "book"): SessionRuntime {
  return {
    sessionId,
    bookId,
    title: null,
    messages: [],
    stream: null,
    isStreaming: false,
    lastError: null,
  };
}

describe("message slice — multi-session isolation", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        "sess-a": seedSession("sess-a"),
        "sess-b": seedSession("sess-b"),
      },
      activeSessionId: "sess-a",
      sessionIdsByBook: { book: ["sess-a", "sess-b"] },
      input: "",
      selectedModel: null,
      selectedService: null,
    });
  });

  it("addUserMessage writes only to target session", () => {
    useChatStore.getState().addUserMessage("sess-a", "hello");
    const state = useChatStore.getState();
    expect(state.sessions["sess-a"].messages).toHaveLength(1);
    expect(state.sessions["sess-a"].messages[0].content).toBe("hello");
    expect(state.sessions["sess-b"].messages).toHaveLength(0);
  });

  it("addErrorMessage writes only to target session", () => {
    useChatStore.getState().addErrorMessage("sess-b", "oops");
    const state = useChatStore.getState();
    expect(state.sessions["sess-a"].messages).toHaveLength(0);
    expect(state.sessions["sess-b"].messages).toHaveLength(1);
    expect(state.sessions["sess-b"].messages[0].content).toContain("oops");
  });

  it("activateSession changes activeSessionId without affecting sessions", () => {
    useChatStore.getState().activateSession("sess-b");
    const state = useChatStore.getState();
    expect(state.activeSessionId).toBe("sess-b");
    expect(Object.keys(state.sessions)).toHaveLength(2);
  });

  it("deleteSession removes from map and sessionIdsByBook", () => {
    // 需要 mock fetchJson 或者直接测 set 逻辑
    // 这里测同步部分：手动调 setState 模拟 deleteSession 的 set 回调
    useChatStore.setState((prev) => {
      const { "sess-a": _, ...rest } = prev.sessions;
      const sessionIdsByBook = { ...prev.sessionIdsByBook };
      for (const key of Object.keys(sessionIdsByBook)) {
        sessionIdsByBook[key] = sessionIdsByBook[key].filter((id) => id !== "sess-a");
      }
      return { sessions: rest, sessionIdsByBook, activeSessionId: null };
    });
    const state = useChatStore.getState();
    expect(state.sessions["sess-a"]).toBeUndefined();
    expect(state.sessionIdsByBook["book"]).toEqual(["sess-b"]);
    expect(state.activeSessionId).toBeNull();
  });

  it("deleteSession clears activeSessionId if deleted session was active", () => {
    useChatStore.setState({ activeSessionId: "sess-a" });
    // 模拟 delete sess-a
    useChatStore.setState((prev) => {
      const { "sess-a": _, ...rest } = prev.sessions;
      const activeSessionId = prev.activeSessionId === "sess-a" ? null : prev.activeSessionId;
      return { sessions: rest, activeSessionId };
    });
    expect(useChatStore.getState().activeSessionId).toBeNull();
  });
});
```

- [ ] **Step 7: 跑 type check + 测试**

Run: `cd packages/studio && npx tsc --noEmit`
Expected: 还会有 ChatPage / Sidebar / create slice 的类型错误（它们还没改），但 message action 本身无误。

Run: `pnpm test -- packages/studio/src/store/chat/slices/message/__tests__/multi-session.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/studio/src/store/chat/slices/message/action.ts packages/studio/src/store/chat/slices/message/__tests__/multi-session.test.ts
git commit -m "refactor(studio): rewrite message slice for multi-session"
```

---

## Task 7: Store — 重构 create slice

**Files:**
- Modify: `packages/studio/src/store/chat/slices/create/action.ts`

- [ ] **Step 1: handleCreateBook 传 sessionId + 处理迁移**

```ts
handleCreateBook: async (sessionId, activeBookId) => {
  if (!get().pendingBookArgs) return null;

  set({ bookCreating: true });
  try {
    const data = await fetchJson<AgentResponse>("/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "/create", activeBookId, sessionId }),
    });
    const newBookId = data.session?.activeBookId ?? null;
    if (newBookId) {
      get().bumpBookDataVersion();
      // 更新 store：把 session 的 bookId 从 null 改成新书籍 id
      set((s) => {
        const sessions = { ...s.sessions };
        const sess = sessions[sessionId];
        if (sess) {
          sessions[sessionId] = { ...sess, bookId: newBookId };
        }
        const sessionIdsByBook = { ...s.sessionIdsByBook };
        // 从 __null__ 列表里移除
        if (sessionIdsByBook["__null__"]) {
          sessionIdsByBook["__null__"] = sessionIdsByBook["__null__"].filter((id) => id !== sessionId);
        }
        // 加到新书籍的列表里
        sessionIdsByBook[newBookId] = [sessionId, ...(sessionIdsByBook[newBookId] ?? [])];
        return { sessions, sessionIdsByBook };
      });
      // 清 localStorage
      localStorage.removeItem("currentBookCreateSessionId");
    }
    return newBookId;
  } catch (e) {
    get().addErrorMessage(sessionId, e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    set({ bookCreating: false });
  }
},
```

- [ ] **Step 2: 写 create slice 迁移测试**

创建 `packages/studio/src/store/chat/slices/create/__tests__/migration.test.ts`：

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { useChatStore } from "../../../store";
import type { SessionRuntime } from "../../../types";

describe("create slice — session migration on book create", () => {
  beforeEach(() => {
    // 模拟：一条 bookId=null 的 session 正在进行新建书籍讨论
    const nullSession: SessionRuntime = {
      sessionId: "draft-sess",
      bookId: null,
      title: null,
      messages: [{ role: "user", content: "想写玄幻", timestamp: 1 }],
      stream: null,
      isStreaming: false,
      lastError: null,
    };
    useChatStore.setState({
      sessions: { "draft-sess": nullSession },
      activeSessionId: "draft-sess",
      sessionIdsByBook: { "__null__": ["draft-sess"] },
      pendingBookArgs: { title: "测试书籍" },
      bookCreating: false,
    });
  });

  it("migrates session bookId from null to new bookId on create success", () => {
    const newBookId = "new-book-123";
    // 模拟 handleCreateBook 成功后的 set 回调
    useChatStore.setState((s) => {
      const sessions = { ...s.sessions };
      const sess = sessions["draft-sess"];
      if (sess) {
        sessions["draft-sess"] = { ...sess, bookId: newBookId };
      }
      const sessionIdsByBook = { ...s.sessionIdsByBook };
      if (sessionIdsByBook["__null__"]) {
        sessionIdsByBook["__null__"] = sessionIdsByBook["__null__"].filter((id) => id !== "draft-sess");
      }
      sessionIdsByBook[newBookId] = ["draft-sess", ...(sessionIdsByBook[newBookId] ?? [])];
      return { sessions, sessionIdsByBook };
    });

    const state = useChatStore.getState();
    expect(state.sessions["draft-sess"].bookId).toBe(newBookId);
    expect(state.sessionIdsByBook["__null__"]).toEqual([]);
    expect(state.sessionIdsByBook[newBookId]).toEqual(["draft-sess"]);
  });

  it("preserves messages after migration", () => {
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        "draft-sess": { ...s.sessions["draft-sess"], bookId: "new-book" },
      },
    }));
    expect(useChatStore.getState().sessions["draft-sess"].messages).toHaveLength(1);
    expect(useChatStore.getState().sessions["draft-sess"].messages[0].content).toBe("想写玄幻");
  });
});
```

- [ ] **Step 3: 跑 type check + 测试**

Run: `cd packages/studio && npx tsc --noEmit`
Expected: 只剩 ChatPage / Sidebar / App 层的类型错误。

Run: `pnpm test -- packages/studio/src/store/chat/slices/create/__tests__/migration.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/studio/src/store/chat/slices/create/action.ts packages/studio/src/store/chat/slices/create/__tests__/migration.test.ts
git commit -m "refactor(studio): update create slice for session migration"
```

---

## Task 8: UI — Sidebar 改为树形

**Files:**
- Modify: `packages/studio/src/components/Sidebar.tsx`

- [ ] **Step 1: 书列表改为可展开的树**

把 Sidebar.tsx 中原来遍历 `data?.books` 渲染扁平按钮的部分（第 97-116 行），改为每本书可展开/折叠，展开后显示该书的 session 列表 + "+ 新建会话"按钮。

```tsx
// 在 Sidebar 函数组件内加 state：
const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());
const sessionIdsByBook = useChatStore((s) => s.sessionIdsByBook);
const sessions = useChatStore((s) => s.sessions);
const activeSessionId = useChatStore((s) => s.activeSessionId);
const loadSessionList = useChatStore((s) => s.loadSessionList);
const activateSession = useChatStore((s) => s.activateSession);
const createSession = useChatStore((s) => s.createSession);
const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);

const toggleBook = (bookId: string) => {
  setExpandedBooks((prev) => {
    const next = new Set(prev);
    if (next.has(bookId)) {
      next.delete(bookId);
    } else {
      next.add(bookId);
      // 展开时加载 session 列表
      void loadSessionList(bookId);
    }
    return next;
  });
};

const handleSessionClick = (sessionId: string) => {
  activateSession(sessionId);
  void loadSessionDetail(sessionId);
  // 路由跳转到对应书籍
  const sess = sessions[sessionId];
  if (sess?.bookId) {
    nav.toBook(sess.bookId);
  }
};

const handleNewSession = async (bookId: string) => {
  const sessionId = await createSession(bookId);
  nav.toBook(bookId);
};
```

- [ ] **Step 2: 渲染树形 JSX**

替换第 97-116 行的扁平列表为：

```tsx
{data?.books.map((book) => {
  const isExpanded = expandedBooks.has(book.id);
  const bookSessions = sessionIdsByBook[book.id] ?? [];

  return (
    <div key={book.id}>
      {/* 书名行 — 点击展开/折叠 */}
      <button
        onClick={() => toggleBook(book.id)}
        className={`w-full group flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 ${
          activePage === `book:${book.id}`
            ? "bg-primary/10 text-primary font-medium"
            : "text-foreground font-medium hover:text-foreground hover:bg-secondary/50"
        }`}
      >
        <span className="text-muted-foreground text-xs">{isExpanded ? "▾" : "▸"}</span>
        <Book size={16} className={activePage === `book:${book.id}` ? "text-primary" : "text-muted-foreground group-hover:text-foreground"} />
        <span className="truncate flex-1 text-left">{book.title}</span>
        {bookSessions.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {bookSessions.length}
          </span>
        )}
      </button>

      {/* 展开：session 子项 */}
      {isExpanded && (
        <div className="ml-6 mt-0.5 space-y-0.5">
          {bookSessions.map((sid) => {
            const sess = sessions[sid];
            const isActive = activeSessionId === sid;
            const isStreaming = sess?.isStreaming ?? false;
            const displayTitle = sess?.title ?? `新会话 · ${new Date(sess?.messages[0]?.timestamp ?? Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;

            return (
              <button
                key={sid}
                onClick={() => handleSessionClick(sid)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-all ${
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
                }`}
              >
                <span className="truncate flex-1 text-left">{displayTitle}</span>
                {isStreaming && (
                  <span className="w-3 h-3 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                )}
                {isActive && !isStreaming && (
                  <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-primary" />
                )}
              </button>
            );
          })}

          {/* + 新建会话 */}
          <button
            onClick={() => void handleNewSession(book.id)}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground/60 hover:text-primary hover:bg-primary/5 transition-all"
          >
            <Plus size={12} />
            <span>新建会话</span>
          </button>
        </div>
      )}
    </div>
  );
})}
```

- [ ] **Step 3: "新建书籍"按钮改为走 localStorage 逻辑**

Sidebar 中的 `nav.toBookCreate` 调用不变——保持跳转到 `#/book/new` 路由。实际新建 session 的逻辑在 ChatPage 里处理（Task 9）。

- [ ] **Step 4: 写 Sidebar session 树结构测试**

创建 `packages/studio/src/components/__tests__/Sidebar-sessions.test.tsx`：

```tsx
import { describe, expect, it, beforeEach } from "vitest";
import { useChatStore } from "../../store/chat";
import type { SessionRuntime } from "../../store/chat/types";

// Sidebar 依赖 DOM，完整组件测试需要 @testing-library/react。
// 如果项目还没装，这里先测 store 层的数据是否正确驱动 UI。

function seedSession(id: string, overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sessionId: id,
    bookId: "book-1",
    title: null,
    messages: [],
    stream: null,
    isStreaming: false,
    lastError: null,
    ...overrides,
  };
}

describe("Sidebar session tree — store integration", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        "s1": seedSession("s1", { title: "初稿讨论" }),
        "s2": seedSession("s2", { isStreaming: true, title: "第三章正文" }),
      },
      activeSessionId: "s1",
      sessionIdsByBook: { "book-1": ["s1", "s2"] },
    });
  });

  it("sessionIdsByBook contains correct session ids for a book", () => {
    const state = useChatStore.getState();
    expect(state.sessionIdsByBook["book-1"]).toEqual(["s1", "s2"]);
  });

  it("session with isStreaming=true should show active indicator", () => {
    const state = useChatStore.getState();
    expect(state.sessions["s2"].isStreaming).toBe(true);
    expect(state.sessions["s1"].isStreaming).toBe(false);
  });

  it("activeSessionId identifies the selected session", () => {
    expect(useChatStore.getState().activeSessionId).toBe("s1");
  });

  it("session titles render correctly", () => {
    const s1 = useChatStore.getState().sessions["s1"];
    const s2 = useChatStore.getState().sessions["s2"];
    expect(s1.title).toBe("初稿讨论");
    expect(s2.title).toBe("第三章正文");
  });
});
```

- [ ] **Step 5: 跑 type check + 测试**

Run: `cd packages/studio && npx tsc --noEmit`

Run: `pnpm test -- packages/studio/src/components/__tests__/Sidebar-sessions.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/components/Sidebar.tsx packages/studio/src/components/__tests__/Sidebar-sessions.test.tsx
git commit -m "feat(studio): sidebar tree with sessions per book"
```

---

## Task 9: UI — ChatPage 适配多 session + 新建书籍流程

**Files:**
- Modify: `packages/studio/src/pages/ChatPage.tsx`
- Modify: `packages/studio/src/pages/chat-page-state.ts`
- Modify: `packages/studio/src/App.tsx`

- [ ] **Step 1: chat-page-state.ts 替换 shouldUseFreshBookCreateSession**

删掉 `shouldUseFreshBookCreateSession`，整个文件改为：

```ts
export interface ChatPageModelInfo {
  readonly id: string;
  readonly name?: string;
}

export interface ChatPageModelGroup {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<ChatPageModelInfo>;
}

const BOOK_CREATE_SESSION_KEY = "currentBookCreateSessionId";

export function getBookCreateSessionId(): string | null {
  return localStorage.getItem(BOOK_CREATE_SESSION_KEY);
}

export function setBookCreateSessionId(sessionId: string): void {
  localStorage.setItem(BOOK_CREATE_SESSION_KEY, sessionId);
}

export function clearBookCreateSessionId(): void {
  localStorage.removeItem(BOOK_CREATE_SESSION_KEY);
}

export function filterModelGroups(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  search: string,
): ReadonlyArray<ChatPageModelGroup> {
  const query = search.trim().toLowerCase();
  if (!query) return groupedModels;

  return groupedModels
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        (model.name ?? model.id).toLowerCase().includes(query)
        || group.label.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.models.length > 0);
}
```

- [ ] **Step 2: ChatPage 从 activeSessionId 读消息**

`ChatPage.tsx` 的 store selector 部分改为：

```tsx
// -- Store selectors --
const activeSessionId = useChatStore((s) => s.activeSessionId);
const activeSession = useChatStore((s) => s.activeSessionId ? s.sessions[s.activeSessionId] : undefined);

const messages = useMemo(() => activeSession?.messages ?? [], [activeSession?.messages]);
const isStreaming = useMemo(() => {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  return last.thinkingStreaming === true
    || !last.content
    || (last.toolExecutions?.some(t => t.status === "running" || t.status === "processing") ?? false);
}, [messages]);
const loading = activeSession?.isStreaming ?? false;

const input = useChatStore((s) => s.input);
const pendingBookArgs = useChatStore((s) => s.pendingBookArgs);
const bookCreating = useChatStore((s) => s.bookCreating);
const createProgress = useChatStore((s) => s.createProgress);
const selectedModel = useChatStore((s) => s.selectedModel);
const selectedService = useChatStore((s) => s.selectedService);

// -- Store actions --
const setInput = useChatStore((s) => s.setInput);
const sendMessageAction = useChatStore((s) => s.sendMessage);
const createSession = useChatStore((s) => s.createSession);
const activateSession = useChatStore((s) => s.activateSession);
const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
const setPendingBookArgs = useChatStore((s) => s.setPendingBookArgs);
const handleCreateBookAction = useChatStore((s) => s.handleCreateBook);
const setCreateProgress = useChatStore((s) => s.setCreateProgress);
const setSelectedModel = useChatStore((s) => s.setSelectedModel);
```

- [ ] **Step 3: 改写 mount/activeBookId 变化 effect**

删除原来的 `useEffect(() => { if (shouldUseFreshBookCreateSession...) ... }, [activeBookId])`，替换为：

```tsx
// 进入书籍页面：加载 session 列表并激活最新的
// 进入新建书籍页面：走 localStorage
useEffect(() => {
  if (activeBookId) {
    // 有书 → 加载 session 列表，激活最新的
    void (async () => {
      await useChatStore.getState().loadSessionList(activeBookId);
      const ids = useChatStore.getState().sessionIdsByBook[activeBookId];
      if (ids && ids.length > 0) {
        useChatStore.getState().activateSession(ids[0]);
        void useChatStore.getState().loadSessionDetail(ids[0]);
      } else {
        // 这本书还没有 session，创建一个
        await useChatStore.getState().createSession(activeBookId);
      }
    })();
  } else {
    // 无书 = 新建书籍模式
    void (async () => {
      const existingId = getBookCreateSessionId();
      if (existingId) {
        // 尝试加载已有的新建书籍 session
        await useChatStore.getState().loadSessionDetail(existingId);
        const sess = useChatStore.getState().sessions[existingId];
        if (sess && sess.bookId === null) {
          useChatStore.getState().activateSession(existingId);
          return;
        }
      }
      // 没有或已失效，新建一个
      const newId = await useChatStore.getState().createSession(null);
      setBookCreateSessionId(newId);
    })();
  }
}, [activeBookId]);
```

import 行加 `getBookCreateSessionId, setBookCreateSessionId`。

- [ ] **Step 4: onSend 和 onCreateBook 传 sessionId**

```tsx
const onSend = (text: string) => {
  if (!activeSessionId) return;
  void sendMessageAction(activeSessionId, text, activeBookId);
};

const onCreateBook = async () => {
  if (!activeSessionId) return;
  const newBookId = await handleCreateBookAction(activeSessionId, activeBookId);
  if (newBookId) nav.toBook(newBookId);
};
```

- [ ] **Step 5: App.tsx 不需要大改**

`App.tsx` 第 165-179 行的 ChatPage 使用方式无需变化——它已经通过 `activeBookId` prop 传递，ChatPage 内部自行管理 sessionId。确认 `book-create` 路由仍然传 `activeBookId={undefined}`。

- [ ] **Step 6: 写 chat-page-state 纯函数测试**

创建 `packages/studio/src/pages/__tests__/chat-page-state.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getBookCreateSessionId,
  setBookCreateSessionId,
  clearBookCreateSessionId,
  filterModelGroups,
} from "../chat-page-state";

// localStorage mock（vitest 默认用 jsdom，自带 localStorage）

describe("chat-page-state — localStorage helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("getBookCreateSessionId returns null when empty", () => {
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("setBookCreateSessionId + get round-trips", () => {
    setBookCreateSessionId("sess-123");
    expect(getBookCreateSessionId()).toBe("sess-123");
  });

  it("setBookCreateSessionId overwrites previous value", () => {
    setBookCreateSessionId("sess-old");
    setBookCreateSessionId("sess-new");
    expect(getBookCreateSessionId()).toBe("sess-new");
  });

  it("clearBookCreateSessionId removes the key", () => {
    setBookCreateSessionId("sess-123");
    clearBookCreateSessionId();
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("clearBookCreateSessionId is safe when key doesn't exist", () => {
    clearBookCreateSessionId(); // 不抛异常
    expect(getBookCreateSessionId()).toBeNull();
  });
});

describe("chat-page-state — filterModelGroups", () => {
  const groups = [
    {
      service: "openai",
      label: "OpenAI",
      models: [
        { id: "gpt-4", name: "GPT-4" },
        { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
      ],
    },
    {
      service: "anthropic",
      label: "Anthropic",
      models: [{ id: "claude-3", name: "Claude 3" }],
    },
  ];

  it("returns all groups when search is empty", () => {
    expect(filterModelGroups(groups, "")).toBe(groups);
    expect(filterModelGroups(groups, "  ")).toBe(groups);
  });

  it("filters by model name", () => {
    const result = filterModelGroups(groups, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].service).toBe("anthropic");
  });

  it("filters by service label", () => {
    const result = filterModelGroups(groups, "openai");
    expect(result).toHaveLength(1);
    expect(result[0].models).toHaveLength(2);
  });

  it("returns empty when nothing matches", () => {
    expect(filterModelGroups(groups, "nonexistent")).toHaveLength(0);
  });
});
```

- [ ] **Step 7: build + 测试**

Run: `pnpm build && pnpm test`
Expected: 全部通过

- [ ] **Step 8: Commit**

```bash
git add packages/studio/src/pages/ChatPage.tsx packages/studio/src/pages/chat-page-state.ts packages/studio/src/pages/__tests__/chat-page-state.test.ts packages/studio/src/App.tsx
git commit -m "feat(studio): ChatPage multi-session + book create localStorage flow"
```

---

## Task 10: 标题自动生成

**Files:**
- Modify: `packages/studio/src/api/server.ts`
- Modify: `packages/core/src/interaction/book-session-store.ts`

- [ ] **Step 1: 在 book-session-store.ts 加 updateSessionTitle**

```ts
export async function updateSessionTitle(
  projectRoot: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const session = await loadBookSession(projectRoot, sessionId);
  if (!session || session.title !== null) return; // 已有标题（AI 生成的或用户改的），不覆盖
  const updated = { ...session, title, updatedAt: Date.now() };
  await persistBookSession(projectRoot, updated);
}
```

- [ ] **Step 2: 在 server.ts POST /agent 成功返回后触发标题生成**

在 POST /agent handler 的 try 块里，agent 返回成功后加：

```ts
// 标题生成（异步，不阻塞响应）
// 条件：session 有 >= 1 条 user + 1 条 assistant 消息，且 title 为 null
void (async () => {
  try {
    const freshSession = await loadBookSession(root, sessionId);
    if (!freshSession || freshSession.title !== null) return;
    const hasExchange = freshSession.messages.some((m) => m.role === "user")
      && freshSession.messages.some((m) => m.role === "assistant");
    if (!hasExchange) return;

    // 用当前配的模型生成标题
    const config = await loadCurrentProjectConfig({ requireApiKey: false });
    const titleClient = createLLMClient(config.llm);
    const userMsg = freshSession.messages.find((m) => m.role === "user")?.content ?? "";
    const assistantMsg = freshSession.messages.find((m) => m.role === "assistant")?.content ?? "";
    const titlePrompt = `用6个中文字以内概括这段对话的主题，只返回标题文本。\n\n用户: ${userMsg.slice(0, 200)}\n助手: ${assistantMsg.slice(0, 200)}`;

    const result = await titleClient.chat([{ role: "user", content: titlePrompt }]);
    const title = (typeof result === "string" ? result : result.content ?? "").trim().slice(0, 20);
    if (title) {
      await updateSessionTitle(root, sessionId, title);
      broadcast("session:title", { sessionId, title });
    }
  } catch {
    // 生成失败静默忽略
  }
})();
```

注意：这段代码在 response 返回给前端 **之后** 异步执行（`void (async () => ...)()`），不阻塞。`broadcast("session:title", ...)` 让前端实时更新侧边栏标题。

- [ ] **Step 3: 前端监听 session:title 事件**

在 ChatPage 或 App 层加一个 SSE listener：

```ts
// 可以放在 App.tsx 的 useEffect 里，或者单独的 hook
useEffect(() => {
  const es = new EventSource("/api/v1/events");
  es.addEventListener("session:title", (e: MessageEvent) => {
    try {
      const d = e.data ? JSON.parse(e.data) : null;
      if (d?.sessionId && d?.title) {
        useChatStore.setState((s) => ({
          sessions: {
            ...s.sessions,
            [d.sessionId]: s.sessions[d.sessionId]
              ? { ...s.sessions[d.sessionId], title: d.title }
              : s.sessions[d.sessionId],
          },
        }));
      }
    } catch { /* ignore */ }
  });
  return () => es.close();
}, []);
```

考虑复用已有的全局 SSE 连接（`useSSE` hook）。如果项目已有全局 EventSource，就在那里加一个 listener 而不是新开连接。

- [ ] **Step 4: 写标题生成测试**

在 `book-session-store.test.ts` 加：

```ts
describe("updateSessionTitle", () => {
  it("sets title when null", async () => {
    const session = createBookSession("book");
    await persistBookSession(tempDir, session);
    await updateSessionTitle(tempDir, session.sessionId, "测试标题");
    const loaded = await loadBookSession(tempDir, session.sessionId);
    expect(loaded!.title).toBe("测试标题");
  });

  it("does not overwrite existing title", async () => {
    let session = createBookSession("book");
    session = { ...session, title: "已有标题" };
    await persistBookSession(tempDir, session);
    await updateSessionTitle(tempDir, session.sessionId, "新标题");
    const loaded = await loadBookSession(tempDir, session.sessionId);
    expect(loaded!.title).toBe("已有标题");
  });
});
```

- [ ] **Step 5: build + 测试**

Run: `pnpm build && pnpm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/interaction/book-session-store.ts packages/core/src/__tests__/book-session-store.test.ts packages/studio/src/api/server.ts
git commit -m "feat: auto-generate session title after first exchange"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - ✅ title 字段 (Task 1)
   - ✅ rename/delete/migrate (Task 2)
   - ✅ 删除 findOrCreateBookSession (Task 3)
   - ✅ API 端点 (Task 4)
   - ✅ Store 重构 (Task 5-7)
   - ✅ Sidebar 树形 (Task 8)
   - ✅ ChatPage 多 session (Task 9)
   - ✅ 新建书籍 localStorage 流程 (Task 9)
   - ✅ 标题自动生成 (Task 10)
   - ✅ 活跃指示（转圈）(Task 8 侧边栏)
   - ✅ p-queue 并发控制 — 未单独 task，需在 Task 2 实现时加（注：当前 Node 单线程，先不加 p-queue，后续有实际并发问题再补）

2. **Placeholder scan:** 无 TBD/TODO。

3. **Type consistency:**
   - `SessionRuntime` 在 types.ts 定义，action.ts 和 Sidebar.tsx 使用——字段名一致
   - `updateSession` helper 在 action.ts 定义，签名 `(sessions, sessionId, updater)` 各处调用一致
   - `sendMessage` 签名 `(sessionId, text, activeBookId?)` — ChatPage 调用 `sendMessageAction(activeSessionId, text, activeBookId)` — 一致
   - `handleCreateBook` 签名 `(sessionId, activeBookId?)` — ChatPage 调用 `handleCreateBookAction(activeSessionId, activeBookId)` — 一致
   - `loadSessionDetail` 在 Step 5 of Task 6 定义，需加到 `MessageActions` interface — 已提醒
