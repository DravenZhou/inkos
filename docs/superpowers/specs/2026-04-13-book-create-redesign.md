# BookCreate 页面重构设计

## 概述

将 Studio 的建书页面从"双栏表单"重构为"单流对话 + 内嵌表单"。用户点击开始建书后，AI 流式回复，markdown 文本中穿插可交互的表单控件（输入框、选项组、数字输入等）。同时重写 `developBookDraft` 的 prompt，从纯 JSON 返回改为 markdown + 表单标记格式，core 层共享解析器统一服务 Studio 和 TUI。

## 交互模型

页面只有一栏，自上而下：

1. 历史轮次摘要（折叠，点击可展开）
2. 最新一轮 AI 回复（流式 markdown + 内嵌表单控件）
3. 底部常驻输入栏（全页唯一的发送按钮）

### 用户流程

1. 用户输入一句话想法 → 点发送
2. AI 流式回复出现，markdown 文本中穿插表单区块
3. 用户可直接在表单里修改内容（静默更新本地 draft，不触发 LLM）
4. 用户在底部输入栏继续打磨 → 带最新 draft 进入下一轮
5. 每轮新回复替换当前内容，旧轮次折叠为一行摘要
6. 草案就绪时，底部栏变形为确认区块："开始写这本书" / "继续打磨"

### 交互细节

- **全页只有底部一个发送按钮**。内嵌选项（平台、方向等）点击即选，不带独立发送按钮。
- **内嵌字段可编辑**。用户改了字段后本地 draft 立即更新，下次发送消息时修改过的 draft 一起带给 LLM。
- **替换刷新**。页面始终只显示最新一轮的 AI 回复和表单。历史消息折叠为一行摘要（如"第 2 轮 · 你补充了反派设定"），点击可展开。
- **草案就绪标准**：核心要素（书名、题材、世界观、主角、核心冲突、平台、章节规划）都已有内容时，AI 在回复末尾告知就绪，底部栏显示确认区块。

## 表单标记协议

LLM 输出 markdown 文本，中间穿插以下标记块：

### 控件类型

| 标记 | 渲染为 | 用途 |
|------|--------|------|
| `:::field{key label}` | `<input>` 或 `<textarea>` | 文本字段（书名、世界观、主角等） |
| `:::pick{key label}` | 可点选的选项卡片 | 单选题（平台、方向等） |
| `:::number{key label}` | `<input type="number">` | 数字字段（章数、字数） |
| `:::group{label}` | 并排容器 | 把多个字段编组 |

### 语法示例

```markdown
好的，这个方向很有张力——

:::field{key="title" label="书名"}
暗潮：港口城权力博弈
:::

世界观方面，港风商战通常扎根在繁华但暗流涌动的都市——

:::field{key="worldPremise" label="世界观" type="textarea"}
近未来港口城市，灰色产业链与金融精英交织的地下经济圈。
:::

接下来确定发布平台——

:::pick{key="platform" label="目标平台"}
- 番茄小说
- 起点中文网
- 飞卢
- 其他
:::

:::group{label="章节规划"}
:::number{key="targetChapters" label="目标章数"}
300
:::
:::number{key="chapterWordCount" label="每章字数"}
3000
:::
:::
```

### 可用字段

按重要性排序：

- title（书名）、genre（题材）、worldPremise（世界观）、protagonist（主角）、conflictCore（核心冲突）
- blurb（简介）、volumeOutline（卷一方向）、supportingCast（配角）
- platform（发布平台）、targetChapters（目标章数）、chapterWordCount（每章字数）
- settingNotes（设定备注）、authorIntent（作者意图）、constraints（约束条件）

## Prompt 设计

