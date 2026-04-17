# server.ts 拆分与错误响应统一设计

## 背景

`packages/studio/src/api/server.ts` 有 2494 行，把 Books、Chapters、Sessions、Agent、Services、Genres、Daemon、Doctor 等十几个业务域的路由全部堆在一个 `createStudioServer` 函数里。错误响应有两种格式并存：`{ error: { code, message } }`（ApiError）和 `{ error: string }`（裸字符串），前端被迫用 `extractErrorMessage()` 兼容两种。

本次改造做两件事：按 DDD 限界上下文拆分路由模块，统一所有 API 错误为 `{ error: { code, message } }` 结构。

## 限界上下文划分

| 上下文 | 文件 | 包含的路由 |
|---|---|---|
| **Book** | `routes/book.ts` | books CRUD、chapters 读写、truth files 读写/浏览、analytics、write-next、draft、revise、resync、rewrite、approve/reject、audit、detect/detect-all/detect-stats、export/export-save、import chapters/canon、fanfic init/show/refresh、style analyze/import、book create + create-status |
| **Conversation** | `routes/conversation.ts` | `/api/v1/agent`（agent chat）、`/api/v1/sessions` CRUD、`/api/v1/interaction/session`、session 标题自动生成 |
| **Service** | `routes/service.ts` | `/api/v1/services` 列表、`/api/v1/services/config` 读写、`/api/v1/services/:service/test`、`/api/v1/services/:service/secret` 读写、`/api/v1/services/:service/models` |
| **Project** | `routes/project.ts` | project 读写、language 设置、model-overrides 读写、notify 读写、genres CRUD/copy、daemon start/stop/status、doctor、logs、radar/scan |

## 目录结构

```
api/
├── server.ts              # 瘦壳：Hono app + 中间件 + 挂载 4 个路由模块（~80 行）
├── errors.ts              # ApiError 类（已有，不改）
├── safety.ts              # isSafeBookId（已有，不改）
├── book-create.ts         # buildStudioBookConfig（已有，不改）
├── index.ts               # startStudioServer 入口（已有，不改）
│
├── routes/
│   ├── book.ts            # ~700 行
│   ├── conversation.ts    # ~450 行
│   ├── service.ts         # ~200 行
│   └── project.ts         # ~300 行
│
├── lib/
│   ├── types.ts           # RouteDeps 接口、PipelineOverrides 类型
│   ├── broadcast.ts       # SSE 事件总线（subscribers Set、broadcast 函数）
│   ├── pipeline.ts        # loadCurrentProjectConfig、buildPipelineConfig
│   ├── service-utils.ts   # normalizeServiceConfig、mergeServiceConfig、
│   │                      # resolveConfiguredServiceBaseUrl、resolveConfiguredServiceEntry、
│   │                      # buildProbePlans、buildModelCandidates、
│   │                      # fetchModelsFromServiceBaseUrl、probeServiceCapabilities、
│   │                      # isCustomServiceId、serviceConfigKey、normalizeServiceEntry、
│   │                      # normalizeConfigSource
│   ├── config-io.ts       # loadRawConfig、saveRawConfig、readEnvConfigSummary、readEnvConfigStatus
│   ├── chapter-utils.ts   # findChapterFile（提取 4 处重复的 padded-number 章节查找）
│   ├── agent-event-utils.ts # PIPELINE_STAGES、AGENT_LABELS、TOOL_LABELS、
│   │                      # resolveToolLabel、summarizeResult、extractToolError、
│   │                      # normalizeGeneratedSessionTitle、CollectedToolExec 接口
│   ├── run-store.ts       # （已有，不动）
│   └── sse.ts             # （已有，不动）
```

## RouteDeps 依赖注入

```ts
// api/lib/types.ts
export interface PipelineOverrides {
  externalContext?: string;
  client?: unknown;
  model?: string;
  currentConfig?: ProjectConfig;
  sessionIdForSSE?: string;
}

export interface RouteDeps {
  readonly root: string;
  readonly state: StateManager;
  loadCurrentProjectConfig(options?: { requireApiKey?: boolean }): Promise<ProjectConfig>;
  buildPipelineConfig(overrides?: PipelineOverrides): Promise<PipelineConfig>;
  broadcast(event: string, data: unknown): void;
}
```

### 域内私有状态

不进 RouteDeps，各自留在域内闭包里：

- `bookCreateStatus: Map` → `book.ts` 内部
- `modelListCache: Map` → `service.ts` 内部
- `schedulerInstance` → `project.ts` 内部

## server.ts 瘦壳

拆分后的 `server.ts` 只做四件事：

1. 创建 Hono app，挂 CORS 中间件和 `app.onError` 错误处理器
2. 挂 bookId 校验中间件（`/api/v1/books/:id` 和 `/api/v1/books/:id/*`）
3. 组装 RouteDeps，挂载 4 个路由模块
4. 挂 SSE `/api/v1/events` 端点（因为它是基础设施层，不属于任何域）

