# 既有测试失败清单（与资源通道瘦身无关，需单独修）

- 日期：2026-09-12
- 来源：做 webview 产物瘦身（`docs/plans/2026-09-12-webview-asset-splitting.md`）时跑全量测试发现
- 均已核对**在改动前的基线上同样失败**，属于历史遗留
- 排期：归入移植方案的 **B0（前置清理）**，与 26 个契约缺口同批修
- **状态（2026-09-13）：三项已全部修复**，详见各节末尾的「修复」说明；
  `cd webview && npm test`、`cd e2e && npm test`、`node --test hbuilderx-plugin/lib/*.test.js`、
  `node hbuilderx-plugin/scripts/check-message-contracts.js` 中前三者已全绿
  （契约缺口清零见 B0b，尚未开始）。

> 为什么要专门记下来：这三项红着，意味着 `npm test`（vitest + tsc 两段）与 e2e 套件现在**都不是可信门禁**。
> 后续 10 个移植批次要靠它们把关「这一批有没有弄坏东西」，所以得先让基线变绿。

---

## 1. `ModelSelect` 单测过时（测试问题，不是产品 bug）

**复现**
```bash
cd webview && npx vitest run src/components/ChatInputBox/selectors/ModelSelect.test.tsx
```
```
× ModelSelect > rerender 后应读取最新的 Claude 模型映射
  → expected 'Zhipuglm-4 (models.longContext.shortLabel)' to contain 'glm-5'
```

**定位**

`ModelSelect.tsx:145` 的映射是 `useState(() => readClaudeModelMapping())` 初始化的，之后**只在收到
`localStorageChange` CustomEvent 时刷新**（`:149`–`:154`）。测试直接 `localStorage.setItem` 再 rerender，
没有派发该事件，所以组件仍显示旧映射 `glm-4`。

生产链路是自洽的：写入走 `webview/src/utils/claudeModelMapping.ts:43`，写完在 `:50` 派发
`localStorageChange`。这正是 0.2.2 那条修复「CC Switch 切换供应商后模型标签不更新」的机制
（见 `version/changelog.ts:88`）。换句话说：**产品代码对，测试没跟上机制变化。**

**建议修法**

改测试，二选一：
- 用生产写入函数（`claudeModelMapping.ts` 的写入 API）替代裸 `localStorage.setItem`（更推荐，顺带覆盖真实路径）
- 或 `setItem` 后补一句
  `window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key: STORAGE_KEYS.CLAUDE_MODEL_MAPPING } }))`

**不要**改成监听原生 `storage` 事件——同窗口内写入不触发它，改了等于把这个修复废掉。

**顺带说明**：断言里的 `Zhipu` 前缀和原样输出的 `models.longContext.shortLabel`，是该测试把 `t` mock 成
「直接返回 key」造成的，不是 i18n 缺键。

**修复（2026-09-13）**：采用建议修法的第一种——第二次 `setItem` 改为调用生产写入函数
`writeClaudeModelMapping({ sonnet: 'glm-5' })`（并用 `act()` 包裹以消除 React act 警告）。
见 `webview/src/components/ChatInputBox/selectors/ModelSelect.test.tsx`。

---

## 2. e2e `resume-replay` 幽灵气泡（疑似真实缺陷，时序敏感）

**复现**
```bash
cd e2e && npx playwright install && npx playwright test tests/resume-replay.spec.js
```
```
× resume 全量回放去重 > 回放历史 assistant/tool_result 不产生幽灵气泡或重复
  at tests/resume-replay.spec.js:34  expect(ui.assistantMessages).toHaveCount(1)
  Received: 3（瘦身前基线） / 2（瘦身后）
```

**为什么判它是真缺陷而不是断言过时**

失败发生在**第一轮**（`contentDelta → tool_use → tool_result → contentDelta → STREAM_END`）之后，
这一轮本该只有 1 个助手气泡；而且气泡数会随构建/时序变化（基线 3 个、瘦身后 2 个）。
计数对时序敏感 → 指向装配器或前端合并守卫的时序缺陷，和历史上修过的
「多轮对话气泡错乱」「同会话追问气泡串台」属同一问题域。

**定位第一步：先排除浏览器版本差异**

这次是用容器预装的 Chromium 1194 跑的，而项目锁 `@playwright/test` 1.52（配套浏览器 1169）。
先在锁定浏览器上复现，确认不是版本差异；能复现再往下查。

**建议排查顺序**

1. `hbuilderx-plugin/lib/claude-session.js` 的 `_handleAssistantMessage` / `_ensureAssistant`：
   在 `tool_use → tool_result → 再 contentDelta` 序列里是否会二次建泡
