# Phase 1b: pi-ai 替换 LLM Provider 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 @mariozechner/pi-ai 替换 InkOS 自建的 LLM provider 层，保持外部接口不变（LLMClient, chatCompletion, chatWithTools），内部实现从 openai/anthropic SDK 切换到 pi-ai。

**Architecture:** 保持 `packages/core/src/llm/provider.ts` 的导出接口不变（LLMClient、LLMMessage、chatCompletion、chatWithTools 等），替换内部实现为 pi-ai 的 `streamSimple()`。这样 BaseAgent、12 个 pipeline agent、interaction tools 全部不需要改动。新增 `service-presets.ts` 提供预设服务商配置。

**Tech Stack:** @mariozechner/pi-ai, @mariozechner/pi-agent-core (后续 Phase 1c 用)

**设计 spec:** `docs/infra/studio-routing-and-session.md` Phase 1b 部分

---

## 替换策略

```
外部接口（不变）              内部实现（替换）
─────────────────────         ──────────────────
LLMClient                  → 内含 pi-ai Model 引用
LLMMessage                 → 不变（转换层映射到 pi-ai Message）
chatCompletion()           → 内部调用 pi-ai streamSimple()
chatWithTools()            → 内部调用 pi-ai tool calling
createLLMClient()          → 内部创建 pi-ai Model
BaseAgent.chat()           → 不变（调用 chatCompletion）
12 个 pipeline agents       → 不变（调用 BaseAgent.chat）
project-tools.ts            → 不变（调用 chatCompletion/chatWithTools）
```

**为什么不直接暴露 pi-ai 类型？** Phase 1c（pi-agent 交互层）会引入 pi-agent-core，届时主 Agent 直接使用 pi-ai 类型。Phase 1b 只替换底层，不改接口，降低风险。

---

## File Structure

```
packages/core/src/llm/
├── provider.ts              ← 重写：内部用 pi-ai，导出接口不变
├── service-presets.ts        ← 新建：SERVICE_PRESETS 预设服务商
└── (删除 openai/anthropic SDK 依赖)

packages/core/
├── package.json             ← 修改：添加 pi-ai，移除 openai + anthropic SDK
└── src/models/project.ts    ← 修改：LLMConfig 新增 service 字段
```

---

### Task 1: 安装 pi-ai + 服务商预设

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/llm/service-presets.ts`
- Modify: `packages/core/src/models/project.ts`

- [ ] **Step 1: 安装 pi-ai**

```bash
pnpm --filter @actalk/inkos-core add @mariozechner/pi-ai
```

- [ ] **Step 2: 创建 service-presets.ts**

```typescript
// packages/core/src/llm/service-presets.ts

export interface ServicePreset {
  readonly api: string;
  readonly baseUrl: string;
  readonly label: string;
}

