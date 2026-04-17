# sub_agent 工具参数对齐设计

## 目标

让 sub_agent 的 5 个子智能体（architect/writer/auditor/reviser/exporter）的参数与 pipeline runner 方法对齐，消除硬编码和参数丢弃。

## Scope

**A 层：参数暴露**。只对齐已暴露的 5 个 agent，不新增 pipeline 方法的暴露（writeDraft、planChapter、repairChapterState 等留后续）。

## 方案

**方案 3：扁平扩展 + description 约束**。在现有 `SubAgentParams` 上新增字段，每个字段的 TypeBox `description` 标注适用的 agent，模型通过 tool schema 的 description 知道约束。

## SubAgentParams schema 变更

现有字段：
- `agent` — 子智能体类型（不变）
- `instruction` — 自然语言指令（不变，行为改变见下）
- `bookId` — 书籍 ID（不变）
- `chapterNumber` — 目标章节号（已有，auditor/reviser 适用）

新增字段（全部 `Type.Optional`）：

| 字段 | 类型 | description | 适用 agent |
|------|------|-------------|-----------|
| `title` | `String` | architect only: 书名 | architect |
| `genre` | `String` | architect only: 题材 (xuanhuan, urban, mystery 等) | architect |
| `platform` | `Union(Literal)` | architect only: 目标平台 (tomato/qidian/feilu/other) | architect |
| `language` | `Union(Literal)` | architect only: 写作语言 (zh/en) | architect |
| `targetChapters` | `Number` | architect only: 目标总章数，默认 200 | architect |
| `chapterWordCount` | `Number` | architect/writer: 每章目标字数，默认 3000 | architect, writer |
| `mode` | `Union(Literal)` | reviser only: 修订模式 (spot-fix/polish/rewrite/rework/anti-detect) | reviser |
| `format` | `Union(Literal)` | exporter only: 导出格式 (txt/md/epub) | exporter |
| `approvedOnly` | `Boolean` | exporter only: 仅导出已审核通过的章节 | exporter |

> **设计原则**：有限枚举值用 `Type.Union([Type.Literal(...)])` 而非 `Type.String`，模型能在 JSON Schema 里看到合法值列表（`const` 约束），不会传错。`genre` 和 `title` 是开放文本保持 `String`。

## 各 agent 行为变更

### 1. architect

**现状**：`pipeline.initBook({ id, genre: "general", title: "", language: "zh" } as any, { externalContext: instruction })`

**改为**：
```ts
const now = new Date().toISOString();
await pipeline.initBook({
  id,
  title: title ?? "",
  genre: genre ?? "general",
  platform: (platform as any) ?? "other",
  language: (language as any) ?? "zh",
  status: "outlining",
  targetChapters: targetChapters ?? 200,
  chapterWordCount: chapterWordCount ?? 3000,
  createdAt: now,
  updatedAt: now,
}, { externalContext: instruction });
```
- 去掉 `as any`，构建完整 BookConfig
- `instruction` 继续作为 `externalContext` 传递
- 建书后从 story_bible.md 回填 title（已有逻辑保留）

### 2. writer

**现状**：`pipeline.writeNextChapter(bookId)` — wordCount 丢弃，instruction 丢弃

**改为**：
```ts
const result = await pipeline.writeNextChapter(bookId, chapterWordCount);
```
- `chapterWordCount` 透传为 `wordCount` 参数
- `instruction` 透传为 pipeline config 的 `externalContext`（需要在 writeNextChapter 调用前设置）
- `chapterNumber` 不适用于 writer（writeNextChapter 总是写下一章），schema description 已标注

### 3. auditor

**现状**：参数齐了，返回值只有 issueCount

**改为**：
```ts
const audit = await pipeline.auditDraft(bookId, chapterNumber);
const issueLines = audit.issues
  .map(i => `[${i.severity}] ${i.description}`)
  .join("\n");
return textResult(
  `Audit chapter ${audit.chapterNumber}: ${audit.passed ? "PASSED" : "FAILED"}, ${audit.issues.length} issue(s).\n${issueLines}`
);
```
- 返回完整 issues 列表（severity + description），让 agent 能判断下一步操作

### 4. reviser

**现状**：mode 靠正则从 instruction 提取，anti-detect 不可达，instruction 丢弃

**改为**：
```ts
const resolvedMode: ReviseMode = mode ?? "spot-fix";
await pipeline.reviseDraft(bookId, chapterNumber, resolvedMode);
```
- `mode` 直接从 schema 字段读取，去掉正则逻辑
- `instruction` 透传为 `externalContext`（等同 CLI 的 `--brief`）

### 5. exporter

**现状**：纯 stub "Coming soon"

**改为**：使用 `project-tools.ts` 中已有的 `exportBookToPath` 逻辑：
```ts
const exportFormat = format ?? "txt";
const onlyApproved = approvedOnly ?? false;
// 调用 StateManager 的导出逻辑
```
- 支持 txt/md/epub 三种格式
- 支持 approvedOnly 过滤
- 返回导出文件路径

## 系统提示词更新

更新中英文系统提示词，说明每个 agent 的可用参数：
- architect: title, genre, platform, language, targetChapters, chapterWordCount
- writer: chapterWordCount（wordCount 覆盖）
- auditor: chapterNumber
- reviser: chapterNumber, mode
- exporter: format, approvedOnly

## 不在 scope 内

- 新增 sub_agent 类型（planner、repairer、syncer 等）
- writeDraft / planChapter / composeChapter 等方法暴露
- fanfic / import 流程
- temperatureOverride（CLI 也没暴露）
- writer 指定章节号（writeNextChapter 不支持）
