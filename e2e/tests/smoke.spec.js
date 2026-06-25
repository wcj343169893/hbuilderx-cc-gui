'use strict';

const { test, expect, Lines } = require('../harness/fixtures');

test.describe('冒烟：链路打通', () => {
  test('页面加载、bootstrap、发消息、流式渲染助手回复', async ({ app }) => {
    const { ui, daemon } = app;

    // 输入框可见（应用已挂载、SDK 就绪）
    await expect(ui.input).toBeVisible();

    // 发一条消息
    const sendContent = await ui.sendMessage('你好，介绍一下你自己');
    expect(sendContent).toContain('你好');

    // 用户气泡出现
    await expect(ui.userMessages).toHaveCount(1);
    await expect(ui.userMessages.first()).toContainText('你好，介绍一下你自己');

    // 脚本化回放一轮助手回复
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.sessionId('test-session-1'),
      Lines.contentDelta('我是'),
      Lines.contentDelta('Claude'),
      Lines.contentDelta('，很高兴见到你。'),
      Lines.usage({ input_tokens: 1200, output_tokens: 300 }),
      Lines.STREAM_END,
    ]);

    // 助手气泡出现且内容正确
    await expect(ui.assistantMessages).toHaveCount(1);
    await expect(ui.assistantMessages.first()).toContainText('我是Claude，很高兴见到你。');

    // 流结束后计时器消失
    await expect(ui.waitingIndicator).toHaveCount(0);
  });
});
