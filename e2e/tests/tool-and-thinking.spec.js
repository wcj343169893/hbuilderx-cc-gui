'use strict';

/**
 * 回归：工具调用卡片 + 思考块渲染。
 *
 * 链路：
 *   - 思考：[THINKING_DELTA] → assembler._handleThinkingDelta → onThinkingDelta
 *     → 前端 .thinking-block / .thinking-content 渲染。
 *   - 工具：[MESSAGE]{tool_use} → assembler._handleAssistantMessage 合并 tool_use 块
 *     → updateMessages；[TOOL_RESULT] → 追加 [tool_result] 用户消息。
 *     前端 ContentBlockRenderer 把 tool_use 渲成工具卡片（通用工具 → GenericToolBlock
 *     的 .task-container + .tool-status-indicator）；findToolResult 命中结果 → completed。
 *
 * 工具名用 WebFetch（归一化后不在 Edit/Bash/Agent/TaskManage/Transient 任一集合，走 GenericToolBlock）。
 */

const { test, expect, Lines } = require('../harness/fixtures');

test.describe('工具调用卡片 + 思考块渲染', () => {
  test('思考块渲染：助手气泡内出现 .thinking-block 且含思考内容', async ({ app }) => {
    const { ui, daemon } = app;
    await expect(ui.input).toBeVisible();

    await ui.sendMessage('先想一下再回答');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.thinkingDelta('让我先拆解一下这个问题，'),
      Lines.thinkingDelta('再决定怎么回答。'),
      Lines.contentDelta('答案是 42。'),
      Lines.STREAM_END,
    ]);

    const assistant = ui.assistantMessages.first();
    const thinking = assistant.locator('.thinking-block');
    await expect(thinking).toHaveCount(1);
    // .thinking-content 可能默认折叠（display:none），用 textContent 断言不依赖可见性
    await expect(thinking.locator('.thinking-content')).toContainText('让我先拆解一下这个问题，再决定怎么回答。');
    // 正文与思考并存
    await expect(assistant).toContainText('答案是 42。');
  });

  test('工具卡片：有 tool_result → completed', async ({ app }) => {
    const { ui, daemon } = app;
    await ui.sendMessage('帮我抓个网页');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('好的，我来抓取。'),
      Lines.toolUseMessage('tu-fetch-ok', 'WebFetch', { url: 'https://example.test/page' }),
      Lines.toolResult('tu-fetch-ok', '抓取成功：状态 200'),
      Lines.contentDelta('抓取完成。'),
      Lines.STREAM_END,
    ]);

    const card = ui.assistantMessages.first().locator('.task-container');
    await expect(card).toHaveCount(1);
    // 结果已回 → completed，且不再是 pending
    await expect(card.locator('.tool-status-indicator.completed')).toHaveCount(1);
    await expect(card.locator('.tool-status-indicator.pending')).toHaveCount(0);
    await expect(ui.assistantMessages.first()).toContainText('抓取完成。');
  });

  test('工具卡片：结果晚到 → 从 pending 切换到 completed', async ({ app }) => {
    const { ui, daemon } = app;
    await ui.sendMessage('帮我抓个慢网页');

    // 第一阶段：只发起工具调用，结果尚未返回（模拟工具执行中）。
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('好的，开始抓取。'),
      Lines.toolUseMessage('tu-fetch-slow', 'WebFetch', { url: 'https://slow.test' }),
    ]);
    const card = ui.assistantMessages.first().locator('.task-container');
    await expect(card).toHaveCount(1);
    // 结果未回 → pending
    await expect(card.locator('.tool-status-indicator.pending')).toHaveCount(1);

    // 第二阶段：结果晚到 + 收尾文本 + 整轮结束。
    await daemon.feedLines([
      Lines.toolResult('tu-fetch-slow', '抓取成功：状态 200'),
      Lines.contentDelta('抓取完成。'),
      Lines.STREAM_END,
    ]);

    // 结果到达后切换为 completed，不再 pending
    await expect(card.locator('.tool-status-indicator.completed')).toHaveCount(1);
    await expect(card.locator('.tool-status-indicator.pending')).toHaveCount(0);
    await expect(ui.assistantMessages.first()).toContainText('抓取完成。');
  });
});