```ts
export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  const app = new Hono();
  const state = new StateManager(root);

  app.use("/*", cors());
  app.onError((error, c) => { /* ApiError → typed JSON, others → 500 */ });

  // bookId 校验中间件
  app.use("/api/v1/books/:id/*", ...);
  app.use("/api/v1/books/:id", ...);

  // 组装依赖
  const deps: RouteDeps = { root, state, loadCurrentProjectConfig, buildPipelineConfig, broadcast };

  // 挂载路由
  app.route("/api/v1", createBookRoutes(deps));
  app.route("/api/v1", createConversationRoutes(deps));
  app.route("/api/v1", createServiceRoutes(deps));
  app.route("/api/v1", createProjectRoutes(deps));

  // SSE
  app.get("/api/v1/events", (c) => { ... });

  return app;
}
```

## 错误响应统一

### 目标格式

所有 API 错误统一为：

```json
{ "error": { "code": "ERROR_CODE", "message": "人类可读的描述" } }
```

HTTP 状态码由 `ApiError.status` 决定。

### 改动方式

所有 `return c.json({ error: "..." }, status)` 替换为 `throw new ApiError(status, "CODE", "message")`。`app.onError` 已经处理 ApiError 序列化，不需要改。

### Error Code 清单

| code | status | 场景 |
|---|---|---|
| `INVALID_BOOK_ID` | 400 | 路径穿越校验（已有） |
| `INVALID_GENRE_ID` | 400 | genre 路径校验（已有） |
| `INVALID_SESSION_TITLE` | 400 | session 重命名标题为空（已有） |
| `SESSION_ID_REQUIRED` | 400 | agent 请求缺 sessionId（已有） |
| `SESSION_ALREADY_MIGRATED` | 409 | session 已迁移（已有） |
| `AGENT_ERROR` | 500 | agent 运行时异常（已有） |
| `AGENT_EMPTY_RESPONSE` | 502 | agent 返回空文本（已有） |
| `AGENT_BUSY` | 429 | agent 正在处理中（已有） |
| `INTERNAL_ERROR` | 500 | 兜底错误（已有） |
| `BOOK_NOT_FOUND` | 404 | 书籍不存在（3 处） |
| `CHAPTER_NOT_FOUND` | 404 | 章节不存在（6 处） |
| `SESSION_NOT_FOUND` | 404 | session 不存在（2 处） |
| `GENRE_NOT_FOUND` | 404 | genre 删除时找不到 |
| `CREATE_STATUS_NOT_FOUND` | 404 | create-status 无记录 |
| `BOOK_ALREADY_EXISTS` | 409 | 建书时 bookId 已存在 |
| `INVALID_TRUTH_FILE` | 400 | truth 文件名不在白名单 |
| `EMPTY_API_KEY` | 400 | service test 时 apiKey 为空 |
| `UNKNOWN_SERVICE` | 400 | service test 时解析不到 baseUrl |
| `SERVICE_PROBE_FAILED` | 400 | service 连接测试失败 |
| `DAEMON_ALREADY_RUNNING` | 400 | daemon 重复启动 |
| `DAEMON_NOT_RUNNING` | 400 | daemon 未运行时 stop |
| `MISSING_REQUIRED_FIELD` | 400 | 必填字段缺失 |
| `EXPORT_FAILED` | 500 | 导出失败 |

### 不改的情况

Service test 路由返回的 `{ ok: false, error: "..." }` 保持不动。这是业务层面的探测结果（"我帮你试了，这个配置不通"），不是 HTTP 异常。它已经搭配了 HTTP 400 状态码和 `ok: false` 标志，前端用 `ok` 字段区分成功/失败，和错误处理是两条路径。

## 重复代码消除

`server.ts` 和 `store/chat/slices/message/runtime.ts` 各有一份 `resolveToolLabel`、`summarizeResult`、`extractToolError`。

server 端的搬到 `api/lib/agent-event-utils.ts`。前端 `runtime.ts` 的保留——前端 bundle 不应该依赖 server 端代码，两边的实现也有细微差异（`runtime.ts` 的 `summarizeResult` 少一个 `.text` 分支）。

## PIPELINE_STAGES 文案修正

`PIPELINE_STAGES` 里的 "落盘最终章节" 和 "落盘修订结果" 改为 "保存最终章节" 和 "保存修订结果"，消除 CLAUDE.md 禁止的简写表达。

## 测试策略

分两步：

1. **本次**：路由拆分后 `server.test.ts` 保持不动。所有测试都是通过 `createStudioServer` 发请求的集成测试，路由内部怎么拆不影响测试行为。跑 `pnpm test` 全量通过即可验证拆分没有破坏任何东西。
2. **后续**：测试按域拆到 `routes/__tests__/` 下，共享 mock setup 提取到 test fixture。不在本次范围内。

## 不做的事

- 不改 `startStudioServer`（静态文件服务逻辑），它留在 `server.ts` 或 `index.ts` 都行，不影响路由拆分
- 不改前端 `runtime.ts` 的重复函数，前后端保持独立
- 不改 `lib/run-store.ts` 和 `lib/sse.ts`
- 不拆测试文件（留给后续）
