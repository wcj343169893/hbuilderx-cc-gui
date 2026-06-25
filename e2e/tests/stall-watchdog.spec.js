'use strict';

/**
 * 回归：工具执行期倒计时保活 / stall 看门狗（修复版本 0.1.7）。
 *
 * 背景（见记忆 stream-end-once-per-turn）：
 *   daemon 整轮只发一次 [STREAM_END]，工具调用 / 等待授权期间对 stdout 完全静默。
 *   前端 streamingCallbacks 的 stall 看门狗（STREAM_STALL_TIMEOUT_MS=60s）靠
 *   __lastStreamActivityAt 判活，静默超 60s 会误判 onStreamEnd 丢失 → 强制收尾，
 *   导致倒计时提前停、后续 delta 被 `if(!isStreamingRef.current)return` 丢弃。
 *   修复：message-router 在请求在途期间每 10s 发一次 onStreamingHeartbeat 保活。
 *
 * 这里用 page.clock 把时间推进做成确定性的：
 *   - 正向用例：100s 工具静默 + 每 10s 心跳 → 倒计时不停、后续 delta 不丢。
 *   - 兜底用例：65s 真静默且无心跳 → 看门狗按设计强制收尾（安全网仍在）。
 */

const { test, expect, Lines } = require('../harness/fixtures');

test.describe('stall 看门狗 / 工具执行期倒计时保活 (0.1.7)', () => {
  // 必须在 goto 前 install clock，让 onStreamStart 注册的看门狗 setInterval 走假时钟。
  test.use({ clockEnabled: true });
  // 时钟推进会驱动一连串假定时器 + React 重渲染，给宽松超时避免误判。
  test.describe.configure({ timeout: 60_000 });

  test('工具静默 100s + 心跳保活 → 倒计时不提前停、后续 delta 不丢', async ({ app, page }) => {
    const { ui, daemon } = app;
    await expect(ui.input).toBeVisible();

    await ui.sendMessage('帮我跑个命令');
    await expect(ui.userMessages).toHaveCount(1);

    // 一轮开始：流开始 → 工具前的文本 → 工具调用（此后 daemon 静默）
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.sessionId('sess-stall-keepalive'),
      Lines.contentDelta('正在处理'),
      Lines.toolUseMessage('tu-keepalive', 'WebFetch', { url: 'https://example.test' }),
    ]);

    // 倒计时出现（loading=true → WaitingIndicator 渲染）
    await expect(ui.waitingIndicator).toHaveCount(1);

    // 模拟工具执行期 100s 完全静默，但 router 每 10s 发一次心跳（10×10s=100s）。
    // 每次心跳把 __lastStreamActivityAt 顶到当前假时刻，看门狗每 5s 检查时
    // 相邻心跳间隔 ≤10s，永远到不了 60s 阈值。
    // 用 fastForward（跳跃推进、due 定时器最多触发一次）而非 runFor，避免被
    // WaitingIndicator 的 500ms 省略号动画等中间定时器拖成几十秒真实耗时。
    for (let i = 0; i < 10; i++) {
      await page.clock.fastForward(10_000);
      await daemon.emitHeartbeat();
    }

    // 关键断言：倒计时仍在（没被 stall 看门狗误杀）
    await expect(ui.waitingIndicator).toHaveCount(1);

    // 工具结果回来 + 收尾文本 + 整轮结束
    await daemon.feedLines([
      Lines.toolResult('tu-keepalive', '执行成功'),
      Lines.contentDelta('处理完成。'),
      Lines.STREAM_END,
    ]);

    // 关键断言：静默之后到达的 delta 仍被渲染。
    // 若看门狗提前杀流，isStreamingRef=false 会把这段 onContentDelta 丢弃，断言会失败。
    await expect(ui.assistantMessages.first()).toContainText('处理完成。');
    // 整轮结束后倒计时消失
    await expect(ui.waitingIndicator).toHaveCount(0);
  });

  test('真静默超 60s 且无心跳 → 看门狗兜底强制收尾（安全网仍在）', async ({ app, page }) => {
    const { ui, daemon } = app;
    await ui.sendMessage('跑个会卡住的命令');

    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('正在处理'),
      Lines.toolUseMessage('tu-genuine-stall', 'WebFetch', { url: 'https://stuck.test' }),
    ]);
    await expect(ui.waitingIndicator).toHaveCount(1);

    // 65s 完全静默、无任何心跳 → 看门狗（60s 阈值，每 5s 检查）强制 onStreamEnd。
    await page.clock.fastForward(65_000);

    // 倒计时被兜底收尾
    await expect(ui.waitingIndicator).toHaveCount(0);

    // 看门狗收尾后到达的 delta 会被前端丢弃（流已被判定结束）
    await daemon.feedLines([Lines.contentDelta('这段应被丢弃')]);
    await page.clock.runFor(100); // 推进假时钟，给（不会发生的）rAF 一个机会
    await expect(ui.assistantMessages.first()).not.toContainText('这段应被丢弃');
    // 收尾前已渲染的文本仍在
    await expect(ui.assistantMessages.first()).toContainText('正在处理');
  });
});
