# 消息插队（排队 / 插入当前回合）设计方案

- 日期：2026-09-12
- 来源：用户建议「增加消息插队功能」
- 结论速览：**前端队列的基础设施已经存在，但入口是死代码**——AI 运行中回车被拦、发送按钮被 Stop 取代，`enqueue` 永远不会被调用。上游 v0.5.5 也是同样状态。因此 v1 是「接通最后一公里」，成本很低；真正的「插入当前回合」是 v2，仅 Claude 链路可行，需先做 spike。

---

## 一、现状核查（已逐处确认）

### 已经有的

| 能力 | 位置 |
|---|---|
| 队列数据结构 + 自动续发（`loading` 由 true→false 时取队首执行） | `webview/src/hooks/useMessageQueue.ts` |
| 队列 UI（输入框上方编号 chips、单条删除） | `webview/src/components/ChatInputBox/MessageQueue.tsx`，由 `ChatInputBoxHeader.tsx:113` 渲染 |
| 「运行中则入队」分支 | `webview/src/App.tsx:417` → `enqueueMessage(content, attachments)` |
| 队列消费出口 | `App.tsx:384` → `useMessageQueue({ isLoading: loading, onExecute: executeMessage })` |

### 为什么用户感觉「没有这个功能」

入口全被 `isLoading` 挡死，`App.tsx:417` 这条分支实际不可达：

| 拦截点 | 位置 | 行为 |
|---|---|---|
| 回车键 | `ChatInputBox.tsx:667` `if (!isLoading && !isComposingRef.current) handleSubmit()` | 运行中按回车**什么都不发生** |
| IDE 快捷键发送 | `ChatInputBox.tsx:510` 同样的 `!isLoading` 判断 | 同上 |
| 发送按钮 | `ChatInputBoxFooter.tsx:106` `disabled={disabled || isLoading}`；`ButtonArea.tsx:296` 运行中把发送按钮整体换成 Stop | 运行中**没有发送按钮可点** |

上游（v0.5.5）对应代码完全一致 → 这不是移植丢失，而是上游自身的未完成特性。**v1 实现后可以回流 PR 给上游**，按移植方案第七节「优先在上游修」的原则，能顺带降低后续 merge 冲突面。

### 后端支持程度（决定 v2 的边界）

| 引擎 | 机制 | 能否插入「正在进行的回合」 |
|---|---|---|
| Claude | 常驻 runtime，SDK 的 `prompt` 是一个 `AsyncStream`（`runtime-lifecycle.js:139` 创建、`:205` 传入），`executeTurn` 用 `runtime.inputStream.enqueue(userMessage)` 投喂（`persistent-query-service.js:272`） | **技术上可行**：向同一个 `inputStream` 再 enqueue 一条即可，无需新进程。但 SDK/CLI 的语义（当前轮吸收 = steering，还是排在 `result` 之后作为下一轮）**必须实测确认** |
| Codex | `codex.startThread()` / `resumeThread()` 后一次 `run`（`services/codex/message-service.js`） | **不可行**，回合是离散的，只能排队到回合结束 |
| 其他 CLI（Grok/Kimi/OpenCode/PI/OMP/DSH，移植后） | 各自 daemon/ACP 协议 | 待移植后逐个评估，默认降级为排队 |

另一个硬约束：`executeTurn` 独占 `runtime.query` 这个迭代器。**绝不能为插队再起一个并发 `executeTurn`**——两个循环从同一迭代器读会互相吞消息。插队必须是「向当前回合的 inputStream 投喂」，而不是「并发发起第二个请求」。

---

## 二、v1：排队（queue）——建议先做

语义：AI 运行中输入的消息变成队列 chip，**当前回合正常结束后自动发出**。对所有引擎一致可用，纯前端改动，不新增前后端契约事件，不需要 `message-router.js` 补 case。

### 交互设计

1. 运行中回车 = **加入队列**（保留 Shift+Enter 换行、IME 合成期不触发）；放开 `ChatInputBox.tsx:667` 与 `:510` 的 `isLoading` 拦截，改为「运行中走入队分支」。
2. Stop 按钮保持为主按钮（中断仍是一等操作）；运行中且输入框有内容时，在 Stop 旁显示一个次级「加入队列」按钮，icon + tooltip，首次使用给一次性提示。
3. chips 复用现有 `MessageQueue`：编号、预览、删除。v1 不做拖拽排序和原地编辑（删了重输即可）。
4. 队列上限 10 条，超出时 toast 提示并拒绝入队（防误粘贴长文刷屏）。
5. 文案与 10 种语言 i18n key 一起加（`chat.queue.*`）。

### 行为规则（需要明确定调的边界）