```
你是 InkOS 的建书引导员，负责帮用户从一句模糊想法出发，逐步打磨出一份可以开始写作的 foundation 草案。

## 基础工作原则
1. 请参考用户提供的已有草案内容，在此基础上推进，创作出具有延续性的设定。
2. 你需要根据用户需求和创作情况维护草案内容，帮助用户管理和组织好书籍的基础结构。

## 创作任务处理流程
1. 在构建草案或执行复杂创作任务之前，请先输出你的构思计划，和用户确认后再推进。
2. 当用户拒绝你的建议时，说明用户对当前方向不满意，请重新和用户沟通你的构思计划，不要直接继续。
3. 先确立世界观和主角设定，确保用户确认满意后再推进核心冲突和卷纲方向。
4. 每一步完成后，请主动和用户确认内容是否满意，如果用户不满意，请根据用户需求调整，直到用户确认满意后再推进下一步。

## 草案应涵盖的要素

### 1. 风格
定义小说的文字气质和叙事基调：
- **叙事视角**：主要视角（如第三人称有限视角）、视角切换规则
- **语言基调**：整体气质（冷峻写实 / 华丽奇幻 / 轻松幽默 / 沉郁诗意）、时代感 / 地域感
- **节奏偏好**：动作场景短句为主、日常场景长句铺陈
- **对话风格**：对话功能（推进剧情 / 展现性格 / 蕴含潜台词）、口语化程度

### 2. 世界观与设定
记录小说中的设定信息，包括物品 / 场景 / 概念等，记录要包含创作内容所需要的各个方面信息。

### 3. 角色
记录小说中的角色信息，包括身份背景和经历、性格、外貌特征、能力和关系网络、内在驱动和成长弧光。主要角色需要详细设定，次要角色简要描述。

### 4. 核心冲突与剧情方向
明确小说的整体方向和核心矛盾。包含核心冲突、主线走向、卷一具体方向。

### 5. 发布规划
平台选择、目标章数、每章字数。不同平台的节奏和字数要求差别很大——番茄读者要节奏快、钩子密；起点读者能接受更重的设定铺垫。

## 输出格式

你的回复是 markdown 文本，中间穿插表单标记块。用户在流式对话界面中看到你的回复，表单块会渲染为可交互的输入控件。用户可以直接在控件中修改内容，修改会在下一轮对话时随草案一起发送给你。

可用标记：

:::field{key="字段名" label="显示标签"}
预填内容
:::

:::field{key="字段名" label="显示标签" type="textarea"}
多行预填内容
:::

:::pick{key="字段名" label="显示标签"}
- 选项一
- 选项二
- 选项三
:::

:::number{key="字段名" label="显示标签"}
默认值
:::

:::group{label="组标签"}
（嵌套多个 field / number）
:::

### 输出规范
1. 先输出你的思考和建议（自然的对话文本），再给出对应的表单块让用户确认或修改。
2. 需要用户做选择时用 :::pick，需要用户填写或确认内容时用 :::field。
3. 当信息足以推导出合理默认值时，大胆预填进表单——让用户改比让用户从零写更轻松。预填内容要体现你对该题材的理解，不要写泛泛的占位符。
4. 每轮只推进一到两个焦点，不要一次铺开所有字段。
5. 当核心要素（书名、题材、世界观、主角、核心冲突、平台、章节规划）都已有内容时，在回复末尾明确告知用户草案已就绪，可以开始写了。
```

## 前端组件架构

当前 `BookCreate.tsx` 是一个 550 行的大组件。新设计拆为：

| 组件 | 职责 |
|------|------|
| `BookCreate.tsx` | 页面容器，管理 draft state + 对话轮次 |
| `StreamMessage.tsx` | 渲染一条 AI 回复：解析 markdown + `:::` 标记，输出文本和表单控件 |
| `InlineField.tsx` | 单个内嵌表单字段（input / textarea / number） |
| `InlinePick.tsx` | 单选选项卡片组，点击即选 |
| `InlineGroup.tsx` | 字段编组容器 |
| `RoundSummary.tsx` | 折叠的历史轮次摘要 |
| `DraftReadyBar.tsx` | 草案就绪时的确认区块 |
| `ComposerBar.tsx` | 底部常驻输入栏 + 发送按钮 |

## 数据流