2. 前端 `webview/src/hooks/useStreamingMessages.ts` 的 stale-streaming 合并守卫是否依赖 rAF 时序
   （时序一变计数就变，符合这个猜测）

**关联风险**：「消息插队 v2（插入当前回合）」要改的正是这块代码
（见 `docs/plans/2026-09-12-message-interject-design.md` 第三节风险）。**建议先修这条，再做 v2**，
否则分不清新问题是插队引入的还是本来就有的。

**修复（2026-09-13）**：确认是真缺陷，根因正是上面排查建议的第 2 条——
`useStreamingMessages.ts` 的 `getOrCreateStreamingAssistantIndex`。

复现时断言失败点已变为第二轮（`tests/resume-replay.spec.js:59`，`Received: 3`）而非文档写下时的
第一轮 `:34`——测试脚本在 2026-09-12~13 间被加强过（新增了第二轮的历史回放批次），但根因和排查方向
不受影响，同一个函数命中同一个 bug。

**根因**：该函数用「当前流式助手之后是否存在 `type==='user'` 的消息」来判断“是否有新用户提问打断了本轮
流式回复”，从而决定是复用现有占位助手气泡还是新建一个。但 `tool_result` 在本仓库的消息模型里也是
`type: 'user'`（SDK 的 user-role 工具结果回复），而且**在同一轮里**天然紧跟在触发它的 assistant 消息
之后。于是「本轮工具调用刚返回结果」被误判成「用户发了新消息、旧助手气泡已过期」，凭空新建第三个
占位助手气泡，并把 `streamingContentRef` 里累积的全部文本又摊了一份进去（幽灵气泡）。

**修法**：判断时排除 tool_result 型的 user 消息，复用已有工具函数
`webview/src/utils/turnScope.ts` 的 `isToolResultOnlyUserMessage`（`[tool_result]` 占位内容 /
`raw` 里含 `type==='tool_result'` 块），而不是自己再写一遍等价逻辑。
见 `webview/src/hooks/useStreamingMessages.ts` 的 `getOrCreateStreamingAssistantIndex`。

---

## 3. 测试目录类型检查报错（`npm test` 第二段必然失败）

**复现**
```bash
cd webview && npx tsc -p tsconfig.test.json --noEmit
```
```
src/hooks/useMessageSender.context.test.ts(8,105): error TS2322:
  Types of property 'codexFastMode' are incompatible.
    Type 'CodexFastMode | undefined' is not assignable to type 'CodexFastMode'.
```

**定位**

测试里的 `createOptions(overrides: Partial<UseMessageSenderOptions> = {})` 把 `Partial` 展开到完整对象上，
TS 会把所有被覆盖字段放宽成「可能 undefined」；而 `useMessageSender.ts:44` 的 `codexFastMode` 是必填。
该文件最后一次改动在提交 `89508ba6`（上游来源的「把 reasoning effort 传给 SDK」）。

**影响**：`npm test` 是 `vitest run && tsc -p tsconfig.test.json --noEmit`，第二段一直红 →
这道类型门禁目前形同虚设。

**建议修法**：测试侧收口即可，产品类型不动——
`return { ...base, ...overrides } as UseMessageSenderOptions`，或给 `createOptions` 标注返回类型并显式补齐字段。

**修复（2026-09-13）**：`createOptions` 的基础对象字面量本来就漏填了 `codexFastMode`（只能靠
`overrides` 补，而 `overrides` 是 `Partial<...>`，该字段类型自然带 `| undefined`）。直接在基础对象里
补上默认值 `codexFastMode: 'normal'`（对齐 `CodexFastMode = 'normal' | 'fast'` 与
`useModelStatePersistence.ts` 的默认值），无需类型断言这种绕过检查的写法。

---

## 收口动作

1. ~~三项修完，确认 `cd webview && npm test`、`cd e2e && npm test`、
   `node hbuilderx-plugin/scripts/check-message-contracts.js`、
   `node --test hbuilderx-plugin/lib/*.test.js` 全绿~~ —— **已完成（2026-09-13）**：
   `webview npm test`（vitest 84 files/679 tests + tsc）、`e2e npm test`（12 tests）、
   `node --test hbuilderx-plugin/lib/*.test.js`（5 tests）均已全绿。
   契约校验脚本仍是 26 个缺口（B0b 尚未开始，不属于本清单范围）。
2. 把它们接进 `.github/workflows` 作为 PR 门禁（移植方案 B0 已列此项，即 B0c）——
   门禁必须在基线全绿之后才有意义，现在满足前提，可以开始
3. ~~第 2 条修好前，不要开始「消息插队 v2」~~ —— 幽灵气泡根因已修复，「消息插队 v2」的前置阻塞已解除