| 场景 | v1 行为 |
|---|---|
| 回合正常结束（收到 `result`） | 自动发出队首，逐条继续（现有 `useMessageQueue` 逻辑） |
| **用户手动中断（Stop）** | **不自动续发**，chips 保留并置为「已暂停」，提示用户点发送继续。理由：中断是用户主动改变意图，紧接着自动发一条旧消息很可能不是他想要的；本仓库也有过「中断后再发送看不到回复」的历史坑，不要让自动续发撞在中断收尾上 |
| 回合报错 / runtime 终止 | 同中断：保留队列、不自动续发 |
| 切换会话 / 新建会话 / 加载历史 / 切换 provider | 清空队列并 toast 告知（避免跨会话误发）|
| `/` 本地命令（`/context`、`/compact` 等） | 按现有「本地命令不受 loading 限制」分支**即时执行**，不入队 |
| 带附件 | 入队时保留 `attachments`（hook 已支持），文件内容仍按**发送时**读取 |
| webview 重载 / 面板重开 | 队列按 sessionId 持久化到 localStorage 并恢复；会话结束或清空时清理 |
| 与 DeepSeek 峰谷队列的关系 | 串联而非并列：消息队列是**出口在前**，峰谷守卫在后（队列放行的消息再进峰谷判断）。两套 UI 要能同时解释清楚状态，文案上区分「等待上一条完成」与「等待低峰时段」 |

### 验收

- `e2e/` 新增回归：运行中回车 → 出现 chip → 回合结束 → 自动发出、chip 消失；中断后 chip 保留且不自动发
- `useMessageQueue` 单测补：上限、清空时机、中断不续发
- `node hbuilderx-plugin/scripts/check-message-contracts.js` 不新增缺口（v1 不加事件，应保持不变）
- 手工：Claude / Codex / DeepSeek 三条链路各走一遍

### 工作量

约 0.5~1 人日（含 i18n 与 e2e）。

---

## 三、v2：插入当前回合（Claude only）——先 spike 再决定

语义：运行中发出的消息**立刻进入当前回合**，让模型马上看到（纠偏/补充约束），而不是等回合结束。

### 必做 spike（先验证，再动手）

验证 Claude SDK 对「回合进行中向 `inputStream` 再 enqueue」的实际语义：

1. 起一个长任务（例如「从 1 数到 100，每个数字单独一行，慢一点」）。
2. 流式进行到中途，调用 `runtime.inputStream.enqueue(buildUserMessage({ content: '改成只数到 5' }))`。
3. 观察 daemon stdout 的事件序列：模型是否在本轮内改变行为（steering 成立），还是直到 `result` 之后才作为下一轮处理（等价于 v1 排队，只是省了进程开销）。

spike 结论决定 v2 是否还有独立价值：若 SDK 只在 `result` 后消费，则 v2 退化为「队列提速」，收益有限，应直接停在 v1。

### 如果 spike 成立，实现要点

- 新增契约事件（如 `inject_user_message`）：`message-router.js` 补 case → `claude-session.js` → daemon → `persistent-query-service.js` 新导出 `injectIntoCurrentTurn(params)`。
- 实现只做一件事：对 `getActiveTurnRuntime()` 的 `inputStream.enqueue(await buildUserMessage(...))`。**不得**调用 `sendInternal` / 新建 `executeTurn`。
- 无进行中回合时，自动降级为 v1 入队（同一个前端入口，语义由后端当前状态决定）。
- 非 Claude 引擎：直接降级为 v1 排队，UI 文案区分「插入当前回合」与「排队等待」，不要让用户以为 Codex 也能插队。
- 设置项开关，默认**关闭**，灰度验证后再考虑默认开启。

### 风险（这是本仓库的历史雷区，必须正面处理）

- **气泡顺序**：注入的 user 气泡要插在流式 assistant 气泡之间，正是本仓库修过的「多轮对话气泡错乱」「同会话追问气泡串台」问题域。必须复用 `useStreamingMessages` 现有的 stale-streaming 检测与占位逻辑，不要另起一套渲染路径。
- **用量/计费归属**：注入后本轮的 token 统计与「每条消息 token」指示器要确认归属正确，否则用量面板会错。
- **权限弹窗/中断交织**：注入时可能正有待确认的权限请求或中断在收尾，要定义优先级（建议：有待确认权限时先排队，不立即注入）。
- **上游冲突面**：v2 会改 `ai-bridge/services/claude/*` 与 `webview` 流式渲染，这两处都是上游高频改动区（v0.4.6~v0.5.5 期间 `persistent-query-service.js` 上游动了 300+ 行）。建议 v2 排在移植批次 B5 之后做，或实现后立刻回流上游，避免长期分叉。

### 工作量

spike 0.5 人日；spike 成立则实现 2~4 人日（含气泡顺序与用量回归）。

---

## 四、建议

1. **先做 v1**，它覆盖了「我想在它跑的时候先把下一句说了」这个诉求的绝大部分价值，风险低、不碰流式渲染、不加契约事件。
2. v1 完成后回流 PR 到上游，减少后续 merge 冲突。
3. v2 先只做 spike，把 SDK 语义结论写回本文档；结论不成立就明确放弃，别留半成品。
4. 排期上 v1 可以插在移植方案的 B0 与 B1 之间（独立于 merge，不会和批次冲突）；v2 放到 B5 之后。
