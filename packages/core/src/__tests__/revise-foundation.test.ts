import { describe, it, expect, vi, afterEach } from "vitest";
import { ArchitectAgent } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import type { ArchitectOutput } from "../agents/architect.js";

describe("architect generateFoundation with reviseFrom option", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects legacy content into the system prompt when reviseFrom is supplied", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_frame ===",
          "## 主题",
          "新段落主题",
          "",
          "=== SECTION: volume_map ===",
          "## 段 1",
          "新卷一",
          "",
          "=== SECTION: roles ===",
          "---ROLE---",
          "tier: major",
          "name: 林辞",
          "---CONTENT---",
          "主角",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id |",
        ].join("\n"),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

    await agent.generateFoundation(
      {
        id: "test-book", title: "测试书", platform: "qidian", genre: "xuanhuan",
        status: "active", targetChapters: 50, chapterWordCount: 3000, language: "zh",
        createdAt: "2026-04-19T00:00:00.000Z", updatedAt: "2026-04-19T00:00:00.000Z",
      },
      undefined,
      undefined,
      {
        reviseFrom: {
          storyBible: "- 旧世界观：架空唐代\n- 旧主角：林辞",
          volumeOutline: "## 第一卷\n- 1. 主角登场",
          bookRules: "## 规则\n- 禁现代词",
          characterMatrix: "林辞 - 主角",
          userFeedback: "升级到段落式架构稿",
        },
      },
    );

    const systemMsg = (chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[0]!;
    expect(systemMsg.content).toContain("把一本已有书的架构稿从条目式升级");
    expect(systemMsg.content).toContain("旧世界观：架空唐代");
    expect(systemMsg.content).toContain("升级到段落式架构稿");
  });

  it("does not inject revisePrompt when reviseFrom is absent", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_frame ===", "## 主题", "段落",
          "=== SECTION: volume_map ===", "## 段 1", "卷一",
          "=== SECTION: roles ===", "---ROLE---", "tier: major", "name: X", "---CONTENT---", "主角",
          "=== SECTION: book_rules ===", "---", "version: \"1.0\"", "---",
          "=== SECTION: pending_hooks ===", "| hook_id |",
        ].join("\n"),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

    await agent.generateFoundation({
      id: "test-book", title: "测试", platform: "qidian", genre: "xuanhuan",
      status: "active", targetChapters: 50, chapterWordCount: 3000, language: "zh",
      createdAt: "2026-04-19T00:00:00.000Z", updatedAt: "2026-04-19T00:00:00.000Z",
    });

    const systemMsg = (chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[0]!;
    expect(systemMsg.content).not.toContain("把一本已有书的架构稿从条目式升级");
  });
});

describe("pipeline.reviseFoundation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backs up legacy files and writes Phase 5 output", async () => {
    const { mkdtemp, writeFile, mkdir, rm, access, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");

    const root = await mkdtemp(join(tmpdir(), "inkos-revise-e2e-"));
    const bookDir = join(root, "books", "legacy-book");

    try {
      // Construct a 旧书 on disk with 4 legacy files
      await mkdir(join(bookDir, "story"), { recursive: true });
      await writeFile(join(bookDir, "story", "story_bible.md"), "# 旧书架构稿\n\n- 架空唐代\n- 主角林辞", "utf-8");
      await writeFile(join(bookDir, "story", "volume_outline.md"), "## 第一卷\n- 主角登场", "utf-8");
      await writeFile(join(bookDir, "story", "book_rules.md"), "## 规则\n- 禁现代词", "utf-8");
      await writeFile(join(bookDir, "story", "character_matrix.md"), "## 角色\n林辞 - 主角", "utf-8");
      await writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: "legacy-book", title: "旧书", platform: "qidian", genre: "xuanhuan",
        status: "active", targetChapters: 50, chapterWordCount: 3000, language: "zh",
        createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z",
      }), "utf-8");

      // Stub architect.generateFoundation → Phase 5 output
      const mockFoundation: ArchitectOutput = {
        storyBible: "(shim)",
        volumeOutline: "(shim)",
        bookRules: "---\nversion: \"1.0\"\n---\n",
        currentState: "",
        pendingHooks: "| hook_id |",
        storyFrame: "## 主题\n\n段落式主题",
        volumeMap: "## 段 1\n\n卷一段落",
        roles: [{ tier: "major", name: "林辞", content: "主角段落描写" }],
      };
      vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue(mockFoundation);
      vi.spyOn(FoundationReviewerAgent.prototype, "review").mockResolvedValue({
        passed: true, totalScore: 90, dimensions: [], overallFeedback: "ok",
      } as unknown as Awaited<ReturnType<FoundationReviewerAgent["review"]>>);

      // Minimal config for PipelineRunner
      const state = new StateManager(root);
      const runner = new PipelineRunner({
        state,
        projectRoot: root,
        client: {
          provider: "openai",
          apiFormat: "chat",
          stream: false,
          defaults: {
            temperature: 0.7,
            maxTokens: 4096,
            thinkingBudget: 0, maxTokensCap: null,
            extra: {},
          },
        },
        model: "test-model",
      } as unknown as ConstructorParameters<typeof PipelineRunner>[0]);

      await runner.reviseFoundation("legacy-book", "升级到段落式");

      // New files created
      await expect(access(join(bookDir, "story", "outline", "story_frame.md"))).resolves.not.toThrow();
      await expect(access(join(bookDir, "story", "outline", "volume_map.md"))).resolves.not.toThrow();
      await expect(access(join(bookDir, "story", "roles", "主要角色", "林辞.md"))).resolves.not.toThrow();
      // Backup exists
      const storyEntries = await readdir(join(bookDir, "story"));
      const backupDir = storyEntries.find((e) => e.startsWith(".backup-phase4-"));
      expect(backupDir).toBeDefined();
      await expect(access(join(bookDir, "story", backupDir!, "story_bible.md"))).resolves.not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
