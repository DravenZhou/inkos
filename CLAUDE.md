# InkOS

AI 长篇小说写作平台。monorepo: `packages/core`（运行时）、`packages/cli`（TUI）、`packages/studio`（Web UI / Hono + Vite）。

## 常用命令

```bash
pnpm dev              # 从根目录启动！core tsc --watch + studio Vite HMR + API server
pnpm build            # 全量构建
pnpm test             # vitest 全仓测试
pnpm --filter @actalk/inkos-core build     # 改了 core 后必须重建（或用 pnpm dev 自动 watch）
```

## 设计文档

| 文档 | 范围 | 何时读 |
|------|------|--------|
| `docs/infra/studio-state-management.md` | Studio Zustand store 架构、slice 约定、目录结构 | 修改 `packages/studio/src/store/` 时 |
| `docs/infra/studio-routing-and-session.md` | URL hash 路由 + 消息隔离 + pi-ai/pi-agent 集成 | 修改路由、session、LLM provider 时 |
| `docs/infra/studio-service-management.md` | 服务商管理页设计 | 修改 ConfigView / 服务商配置时 |
| `docs/superpowers/specs/2026-04-15-sub-agent-params-alignment.md` | sub_agent 工具参数对齐设计 | 修改 agent-tools.ts / sub_agent 工具时 |

## 工作规范

- **不要推测错误** — 遇到报错先读完整错误信息，定位根因后再修，不凭猜测改代码
- **原子化提交** — 每个 commit 只做一件事，功能和修复分开提交；不要把不相关的改动塞进同一个 commit
- **每步都跑测试** — 每个 task 完成后必须 `pnpm test` 全量通过，不能攒到最后才跑
- **防止 maxTokens 回归** — 替换 LLM provider 时必须确认 maxTokens 参数正确传递，不能丢失或硬编码；写测试验证
- **禁止简写/比喻式表达** — 不用"记账""接住""一等公民""跑全仓""闭环""抓手""赋能""落""落盘""落地""打（接口）"这类简写、借喻或商务黑话。一律用完整、直白的中文句子说清楚到底在做什么。示例：
  - "打 OpenAI 的 /models" → "向 OpenAI 的 /models 接口**发送请求**"（所有"打 XX 接口 / 打 API"都改为"向 XX 发送请求"或"调用 XX 接口"）
  - "接住错误" → "catch 住异常并写日志"
  - "三件事分别落到哪里" → "三件事分别存到了项目文件、用户级记忆、本次会话里"
  - "XX 是一等公民" → "XX 可以像普通值一样被赋值、传参、返回"
- **说人话，先说清楚再说精简** — 把一件事的来龙去脉先讲明白，比追求"简洁"更重要。宁可多说一句让对方一次看懂（人在做什么、为什么、放到了哪里），也不要为了省字写得像电报，让对方还得反过来问"你说的这个是什么意思"
- **禁止奉承式开场和英文直译套话** — 不说"你抓得好"（"good catch" 直译）、"你说得对"、"好问题"、"非常棒的观察"这类开头。它们既是套话又像拍马屁，没信息量。要承认对方点出的问题就直接说"对，这个我刚也没注意到"或干脆进入正题

## pi-agent 工具设计规范

修改 `packages/core/src/agent/agent-tools.ts` 时必须遵守：

- **schema 即文档** — TypeBox schema 的 `description` 直接传给 LLM，模型靠它理解参数含义；每个字段的 description 必须标注适用的 agent（如 `"reviser only: revision mode"`）
- **枚举用 Union+Literal** — 有限合法值用 `Type.Union([Type.Literal("a"), Type.Literal("b")])` 而非 `Type.String()`，模型能在 JSON Schema 里看到 `const` 约束，不会传错
- **开放文本用 String** — 书名、题材等无法穷举的值用 `Type.String({ description: "..." })`
- **Optional 包裹可选字段** — `Type.Optional(...)` 标记非必填参数
- **不硬编码 pipeline 参数** — sub_agent 的参数必须与 pipeline runner 方法签名对齐，不能在 execute 里写死值（如 `genre: "general"`）
- **返回值要可操作** — agent 收到的返回文本必须包含足够信息让它决定下一步（如 auditor 返回 issue 列表而非只返回数量）
- **错误抛异常** — execute 里不要 catch-and-encode 错误到返回值，throw 由 agent loop 统一处理

## 关键路径

- **Agent 工具**: `core/src/agent/agent-tools.ts` → `SubAgentParams` schema → `createSubAgentTool` → 调用 `PipelineRunner` 方法
- **建书流程**: `core/interaction/project-tools.ts` → `CREATE_BOOK_TOOL` + `chatWithTools` → Studio `ChatPage` → `BookFormCard`
- **Studio 入口**: `studio/src/App.tsx` → route 驱动页面切换
- **状态管理**: Zustand store，LobeHub slice 约定
  - `studio/src/store/chat/` — 对话消息、创建流程、侧边栏状态
  - `studio/src/store/service/` — 服务商连接状态、模型列表缓存、model picker 三态（loading/no-models/ready）
  - **原则**: Zustand selector 只返回 store 中已有的原始值。如果需要 `.filter()` / `.map()` 等产生新数组的派生，用组件内 `useMemo` 而不是 store selector — 否则会造成无限渲染循环
- **SSE 事件**: `studio/src/hooks/use-sse.ts`（共享 buffer）+ 组件内直连 EventSource（流式渲染）
- **服务商 preset**: `core/src/llm/service-presets.ts` → baseUrl/api/knownModels/modelsBaseUrl；Anthropic 兼容端点用于 MiniMax 和百炼
