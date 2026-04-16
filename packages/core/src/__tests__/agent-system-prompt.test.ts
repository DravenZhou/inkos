import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../agent/agent-system-prompt.js";

describe("buildAgentSystemPrompt", () => {
  describe("no book (creation flow)", () => {
    it("Chinese prompt includes info collection workflow", () => {
      const prompt = buildAgentSystemPrompt(null, "zh");
      expect(prompt).toContain("建书助手");
      expect(prompt).toContain("收集信息");
      expect(prompt).toContain("题材");
      expect(prompt).toContain("世界观");
      expect(prompt).toContain("主角");
      expect(prompt).toContain("核心冲突");
      expect(prompt).toContain("architect");
      expect(prompt).toContain("sub_agent");
    });

    it("English prompt includes info collection workflow", () => {
      const prompt = buildAgentSystemPrompt(null, "en");
      expect(prompt).toContain("book creation");
      expect(prompt).toContain("architect");
      expect(prompt).toContain("Genre");
      expect(prompt).toContain("Protagonist");
      expect(prompt).toContain("Core conflict");
    });

    it("Chinese prompt forbids emoji", () => {
      const prompt = buildAgentSystemPrompt(null, "zh");
      expect(prompt).toContain("不要在回复中添加表情符号");
    });

    it("English prompt forbids emoji", () => {
      const prompt = buildAgentSystemPrompt(null, "en");
      expect(prompt).toContain("Do NOT use emoji");
    });

    it("no-book prompt does NOT mention read/edit/grep/ls", () => {
      const prompt = buildAgentSystemPrompt(null, "zh");
      expect(prompt).not.toMatch(/\bread\b.*读取/);
      expect(prompt).not.toContain("edit");
    });
  });

  describe("with book (writing flow)", () => {
    it("Chinese prompt includes all tools except architect", () => {
      const prompt = buildAgentSystemPrompt("my-book", "zh");
      expect(prompt).toContain("my-book");
      expect(prompt).toContain("sub_agent");
      expect(prompt).toContain("writer");
      expect(prompt).toContain("auditor");
      expect(prompt).toContain("reviser");
      expect(prompt).toContain("read");
      expect(prompt).toContain("edit");
      expect(prompt).toContain("grep");
      expect(prompt).toContain("ls");
    });

    it("Chinese prompt warns NOT to call architect", () => {
      const prompt = buildAgentSystemPrompt("my-book", "zh");
      expect(prompt).toContain("不要调用 architect");
    });

    it("English prompt warns NOT to call architect", () => {
      const prompt = buildAgentSystemPrompt("novel", "en");
      expect(prompt).toContain("Do NOT call architect");
    });

    it("Chinese with-book prompt forbids emoji", () => {
      const prompt = buildAgentSystemPrompt("my-book", "zh");
      expect(prompt).toContain("不要在回复中添加表情符号");
    });

    it("English with-book prompt forbids emoji", () => {
      const prompt = buildAgentSystemPrompt("novel", "en");
      expect(prompt).toContain("Do NOT use emoji");
    });

    it("with-book prompt documents architect but warns not to call it", () => {
      const prompt = buildAgentSystemPrompt("my-book", "zh");
      // architect is documented in the tools list for completeness
      expect(prompt).toMatch(/agent="architect"/);
      // but the guidelines warn not to call it
      expect(prompt).toContain("不要调用 architect");
    });

    it("book-mode prompt documents all sub_agent params", () => {
      const prompt = buildAgentSystemPrompt("test-book", "zh");
      expect(prompt).toContain("title");
      expect(prompt).toContain("genre");
      expect(prompt).toContain("platform");
      expect(prompt).toContain("chapterWordCount");
      expect(prompt).toContain("mode");
      expect(prompt).toContain("anti-detect");
      expect(prompt).toContain("format");
      expect(prompt).toContain("approvedOnly");
    });
  });
});
