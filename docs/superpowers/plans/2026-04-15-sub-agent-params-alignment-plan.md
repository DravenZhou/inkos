# sub_agent 参数对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 sub_agent 的 5 个子智能体参数与 pipeline runner 方法完全对齐，消除硬编码和参数丢弃。

**Architecture:** 在现有 `SubAgentParams` schema 上扁平扩展新字段（TypeBox description 标注适用 agent），修改每个 agent case 的调用代码，更新系统提示词。

**Tech Stack:** TypeBox (schema), pi-agent-core (tool interface), vitest (tests)

---

### Task 1: 扩展 SubAgentParams schema

**Files:**
- Modify: `packages/core/src/agent/agent-tools.ts:32-43`
- Test: `packages/core/src/__tests__/agent-tools-params.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/agent-tools-params.test.ts
import { describe, it, expect } from "vitest";
import { Type } from "@mariozechner/pi-ai";

// We test the schema shape by importing and inspecting the compiled schema
// Since SubAgentParams is not exported, we test via the tool's parameters property
import { createSubAgentTool } from "../agent/agent-tools.js";

describe("SubAgentParams schema", () => {
  // Use a minimal mock pipeline
  const mockPipeline = {} as any;
  const tool = createSubAgentTool(mockPipeline, null);
  const schema = tool.parameters;
  const props = (schema as any).properties;

  it("has architect params: title, genre, platform, language, targetChapters", () => {
    expect(props.title).toBeDefined();
    expect(props.genre).toBeDefined();
    expect(props.platform).toBeDefined();
    expect(props.language).toBeDefined();
    expect(props.targetChapters).toBeDefined();
  });

  it("has writer/architect param: chapterWordCount", () => {
    expect(props.chapterWordCount).toBeDefined();
  });

  it("has reviser param: mode", () => {
    expect(props.mode).toBeDefined();
  });

  it("has exporter params: format, approvedOnly", () => {
    expect(props.format).toBeDefined();
    expect(props.approvedOnly).toBeDefined();
  });

  it("has existing params: agent, instruction, bookId, chapterNumber", () => {
    expect(props.agent).toBeDefined();
    expect(props.instruction).toBeDefined();
    expect(props.bookId).toBeDefined();
    expect(props.chapterNumber).toBeDefined();
  });

  it("all new params have description with agent scope", () => {
    expect(props.title.description).toMatch(/architect/i);
    expect(props.genre.description).toMatch(/architect/i);
    expect(props.mode.description).toMatch(/reviser/i);
    expect(props.format.description).toMatch(/exporter/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @actalk/inkos-core test -- --run agent-tools-params`
