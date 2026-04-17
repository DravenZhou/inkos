# ai-elements 集成计划

## 前置条件

Studio CSS 变量已与 shadcn/ui 完全对齐（background, foreground, primary, card, muted, border, ring, radius 等全部一致），无需修改主题。

## Step 1: 安装 shadcn/ui（base-ui 模式）

```bash
cd packages/studio
npx shadcn@latest init
# 选择：
#   - Style: Default
#   - Base color: 不改（已有自定义主题）
#   - CSS variables: Yes
#   - Component library: base-ui  ← 关键
#   - Tailwind CSS: v4
#   - Components path: src/components/ui
#   - Utils path: src/lib/utils（已存在，确认覆盖或合并）
```

验证：`pnpm --filter @actalk/inkos-studio build` 不报错，现有页面渲染正常。

**涉及文件**：
- 新增/修改：`components.json`（shadcn 配置）
- 可能修改：`src/lib/utils.ts`（`cn` 函数，已存在，确认兼容）
- 可能修改：`tailwind.config.*`（如果 shadcn init 要求）
- 可能修改：`package.json`（新增 shadcn 依赖）

## Step 2: 安装 ai-elements 组件

```bash
cd packages/studio
npx ai-elements@latest add message
npx ai-elements@latest add tool
npx ai-elements@latest add confirmation
npx ai-elements@latest add prompt-input
```

这些组件会被复制到 `src/components/ui/` 下。检查生成的文件，确认它们引用的 CSS 变量和 Studio 主题一致。

验证：typecheck 通过，build 不报错。

**涉及文件**：
- 新增：`src/components/ui/message.tsx`（或类似路径）
- 新增：`src/components/ui/tool.tsx`
- 新增：`src/components/ui/confirmation.tsx`
- 新增：`src/components/ui/prompt-input.tsx`
- 可能新增：依赖的子组件（avatar, button 等）

## Step 3: 替换 ChatMessage

**当前**：`src/components/chat/ChatMessage.tsx` — 自建的消息气泡组件

**改为**：用 ai-elements 的 `Message` 组件重写。

```tsx
import { Message } from "../ui/message";  // ai-elements

// 用户消息
<Message role="user">
  <Message.Content>{content}</Message.Content>
</Message>

// AI 消息
<Message role="assistant">
  <Message.Content>{renderedMarkdown}</Message.Content>
</Message>

// 带 tool call 的消息
<Message role="assistant">
  <Message.Content>{content}</Message.Content>
  <Tool>
    <BookFormFields ... />
    <Confirmation onConfirm={...} />
  </Tool>
</Message>
```

**涉及文件**：
- 重写：`src/components/chat/ChatMessage.tsx`
- 删除：`src/components/book-create/StreamMessage.tsx`
- 删除：`src/components/book-create/InlineField.tsx`
- 删除：`src/components/book-create/InlinePick.tsx`
- 删除：`src/components/book-create/InlineGroup.tsx`

## Step 4: 替换 BookFormCard

**当前**：`src/components/chat/BookFormCard.tsx` — 自建的 tool call 表单

**改为**：用 ai-elements 的 `Tool` + `Confirmation` 组件包装，内部表单字段保留自建（ai-elements 不提供自动表单生成）。

```tsx
import { Tool } from "../ui/tool";
import { Confirmation } from "../ui/confirmation";

<Tool name="create_book">
  {/* 自建表单字段：title, genre, platform, chapters, brief */}
  <FormFields args={args} onChange={onArgsChange} disabled={confirming} />
  <Confirmation
    onConfirm={onConfirm}
    loading={confirming}
    label="开始写这本书"
  />
</Tool>
```

**涉及文件**：
- 重写：`src/components/chat/BookFormCard.tsx`

## Step 5: 替换 ChatPage 输入区

**当前**：ChatPage 底部自建的 textarea + 发送按钮

**改为**：用 ai-elements 的 `PromptInput` 组件。

```tsx
import { PromptInput } from "../ui/prompt-input";

<PromptInput
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  disabled={loading}
  placeholder="输入指令..."
/>
```

**涉及文件**：
- 修改：`src/pages/ChatPage.tsx`（替换底部输入区）

## Step 6: 验证 + 清理

1. `pnpm --filter @actalk/inkos-studio typecheck`
2. `pnpm --filter @actalk/inkos-studio test`
3. `pnpm --filter @actalk/inkos-studio build`
4. 启动 Studio 端到端测试
5. 删除不再使用的自建组件文件
6. 提交

## 依赖关系

```
Step 1 (shadcn init)
  ↓
Step 2 (ai-elements add)
  ↓
Step 3 (ChatMessage) ─┐
Step 4 (BookFormCard) ─┼─ 可并行
Step 5 (PromptInput) ──┘
  ↓
Step 6 (验证清理)
```

## 风险

1. **shadcn init 可能改动 index.css** — 需要确保不覆盖 Studio 的自定义主题。init 后立即 git diff 检查。
2. **ai-elements 组件的内部样式** — 可能引入额外的 CSS class 或硬编码颜色。需要逐个检查生成的组件文件。
3. **base-ui 版本兼容** — Studio 现有的 @base-ui/react 版本和 shadcn 要求的版本可能不同。检查 package.json。
