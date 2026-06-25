'use strict';

/**
 * 回归：同会话多轮追问的气泡归属（修复版本 0.1.6「同会话追问气泡串台」）。
 *
 * 根因（见 claude-session.js addUserMessage 注释）：装配器是跨轮复用的单例，
 *   若新一轮开始时不复位「单轮累积态」（currentAssistant 等），本轮回复会并入
 *   上一条助手气泡。修复：addUserMessage 先 _beginTurn() 复位单轮态，并配合前端
 *   merge 守卫（__lastStreamEndedTurnId）保证两轮各自成泡、不串台。
 *
 * 断言整轮结束后的最终状态：2 用户 + 2 助手，且各自气泡只含本轮内容。
 */

const { test, expect, Lines } = require('../harness/fixtures');

test.describe('同会话多轮追问气泡归属 (0.1.6)', () => {
  test('两轮问答各自成泡，回复不并入上一条助手气泡', async ({ app }) => {
    const { ui, daemon } = app;
    await expect(ui.input).toBeVisible();

    // —— 第一轮 ——
    await ui.sendMessage('第一个问题');
    await expect(ui.userMessages).toHaveCount(1);
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.sessionId('sess-multiturn'),
      Lines.contentDelta('这是第一轮的回答。'),
      Lines.STREAM_END,
    ]);
    await expect(ui.assistantMessages).toHaveCount(1);
    await expect(ui.assistantMessages.nth(0)).toContainText('这是第一轮的回答。');

    // —— 第二轮（同会话追问）——
    await ui.sendMessage('第二个问题');
    await expect(ui.userMessages).toHaveCount(2);
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('这是第二轮的回答。'),
      Lines.STREAM_END,
    ]);

    // 关键断言：第二轮回复进入新气泡，总计 2 助手气泡
    await expect(ui.assistantMessages).toHaveCount(2);

    // 第一条助手气泡保持原样、不被第二轮污染
    await expect(ui.assistantMessages.nth(0)).toContainText('这是第一轮的回答。');
    await expect(ui.assistantMessages.nth(0)).not.toContainText('这是第二轮的回答。');

    // 第二条助手气泡只含第二轮内容，不串入第一轮
    await expect(ui.assistantMessages.nth(1)).toContainText('这是第二轮的回答。');
    await expect(ui.assistantMessages.nth(1)).not.toContainText('这是第一轮的回答。');

    // 用户气泡顺序正确
    await expect(ui.userMessages.nth(0)).toContainText('第一个问题');
    await expect(ui.userMessages.nth(1)).toContainText('第二个问题');

    // 整轮结束后倒计时消失
    await expect(ui.waitingIndicator).toHaveCount(0);
  });
});