export const SERVICE_PRESETS: Record<string, ServicePreset> = {
  openai:       { api: "openai-responses",   baseUrl: "https://api.openai.com/v1",                         label: "OpenAI" },
  anthropic:    { api: "anthropic-messages",  baseUrl: "https://api.anthropic.com",                         label: "Anthropic" },
  deepseek:     { api: "openai-completions",  baseUrl: "https://api.deepseek.com",                          label: "DeepSeek" },
  moonshot:     { api: "openai-completions",  baseUrl: "https://api.moonshot.cn/v1",                        label: "Moonshot (Kimi)" },
  minimax:      { api: "openai-completions",  baseUrl: "https://api.minimax.chat/v1",                       label: "MiniMax" },
  bailian:      { api: "openai-completions",  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", label: "百炼 (通义千问)" },
  zhipu:        { api: "openai-completions",  baseUrl: "https://open.bigmodel.cn/api/paas/v4",              label: "智谱 GLM" },
  siliconflow:  { api: "openai-completions",  baseUrl: "https://api.siliconflow.cn/v1",                     label: "硅基流动" },
  ppio:         { api: "openai-completions",  baseUrl: "https://api.ppinfra.com/v3/openai",                 label: "PPIO" },
  openrouter:   { api: "openai-responses",    baseUrl: "https://openrouter.ai/api/v1",                      label: "OpenRouter" },
  ollama:       { api: "openai-completions",  baseUrl: "http://localhost:11434/v1",                          label: "Ollama (本地)" },
  custom:       { api: "openai-completions",  baseUrl: "",                                                   label: "自定义端点" },
};

export function resolveServicePreset(service: string): ServicePreset | undefined {
  return SERVICE_PRESETS[service];
}

export function guessServiceFromBaseUrl(baseUrl: string): string {
  for (const [key, preset] of Object.entries(SERVICE_PRESETS)) {
    if (key === "custom") continue;
    if (baseUrl.includes(new URL(preset.baseUrl).hostname)) return key;
  }
  return "custom";
}
```

- [ ] **Step 3: 更新 LLMConfig schema**

在 `packages/core/src/models/project.ts` 的 `LLMConfigSchema` 中添加 `service` 字段：

在现有 `provider` 字段旁添加：

```typescript
service: z.string().default("custom"),
```

- [ ] **Step 4: 导出 service-presets**

在 `packages/core/src/index.ts` 添加：

```typescript
export { SERVICE_PRESETS, resolveServicePreset, guessServiceFromBaseUrl, type ServicePreset } from "./llm/service-presets.js";
```

- [ ] **Step 5: 验证构建**

```bash
pnpm --filter @actalk/inkos-core build 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/llm/service-presets.ts packages/core/src/models/project.ts packages/core/src/index.ts pnpm-lock.yaml
git commit -m "feat(core): add pi-ai dependency and service presets"
```

---

### Task 2: 重写 provider.ts 核心 — createLLMClient

**Files:**
- Modify: `packages/core/src/llm/provider.ts`

这是最关键的一步。用 pi-ai 的 Model 替换 OpenAI/Anthropic SDK 实例，但保持 LLMClient 接口不变。

- [ ] **Step 1: 阅读 pi-ai API**

先理解 pi-ai 的核心 API。在 `packages/core` 下运行：

```bash
node -e "import('@mariozechner/pi-ai').then(m => console.log(Object.keys(m)))"
```

关键 API：
- `streamSimple(model, context, options)` — 流式 LLM 调用
- `Model` 类型 — 模型定义
- `Message` 类型 — 消息格式
- `registerApiProvider()` — 注册 provider

- [ ] **Step 2: 修改 LLMClient 接口**

在 `provider.ts` 中，LLMClient 当前持有 `_openai` 和 `_anthropic` SDK 实例。改为持有 pi-ai Model：

```typescript
export interface LLMClient {
  readonly provider: "openai" | "anthropic" | string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  // 新增：pi-ai Model 引用
  readonly _piModel: import("@mariozechner/pi-ai").Model<any>;
  // 保留向后兼容（逐步移除）
  readonly _openai?: any;
  readonly _anthropic?: any;
  readonly defaults: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly maxTokensCap: number;
    readonly thinkingBudget: number;
    readonly extra?: Record<string, unknown>;
  };
}
```

- [ ] **Step 3: 重写 createLLMClient**

```typescript
import { type Model, type Api } from "@mariozechner/pi-ai";
import { resolveServicePreset } from "./service-presets.js";

export function createLLMClient(config: LLMConfig): LLMClient {
  const service = config.service ?? (config.provider === "anthropic" ? "anthropic" : "custom");
  const preset = resolveServicePreset(service);
  const api = preset?.api ?? "openai-completions";
  const baseUrl = config.baseUrl || preset?.baseUrl || "https://api.openai.com/v1";

  const piModel: Model<any> = {
    id: config.model,
    name: config.model,
    api: api as Api,
    provider: service,
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: config.maxTokens ?? 8192,
    ...(config.headers ? { headers: config.headers } : {}),
  };

  return {
    provider: config.provider === "anthropic" ? "anthropic" : "openai",
    apiFormat: config.apiFormat ?? "chat",
    stream: config.stream ?? true,
    _piModel: piModel,
    defaults: {
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 8192,
      maxTokensCap: config.maxTokens ?? 8192,
      thinkingBudget: config.thinkingBudget ?? 0,
      extra: config.extra,
    },
  };
}
```

- [ ] **Step 4: 验证构建（允许部分 TS 警告）**

```bash
pnpm --filter @actalk/inkos-core build 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/provider.ts
git commit -m "feat(core): rewrite createLLMClient to use pi-ai Model"
```

---

### Task 3: 重写 chatCompletion — 使用 pi-ai streamSimple

**Files:**
- Modify: `packages/core/src/llm/provider.ts`

- [ ] **Step 1: 理解 pi-ai streamSimple API**

pi-ai 的流式调用：

```typescript
import { streamSimple } from "@mariozechner/pi-ai";

const stream = streamSimple(model, {
  systemPrompt: "...",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
}, { apiKey: "..." });

