'use strict';

/**
 * 回归：SDK runtime 中途重建后 `resume` 全量回放历史，装配器不应产生「幽灵气泡」或重复 tool_result。
 *
 * 根因（见 claude-session.js _handleAssistantMessage / _handleToolResult 的 resume 去重注释）：
 *   daemon 对「含 tool_use 的历史 assistant」与历史 tool_result 都会重发 [MESSAGE]。HBuilderX 装配器
 *   是 MVP，没移植 IDEA 的 ReplayDeduplicator → 历史 assistant 被 _ensureAssistant 重建成空气泡、
 *   历史 tool_result 被重复 push，导致两轮回答合并成一个气泡、工具卡片重复。
 * 修复：按 tool_use id 识别历史重放并跳过。
 *
 * 断言：第二轮（含 resume 回放）后仍是 2 用户 + 2 助手气泡，各自只含本轮内容。
 */

const { test, expect, Lines } = require('../harness/fixtures');

test.describe('resume 全量回放去重', () => {
  test('回放历史 assistant/tool_result 不产生幽灵气泡或重复', async ({ app }) => {
    const { ui, daemon } = app;
    await expect(ui.input).toBeVisible();

    // —— 第一轮：带工具 ——
    await ui.sendMessage('Q1 列出文件');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.sessionId('sess-replay'),
      Lines.contentDelta('我来列出。'),
      Lines.toolUseMessage('tool1', 'Bash', { command: 'ls' }),
      Lines.toolResult('tool1', 'a.txt'),
      Lines.contentDelta('有 a.txt。'),
      Lines.STREAM_END,
    ]);
    await expect(ui.userMessages).toHaveCount(1);
    await expect(ui.assistantMessages).toHaveCount(1);
    await app.page.waitForTimeout(150); // 模拟用户两轮之间的真实间隔（≠ 同步连发）

    // —— 第二轮：runtime 重建 → resume 全量回放历史（含 tool_use 的 assistant + tool_result），再生成新内容 ——
    await ui.sendMessage('Q2 删除文件');
    // 历史重放先到（daemon 规则：user / tool_result 总发 [MESSAGE]；assistant 仅含 tool_use 时发）
    await daemon.feedLines([
      Lines.STREAM_START,
      '[MESSAGE] ' + JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'Q1 列出文件' }] } }),
      '[MESSAGE] ' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '我来列出。' }, { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'ls' } }] } }),
      '[MESSAGE] ' + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'a.txt' }] } }),
      '[MESSAGE] ' + JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'Q2 删除文件' }] } }),
    ]);
    await app.page.waitForTimeout(150); // 回放突发与本轮新增量之间的真实异步间隔
    // 本轮新内容
    await daemon.feedLines([
      Lines.contentDelta('好的，正在删除。'),
      Lines.toolUseMessage('tool2', 'Bash', { command: 'rm a.txt' }),
      Lines.toolResult('tool2', ''),
      Lines.contentDelta('已删除。'),
      Lines.STREAM_END,
    ]);

    // 关键断言：两轮各自成泡，回放未制造幽灵气泡
    await expect(ui.userMessages).toHaveCount(2);
    await expect(ui.assistantMessages).toHaveCount(2);

    // 提问顺序与内容正确
    await expect(ui.userMessages.nth(0)).toContainText('Q1 列出文件');
    await expect(ui.userMessages.nth(1)).toContainText('Q2 删除文件');

    // 第二轮助手气泡只含本轮内容，不串入第一轮
    await expect(ui.assistantMessages.nth(1)).toContainText('已删除。');
    await expect(ui.assistantMessages.nth(1)).not.toContainText('有 a.txt。');
  });
});