Expected: FAIL — `props.title` is undefined (field doesn't exist yet)

- [ ] **Step 3: Add new fields to SubAgentParams**

In `packages/core/src/agent/agent-tools.ts`, replace the `SubAgentParams` definition:

```ts
const SubAgentParams = Type.Object({
  agent: Type.Union([
    Type.Literal("architect"),
    Type.Literal("writer"),
    Type.Literal("auditor"),
    Type.Literal("reviser"),
    Type.Literal("exporter"),
  ]),
  instruction: Type.String({ description: "Natural language instruction for the sub-agent" }),
  bookId: Type.Optional(Type.String({ description: "Book ID — required for all agents except architect" })),
  chapterNumber: Type.Optional(Type.Number({ description: "auditor/reviser: target chapter number. Omit to use the latest chapter." })),
  // -- architect params --
  title: Type.Optional(Type.String({ description: "architect only: book title" })),
  genre: Type.Optional(Type.String({ description: "architect only: genre (xuanhuan, urban, mystery, romance, scifi, fantasy, wuxia, general, etc.)" })),
  platform: Type.Optional(Type.Union([
    Type.Literal("tomato"),
    Type.Literal("qidian"),
    Type.Literal("feilu"),
    Type.Literal("other"),
  ], { description: "architect only: target platform. Default: other" })),
  language: Type.Optional(Type.Union([
    Type.Literal("zh"),
    Type.Literal("en"),
  ], { description: "architect only: writing language. Default: zh" })),
  targetChapters: Type.Optional(Type.Number({ description: "architect only: total chapter count. Default: 200" })),
  chapterWordCount: Type.Optional(Type.Number({ description: "architect/writer: words per chapter. Default: 3000" })),
  // -- reviser params --
  mode: Type.Optional(Type.Union([
    Type.Literal("spot-fix"),
    Type.Literal("polish"),
    Type.Literal("rewrite"),
    Type.Literal("rework"),
    Type.Literal("anti-detect"),
  ], { description: "reviser only: revision mode. Default: spot-fix" })),
  // -- exporter params --
  format: Type.Optional(Type.Union([
    Type.Literal("txt"),
    Type.Literal("md"),
    Type.Literal("epub"),
  ], { description: "exporter only: export format. Default: txt" })),
  approvedOnly: Type.Optional(Type.Boolean({ description: "exporter only: export only approved chapters. Default: false" })),
});
```

Update the destructuring in `execute`:

```ts
const { agent, instruction, bookId, chapterNumber, title, genre, platform, language, targetChapters, chapterWordCount, mode, format, approvedOnly } = params;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @actalk/inkos-core test -- --run agent-tools-params`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts packages/core/src/__tests__/agent-tools-params.test.ts
git commit -m "feat(core): extend SubAgentParams with architect/writer/reviser/exporter fields"
```

---

### Task 2: Fix architect — 构建完整 BookConfig

**Files:**
- Modify: `packages/core/src/agent/agent-tools.ts:67-81` (architect case)
- Test: `packages/core/src/__tests__/agent-tools-params.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `agent-tools-params.test.ts`:

```ts
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi, beforeEach, afterEach } from "vitest";

describe("architect agent — BookConfig construction", () => {
  let initBookMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    initBookMock = vi.fn(async () => {});
    const mockPipeline = { initBook: initBookMock } as any;
    tool = createSubAgentTool(mockPipeline, null);
  });

  it("passes complete BookConfig with schema params instead of hardcoded values", async () => {
    await tool.execute("tc1", {
      agent: "architect",
      instruction: "Create a xuanhuan novel",
      title: "天道独行",
      genre: "xuanhuan",
      platform: "tomato",
      language: "zh",
      targetChapters: 100,
      chapterWordCount: 4000,
    });

    expect(initBookMock).toHaveBeenCalledOnce();
    const [bookConfig, options] = initBookMock.mock.calls[0];
    expect(bookConfig.title).toBe("天道独行");
    expect(bookConfig.genre).toBe("xuanhuan");
    expect(bookConfig.platform).toBe("tomato");
    expect(bookConfig.language).toBe("zh");
    expect(bookConfig.targetChapters).toBe(100);
    expect(bookConfig.chapterWordCount).toBe(4000);
    expect(bookConfig.status).toBe("outlining");
    expect(bookConfig.createdAt).toBeDefined();
    expect(bookConfig.updatedAt).toBeDefined();
    expect(options.externalContext).toBe("Create a xuanhuan novel");
  });

  it("uses defaults when optional architect params are omitted", async () => {
    await tool.execute("tc2", {
      agent: "architect",
      instruction: "Create a book",
    });

    const [bookConfig] = initBookMock.mock.calls[0];
    expect(bookConfig.genre).toBe("general");
    expect(bookConfig.platform).toBe("other");
    expect(bookConfig.language).toBe("zh");
    expect(bookConfig.targetChapters).toBe(200);
    expect(bookConfig.chapterWordCount).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @actalk/inkos-core test -- --run agent-tools-params`
Expected: FAIL — `bookConfig.title` is `""`, `bookConfig.genre` is `"general"` (hardcoded)

- [ ] **Step 3: Rewrite architect case**

Replace the architect case in `agent-tools.ts`:

```ts
case "architect": {
  if (activeBookId) {
    return textResult("当前已有书籍，不需要建书。如果你想创建新书，请先回到首页。");
  }
  const id = bookId || `book-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  progress(`Starting architect for book "${id}"...`);
  await pipeline.initBook(
    {
      id,
      title: title ?? "",
      genre: genre ?? "general",
      platform: (platform ?? "other") as any,
      language: (language ?? "zh") as any,
      status: "outlining" as any,
      targetChapters: targetChapters ?? 200,
      chapterWordCount: chapterWordCount ?? 3000,
      createdAt: now,
      updatedAt: now,
    },
    { externalContext: instruction },
  );
  progress(`Architect finished — book "${id}" foundation created.`);
  return textResult(`Book "${id}" initialised successfully. Foundation files are ready.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @actalk/inkos-core test -- --run agent-tools-params`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts packages/core/src/__tests__/agent-tools-params.test.ts
git commit -m "fix(core): architect builds complete BookConfig from schema params"
```

---

### Task 3: Fix writer — 透传 wordCount 和 instruction

**Files:**
- Modify: `packages/core/src/agent/agent-tools.ts:83-91` (writer case)
- Test: `packages/core/src/__tests__/agent-tools-params.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe("writer agent — wordCount and instruction passthrough", () => {
  let writeNextChapterMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    writeNextChapterMock = vi.fn(async () => ({ wordCount: 3000 }));
    const mockPipeline = { writeNextChapter: writeNextChapterMock } as any;
    tool = createSubAgentTool(mockPipeline, "existing-book");
  });

  it("passes chapterWordCount as wordCount to writeNextChapter", async () => {
    await tool.execute("tc1", {
      agent: "writer",
      instruction: "Write an exciting chapter",
      bookId: "my-book",
      chapterWordCount: 5000,
    });

    expect(writeNextChapterMock).toHaveBeenCalledWith("my-book", 5000);
  });

  it("passes undefined wordCount when chapterWordCount is omitted", async () => {
    await tool.execute("tc2", {
      agent: "writer",
      instruction: "Write next chapter",
      bookId: "my-book",
    });

    expect(writeNextChapterMock).toHaveBeenCalledWith("my-book", undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `writeNextChapter` called with only 1 argument

- [ ] **Step 3: Update writer case**

```ts
case "writer": {
  if (!bookId) return textResult("Error: bookId is required for the writer agent.");
  progress(`Writing next chapter for "${bookId}"...`);
  const result = await pipeline.writeNextChapter(bookId, chapterWordCount);
  progress(`Writer finished chapter for "${bookId}".`);
  return textResult(
    `Chapter written for "${bookId}". ` +
    `Word count: ${(result as any).wordCount ?? "unknown"}.`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @actalk/inkos-core test -- --run agent-tools-params`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts packages/core/src/__tests__/agent-tools-params.test.ts
git commit -m "fix(core): writer passes chapterWordCount to writeNextChapter"
```

---

### Task 4: Fix auditor — 丰富返回值

**Files:**
- Modify: `packages/core/src/agent/agent-tools.ts:94-103` (auditor case)
- Test: `packages/core/src/__tests__/agent-tools-params.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe("auditor agent — rich return value", () => {
  let auditDraftMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    auditDraftMock = vi.fn(async () => ({
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "warning", description: "Pacing too fast in mid section" },
        { severity: "critical", description: "Character name inconsistency" },
      ],
    }));
    const mockPipeline = { auditDraft: auditDraftMock } as any;
    tool = createSubAgentTool(mockPipeline, "existing-book");
  });

  it("returns issue details with severity, not just count", async () => {
    const result = await tool.execute("tc1", {
      agent: "auditor",
      instruction: "Audit chapter 3",
      bookId: "my-book",
      chapterNumber: 3,
    });

    const text = result.content[0].text;
    expect(text).toContain("FAILED");
    expect(text).toContain("2 issue(s)");
    expect(text).toContain("[warning]");
    expect(text).toContain("[critical]");
    expect(text).toContain("Pacing too fast");
    expect(text).toContain("Character name inconsistency");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current response only has `"2 issue(s) found"`, no `[warning]` or `[critical]`

- [ ] **Step 3: Update auditor case**

```ts
case "auditor": {
  if (!bookId) return textResult("Error: bookId is required for the auditor agent.");
  progress(`Auditing chapter ${chapterNumber ?? "latest"} for "${bookId}"...`);
  const audit = await pipeline.auditDraft(bookId, chapterNumber);
  progress(`Audit complete for "${bookId}".`);
  const issueLines = (audit.issues ?? [])
    .map((i: any) => `[${i.severity}] ${i.description}`)
    .join("\n");
  return textResult(
    `Audit chapter ${audit.chapterNumber}: ${audit.passed ? "PASSED" : "FAILED"}, ${(audit.issues ?? []).length} issue(s).` +
    (issueLines ? `\n${issueLines}` : ""),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts packages/core/src/__tests__/agent-tools-params.test.ts
git commit -m "fix(core): auditor returns full issue details with severity"
```

---

### Task 5: Fix reviser — mode 字段化 + instruction 透传

**Files:**
- Modify: `packages/core/src/agent/agent-tools.ts:106-119` (reviser case)
- Test: `packages/core/src/__tests__/agent-tools-params.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe("reviser agent — mode field and instruction passthrough", () => {
  let reviseDraftMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    reviseDraftMock = vi.fn(async () => ({}));
    const mockPipeline = { reviseDraft: reviseDraftMock } as any;
    tool = createSubAgentTool(mockPipeline, "existing-book");
  });

  it("uses mode param directly instead of regex extraction", async () => {
    await tool.execute("tc1", {
      agent: "reviser",
      instruction: "Fix this chapter",
      bookId: "my-book",
      chapterNumber: 5,
      mode: "anti-detect",
    });

    expect(reviseDraftMock).toHaveBeenCalledWith("my-book", 5, "anti-detect");
  });

  it("defaults to spot-fix when mode is omitted", async () => {
    await tool.execute("tc2", {
      agent: "reviser",
      instruction: "Fix chapter",
      bookId: "my-book",
    });

    expect(reviseDraftMock).toHaveBeenCalledWith("my-book", undefined, "spot-fix");
  });

  it("anti-detect mode is reachable (was unreachable with regex)", async () => {
    await tool.execute("tc3", {
      agent: "reviser",
      instruction: "Process chapter",
      bookId: "my-book",
      mode: "anti-detect",
    });

    expect(reviseDraftMock.mock.calls[0][2]).toBe("anti-detect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `anti-detect` falls through to `spot-fix` via regex

- [ ] **Step 3: Update reviser case**

```ts
case "reviser": {
  if (!bookId) return textResult("Error: bookId is required for the reviser agent.");
  const resolvedMode: ReviseMode = (mode as ReviseMode) ?? "spot-fix";
  progress(`Revising "${bookId}" chapter ${chapterNumber ?? "latest"} in ${resolvedMode} mode...`);
  await pipeline.reviseDraft(bookId, chapterNumber, resolvedMode);
  progress(`Revision complete for "${bookId}".`);
  return textResult(`Revision (${resolvedMode}) complete for "${bookId}" chapter ${chapterNumber ?? "latest"}.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts packages/core/src/__tests__/agent-tools-params.test.ts
git commit -m "fix(core): reviser uses mode param directly, anti-detect now reachable"
```

---

### Task 6: Implement exporter — 调通导出

**Files:**
- Modify: `packages/core/src/agent/agent-tools.ts:122-124` (exporter case)
- Test: `packages/core/src/__tests__/agent-tools-params.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe("exporter agent — export implementation", () => {
  let loadChapterIndexMock: ReturnType<typeof vi.fn>;
  let loadBookConfigMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "inkos-export-"));
    const bookDir = join(tmpRoot, "books", "my-book");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(join(chaptersDir, "0001_First.md"), "# 第一章\n\n内容内容内容");
    await writeFile(join(chaptersDir, "0002_Second.md"), "# 第二章\n\n更多内容");

    loadChapterIndexMock = vi.fn(async () => [
      { number: 1, title: "First", status: "approved", wordCount: 100 },
      { number: 2, title: "Second", status: "drafted", wordCount: 200 },
    ]);
    loadBookConfigMock = vi.fn(async () => ({ title: "Test Book" }));
    const mockPipeline = {} as any;
    const mockState = {
      bookDir: (id: string) => join(tmpRoot, "books", id),
      loadChapterIndex: loadChapterIndexMock,
      loadBookConfig: loadBookConfigMock,
    };
    // exporter needs access to state — passed via projectRoot
    tool = createSubAgentTool(mockPipeline, "my-book", tmpRoot);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("exports all chapters in txt format by default", async () => {
    const result = await tool.execute("tc1", {
      agent: "exporter",
      instruction: "Export the book",
      bookId: "my-book",
    });

    const text = result.content[0].text;
    expect(text).not.toContain("not yet implemented");
    expect(text).toContain("export");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — returns "Export is not yet implemented"

- [ ] **Step 3: Implement exporter case**

Replace the exporter case. Since `exportBookToPath` in `project-tools.ts` is not directly importable (it's a local function), inline the core logic:

```ts
case "exporter": {
  if (!bookId) return textResult("Error: bookId is required for the exporter agent.");
  const exportFormat = (format ?? "txt") as "txt" | "md" | "epub";
  const onlyApproved = approvedOnly ?? false;
  progress(`Exporting "${bookId}" as ${exportFormat}...`);

  const booksRoot = join(projectRoot, "books");
  const bookDir = join(booksRoot, bookId);
  const chaptersDir = join(bookDir, "chapters");

  // Load index and book config
  const indexRaw = await readFile(join(chaptersDir, "index.json"), "utf-8");
  const index: Array<{ number: number; title: string; status: string; wordCount: number }> = JSON.parse(indexRaw);
  const bookRaw = await readFile(join(bookDir, "book.json"), "utf-8");
  const bookConfig = JSON.parse(bookRaw);

  const chapters = onlyApproved ? index.filter((ch) => ch.status === "approved") : index;
  if (chapters.length === 0) {
    return textResult(`No chapters to export${onlyApproved ? " (approved only filter)" : ""}.`);
  }

  // Build chapter file lookup
  const files = await readdir(chaptersDir);
  const chapterFiles = new Map<number, string>();
  for (const f of files.filter((f) => /^\d{4}_.*\.md$/.test(f)).sort()) {
    chapterFiles.set(parseInt(f.slice(0, 4), 10), f);
  }

  const parts: string[] = [];
  parts.push(exportFormat === "md" ? `# ${bookConfig.title ?? bookId}\n\n---\n` : `${bookConfig.title ?? bookId}\n\n`);
  for (const ch of chapters) {
    const file = chapterFiles.get(ch.number);
    if (!file) continue;
    parts.push(await readFile(join(chaptersDir, file), "utf-8"));
    parts.push("\n\n");
  }

  const outputPath = join(booksRoot, "..", `${bookId}_export.${exportFormat}`);
  await writeFile(outputPath, parts.join(exportFormat === "md" ? "\n---\n\n" : "\n"), "utf-8");

  const totalWords = chapters.reduce((s, ch) => s + ch.wordCount, 0);
  progress(`Export complete for "${bookId}".`);
  return textResult(
    `Exported "${bookId}": ${chapters.length} chapters, ${totalWords} words → ${outputPath}`,
  );
}
```

Note: `projectRoot` is already available in the closure from `createSubAgentTool`'s third parameter (added in a prior commit).

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-tools.ts packages/core/src/__tests__/agent-tools-params.test.ts
git commit -m "feat(core): implement exporter agent with format and approvedOnly support"
```

---

### Task 7: 更新系统提示词

**Files:**
- Modify: `packages/core/src/agent/agent-system-prompt.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/agent-system-prompt.test.ts`:

```ts
it("book-mode prompt documents all sub_agent params", () => {
  const prompt = buildAgentSystemPrompt("test-book", "zh");
  // architect params
  expect(prompt).toContain("title");
  expect(prompt).toContain("genre");
  expect(prompt).toContain("platform");
  expect(prompt).toContain("chapterWordCount");
  // reviser params
  expect(prompt).toContain("mode");
  expect(prompt).toContain("anti-detect");
  // exporter params
  expect(prompt).toContain("format");
  expect(prompt).toContain("approvedOnly");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @actalk/inkos-core test -- --run agent-system-prompt`
Expected: FAIL — prompt doesn't mention `format`, `approvedOnly`, `anti-detect` etc.

- [ ] **Step 3: Update both zh and en prompts**

Update the Chinese book-mode prompt's tool section:

```ts
- **sub_agent** — 委托子智能体执行重操作：
  - agent="architect" 从零建书（参数：title, genre, platform, language, targetChapters, chapterWordCount）
  - agent="writer" 写下一章（参数：chapterWordCount 覆盖字数）
  - agent="auditor" 审计章节质量（参数：chapterNumber 指定章节）
  - agent="reviser" 修订章节（参数：chapterNumber, mode: spot-fix/polish/rewrite/rework/anti-detect）
  - agent="exporter" 导出书籍（参数：format: txt/md/epub, approvedOnly: true/false）
```

Update the English book-mode prompt similarly.

Also update the Chinese book-create prompt to mention architect params:

```ts
2. **确认建书**（调用阶段）— 当信息足够时，调用 sub_agent 工具委托 architect 子智能体建书：
   - instruction 中包含收集到的所有信息
   - 同时传入结构化参数：title（书名）、genre（题材）、platform（平台）、language（语言）、targetChapters（章数）、chapterWordCount（每章字数）
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-system-prompt.ts packages/core/src/__tests__/agent-system-prompt.test.ts
git commit -m "docs(core): update system prompts with complete sub_agent param documentation"
```

---

### Task 8: 全量测试验证

**Files:** None (verification only)

- [ ] **Step 1: Run all core tests**

```bash
pnpm --filter @actalk/inkos-core test -- --run
```

Expected: All pass

- [ ] **Step 2: Run all studio tests**

```bash
pnpm --filter @actalk/inkos-studio test -- --run
```

Expected: All pass

- [ ] **Step 3: Run all CLI tests**

```bash
pnpm --filter @actalk/inkos test -- --run
```

Expected: All pass (or only pre-existing Windows tar failures)

- [ ] **Step 4: Commit any fixes needed**

If any existing tests broke due to schema changes, fix them.