for await (const event of stream) {
  if (event.type === "content") {
    // event.text — 增量文本
  }
}
// stream.text — 完整文本
// stream.usage — { inputTokens, outputTokens }
```

- [ ] **Step 2: 重写 chatCompletion 函数**

保持签名不变，内部用 pi-ai：

```typescript
export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly webSearch?: boolean;
    readonly onStreamProgress?: OnStreamProgress;
    readonly onTextDelta?: (text: string) => void;
  },
): Promise<LLMResponse> {
  const { streamSimple } = await import("@mariozechner/pi-ai");

  // 构建 pi-ai 消息格式
  const systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
  const piMessages = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role as "user" | "assistant",
      content: [{ type: "text" as const, text: m.content }],
    }));

  const temp = clampTemperatureForModel(
    model,
    options?.temperature ?? client.defaults.temperature,
  );

  const monitor = createStreamMonitor(options?.onStreamProgress);
  let fullText = "";

  try {
    const stream = streamSimple(client._piModel, {
      systemPrompt,
      messages: piMessages,
    }, {
      apiKey: "", // pi-ai 从环境变量或 model config 获取
      temperature: temp,
      maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
    });

    for await (const event of stream) {
      if (event.type === "content") {
        fullText += event.text;
        monitor.onChunk(event.text);
        options?.onTextDelta?.(event.text);
      }
    }

    monitor.stop();

    return {
      content: fullText,
      usage: {
        promptTokens: stream.usage?.inputTokens ?? 0,
        completionTokens: stream.usage?.outputTokens ?? 0,
        totalTokens: (stream.usage?.inputTokens ?? 0) + (stream.usage?.outputTokens ?? 0),
      },
    };
  } catch (e) {
    monitor.stop();
    // 部分响应回收：如果已经收到 ≥500 字符，返回部分内容
    if (fullText.length >= 500) {
      return {
        content: fullText,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    throw wrapLLMError(e);
  }
}
```

注意：这是简化版本。需要根据 pi-ai 实际 API 调整。关键是保持函数签名和返回值不变。

- [ ] **Step 3: 处理 API key 传递**

pi-ai 通过 `getApiKey` 回调或环境变量获取 API key。需要在 `streamSimple` 的 options 中传入：

```typescript
const streamOptions = {
  apiKey: extractApiKey(client),
  temperature: temp,
  maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
};
```

`extractApiKey` 从 LLMClient 或环境变量中获取 key。需要在 LLMClient 中保存 apiKey 引用。

更新 LLMClient 接口添加：
```typescript
readonly _apiKey: string;
```

在 createLLMClient 中设置：
```typescript
_apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? "",
```

- [ ] **Step 4: 运行现有测试**

```bash
pnpm --filter @actalk/inkos-core test 2>&1 | tail -20
```

关注 provider.test.ts 的结果——这些测试直接测试 chatCompletion，如果 mock 方式变了需要调整。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/provider.ts
git commit -m "feat(core): rewrite chatCompletion to use pi-ai streamSimple"
```

---

### Task 4: 重写 chatWithTools — 使用 pi-ai tool calling

**Files:**
- Modify: `packages/core/src/llm/provider.ts`

- [ ] **Step 1: 重写 chatWithTools**

保持签名不变：

```typescript
export async function chatWithTools(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
  },
): Promise<ChatWithToolsResult> {
  const { streamSimple } = await import("@mariozechner/pi-ai");

  const systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
  const piMessages = messages
    .filter(m => m.role !== "system")
    .map(agentMessageToPiAi);

  const piTools = tools.map(t => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const stream = streamSimple(client._piModel, {
    systemPrompt,
    messages: piMessages,
    tools: piTools,
  }, {
    apiKey: client._apiKey,
    temperature: options?.temperature ?? client.defaults.temperature,
    maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
  });

  let content = "";
  const toolCalls: ToolCall[] = [];

  for await (const event of stream) {
    if (event.type === "content") {
      content += event.text;
    }
    if (event.type === "tool_call") {
      toolCalls.push({
        id: event.id,
        name: event.name,
        arguments: JSON.stringify(event.arguments),
      });
    }
  }

  return { content, toolCalls };
}
```

注意：pi-ai 的 tool call event 结构需要根据实际 API 调整。这是预期的结构。

- [ ] **Step 2: 添加消息转换辅助函数**

```typescript
function agentMessageToPiAi(msg: AgentMessage): any {
  if (msg.role === "tool") {
    return {
      role: "tool",
      toolCallId: msg.toolCallId,
      content: [{ type: "text", text: msg.content }],
    };
  }
  if (msg.role === "assistant" && msg.toolCalls) {
    return {
      role: "assistant",
      content: msg.content ? [{ type: "text", text: msg.content }] : [],
      toolCalls: msg.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.parse(tc.arguments),
      })),
    };
  }
  return {
    role: msg.role,
    content: [{ type: "text", text: msg.content ?? "" }],
  };
}
```

- [ ] **Step 3: 验证构建 + 测试**

```bash
pnpm --filter @actalk/inkos-core build 2>&1 | tail -5
pnpm --filter @actalk/inkos-core test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/llm/provider.ts
git commit -m "feat(core): rewrite chatWithTools to use pi-ai tool calling"
```

---

### Task 5: 清理旧代码 + 移除 SDK 依赖

**Files:**
- Modify: `packages/core/src/llm/provider.ts`
- Modify: `packages/core/package.json`

- [ ] **Step 1: 删除旧的 provider-specific 实现函数**

移除 provider.ts 中不再需要的函数：
- `chatCompletionOpenAIChat`, `chatCompletionOpenAIChatSync`
- `chatCompletionOpenAIResponses`, `chatCompletionOpenAIResponsesSync`
- `chatCompletionAnthropic`, `chatCompletionAnthropicSync`
- `chatWithToolsOpenAIChat`, `chatWithToolsOpenAIResponses`, `chatWithToolsAnthropic`
- `agentMessagesToOpenAIChat`, `agentMessagesToResponsesInput`, `agentMessagesToAnthropic`

保留：
- 所有导出类型（LLMClient, LLMMessage, LLMResponse, etc.）
- `createLLMClient`, `chatCompletion`, `chatWithTools`（新实现）
- `createStreamMonitor`（streaming 进度监控）
- `clampTemperatureForModel`（温度限制）
- 错误处理辅助函数

- [ ] **Step 2: 移除 openai + anthropic SDK**

```bash
pnpm --filter @actalk/inkos-core remove openai @anthropic-ai/sdk
```

- [ ] **Step 3: 删除 SDK import**

在 provider.ts 顶部删除：
```typescript
// 删除
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
```

- [ ] **Step 4: 验证构建 + 全量测试**

```bash
pnpm build 2>&1 | tail -10
pnpm test 2>&1 | tail -30
```

部分测试可能因为 mock OpenAI/Anthropic SDK 而失败，需要更新测试 mock 为 pi-ai。

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "refactor(core): remove openai + anthropic SDK, pi-ai is sole LLM provider"
```

---

### Task 6: 更新测试 mock

**Files:**
- Modify: `packages/core/src/__tests__/provider.test.ts`
- Modify: `packages/core/src/__tests__/pipeline-runner.test.ts`

- [ ] **Step 1: 更新 provider.test.ts**

现有测试 mock OpenAI/Anthropic SDK。需要改为 mock pi-ai 的 `streamSimple`：

```typescript
import { vi } from "vitest";

// Mock pi-ai
vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(async function* () {
    yield { type: "content", text: "mocked response" };
    return {
      text: "mocked response",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  }),
}));
```

- [ ] **Step 2: 更新 pipeline-runner.test.ts**

类似地更新 LLM mock。

- [ ] **Step 3: 运行全量测试**

```bash
pnpm test 2>&1 | tail -30
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/__tests__/
git commit -m "test(core): update LLM mocks from openai/anthropic SDK to pi-ai"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 全量构建**

```bash
pnpm build 2>&1 | tail -10
```

- [ ] **Step 2: 全量测试**

```bash
pnpm test 2>&1 | tail -30
```

- [ ] **Step 3: 手动验证**

启动 `inkos studio`，测试：
- 建书流程（chatWithTools 调用 create_book tool）
- 写章节（pipeline agents 通过 BaseAgent.chat → chatCompletion）
- 聊天（project-tools.ts 的 chat 函数）

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix(core): phase 1b polish from e2e testing"
```

---

## 风险与注意事项

1. **pi-ai streamSimple 的实际 API 可能与预期不同** — Task 2-4 的代码是基于 pi-ai 文档推测的，实际实现时需要先读 pi-ai 源码确认 API
2. **thinking model 处理** — kimi-k2.5 等模型的静默思考阶段在 pi-ai 中的行为需要验证
3. **部分响应回收** — InkOS 的 ≥500 字符部分响应回收逻辑需要在 pi-ai 层重新实现
4. **web search** — 当前 OpenAI 原生支持 web_search，pi-ai 可能需要手动实现
5. **测试更新工作量** — 大量测试 mock OpenAI/Anthropic SDK，都需要改为 mock pi-ai
