'use strict';

/**
 * 回归：上下文用量百分比（修复版本 0.1.5「上下文用量一直显示 0%」）。
 *
 * 链路：daemon [USAGE] 行 → stream-adapter → assembler._handleUsage 按当前模型
 *   上下文窗口换算百分比（宿主侧算好）→ callJs('onUsageUpdate', {percentage,...})
 *   → 前端 usageModeCallbacks.onUsageUpdate → setUsagePercentage
 *   → ContextBar / TokenIndicator 的 .token-percentage-label 显示「N%」。
 *
 * 窗口口径：前端 longContextEnabled 默认 true，opus 支持 [1m]，发送时模型带上 [1m]
 *   后缀（daemon 收到 set_model 'claude-opus-4-8[1m]'）→ 宿主按 1,000,000 窗口换算。
 *   故 used 300000 → round(300000*100/1000000)=30 → 显示「30%」。
 *   （这正是默认 UI 下用户实际看到的口径。）
 */

const { test, expect, Lines } = require('../harness/fixtures');

const WINDOW = 1_000_000; // 默认长上下文窗口（见上）
const pct = (used) => `${Math.round((used * 100) / WINDOW)}%`;

test.describe('上下文用量百分比 (0.1.5)', () => {
  test('收到 usage 后顶部占比从 0% 更新为正确值，而非卡在 0%', async ({ app }) => {
    const { ui, daemon, page } = app;
    await expect(ui.input).toBeVisible();

    const label = page.locator('.context-token-indicator .token-percentage-label');
    // 初始（未产生任何 usage）应为 0%
    await expect(label).toHaveText('0%');

    // 一轮带 usage 的回复：used = 250000 + 50000 = 300000
    await ui.sendMessage('帮我统计一下');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('统计如下。'),
      Lines.usage({ input_tokens: 250000, output_tokens: 50000 }),
      Lines.STREAM_END,
    ]);

    // 关键断言：占比按窗口换算为 30%，不再卡在 0%
    await expect(label).toHaveText(pct(300000)); // 30%
  });

  test('多次 usage 累计后占比随之变化', async ({ app }) => {
    const { ui, daemon, page } = app;
    const label = page.locator('.context-token-indicator .token-percentage-label');

    await ui.sendMessage('第一次');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('好。'),
      Lines.usage({ input_tokens: 100000, output_tokens: 0 }), // used 100000 → 10%
      Lines.STREAM_END,
    ]);
    await expect(label).toHaveText(pct(100000)); // 10%

    // usage 是「整轮累计快照」而非增量：第二轮上报更大的累计值 → 占比上升
    await ui.sendMessage('第二次');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.contentDelta('再好。'),
      Lines.usage({ input_tokens: 700000, output_tokens: 50000 }), // used 750000 → 75%
      Lines.STREAM_END,
    ]);
    await expect(label).toHaveText(pct(750000)); // 75%
  });
});