```
用户输入 → ComposerBar → POST /agent (instruction + 当前 draft 含用户修改)
                                ↓
                        NL Router → develop_book
                                ↓
                        developBookDraft(instruction, draft)
                                ↓
                        LLM 流式输出 markdown + :::标记
                                ↓
                        SSE 逐 token 推送到前端
                                ↓
                        StreamMessage 边接收边渲染
                        - 普通文本 → markdown 渲染
                        - :::field/pick/number → 表单控件
                                ↓
                        用户改表单 → 静默更新本地 draft
                        用户发消息 → 带最新 draft 进入下一轮
```

### 与当前的关键差异

- LLM 调用从一次性返回 JSON → 流式输出 markdown（`chatCompletion` 的 `onTextDelta` 接入 SSE）
- 前端从轮询 session → SSE 实时接收流式内容
- draft 更新从"整体替换" → "用户在表单里改了哪个字段就 patch 哪个"

## 流式解析器

core 层共享 parser，逐行扫描 LLM 输出：

- 普通行 → 累积到 markdown buffer
- `:::field{...}` → 切换到"表单收集模式"，收集到下一个 `:::` 为止
- `:::pick{...}` → 同上，收集选项列表
- `:::group{...}` → 进入嵌套容器，直到配对的 `:::`
- 遇到关闭 `:::` → 输出表单组件描述，恢复 markdown 模式

输出结构：

```typescript
interface ParsedDraftResponse {
  fields: Record<string, string>;  // 提取的所有字段 key → value
  textContent: string;             // 去掉 ::: 标记的纯文本（TUI 用）
  summary: string;                 // 自动生成的轮次摘要
  raw: string;                     // LLM 原始输出（Studio 用于流式渲染）
}
```

- **Studio**：拿 `raw` 做流式渲染，`:::` 标记 → 表单控件
- **TUI**：拿 `textContent` 做 markdown 渲染，`fields` 静默更新 draft

## Session 状态与持久化

### 数据结构

```typescript
interface CreationDraftState {
  fields: BookCreationDraft;       // 草案字段最新值（兼容现有结构）
  readyToCreate: boolean;
}

interface DraftRound {
  roundId: number;
  userMessage: string;
  assistantRaw: string;            // LLM 原始输出（含 ::: 标记）
  fieldsUpdated: string[];         // 本轮更新了哪些字段
  summary: string;                 // 折叠摘要（如"确立了书名、世界观和主角"）
  timestamp: number;
}

// session 中新增
interface InteractionSession {
  // ...现有字段
  creationDraft?: CreationDraftState;
  draftRounds?: DraftRound[];
}
```

### 持久化时机

| 事件 | 操作 |
|------|------|
| 用户编辑内嵌字段 | 只更新内存中的 `draft.fields`，不写盘 |
| 用户点发送 | 带最新 draft 发给 LLM，流式完成后一次性写盘：更新 fields + 追加新 round |
| 流式输出中断 | 不写盘，draft 保持上一轮的状态 |
| 用户点"开始写这本书" | 从 `draft.fields` 构建 BookConfig → `pipeline.initBook()` → 清空 draft 和 rounds |
| 用户点"丢弃草案" | 清空 draft 和 rounds，写盘 |

### TUI 兼容

TUI 不支持内嵌表单渲染，但共享同一份 session：

- LLM 始终输出 markdown + `:::` 标记格式（一个 prompt，不区分端）
- core 层共享 parser 提取 `fields`（更新 draft）和 `textContent`（纯文本）
- TUI 渲染 `textContent` 为 markdown，draft fields 在后台更新
- Studio 渲染 `raw` 为流式内容 + 表单控件
- 两端写入同一个 `session.creationDraft.fields`，数据始终同步
- TUI 用 `/draft` 查看时，从 `fields` 渲染 markdown 摘要（和现在一致）
- Studio 轮询时，如果发现 `draftRounds` 有 TUI 新增的轮次，用 `summary` 显示折叠摘要
