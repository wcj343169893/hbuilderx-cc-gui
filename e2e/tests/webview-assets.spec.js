'use strict';

/**
 * 回归：资源通道（bridge as asset channel）。
 *
 * 背景：HBuilderX 的 webview 只接受 HTML 字符串、没有基准 URL，所以产物必须单文件；
 * 而 vite-plugin-singlefile 会把 `await import('mermaid')` 拍平，使 mermaid 整包
 * （约 4MB）变成每次打开面板都要解析的死重量。现在 mermaid 不再进产物，改为放在
 * hbuilderx-plugin/html/chunks/，首次遇到图表时经 get_webview_asset 取回、blob import。
 *
 * 本文件验证两件事：
 *   1. 正常路径：带 mermaid 代码块的回复最终渲染出 SVG 图（通道 + blob import + 渲染全链路）
 *   2. 降级路径：宿主取不到资源时不报错、不卡 loading，保留原始代码块
 *
 * 注意：这里用的是**生产实现** lib/webview-assets.js 真实读磁盘上的 chunk，
 * 所以跑本测试前必须先 `cd webview && npm run build`（会生成 html/chunks/）。
 */

const { test, expect, Lines } = require('../harness/fixtures');

const MERMAID_REPLY = [
  '这是流程图：',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[结束]',
  '  B -->|否| A',
  '```',
].join('\n');

test.describe('资源通道：mermaid 整包外置', () => {
  test('带 mermaid 代码块的回复能渲染出 SVG 图', async ({ app }) => {
    const { ui, daemon, page } = app;

    await ui.sendMessage('画个流程图');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.sessionId('sess-mermaid'),
      Lines.contentDelta(MERMAID_REPLY),
      Lines.STREAM_END,
    ]);

    // 前端应当向宿主索取 mermaid 整包
    const assetRequest = await daemon.waitForOutbound('get_webview_asset', 15000);
    expect(JSON.parse(assetRequest).name).toBe('mermaid-bundle.js');

    // 图渲染出来（blob import 生效）；mermaid 整包较大，给足超时
    const diagram = page.locator('.mermaid-diagram svg');
    await expect(diagram).toHaveCount(1, { timeout: 60000 });

    // loading 占位已移除
    await expect(page.locator('.mermaid-loading')).toHaveCount(0);
  });

  test('宿主取不到资源时降级为代码块，不卡 loading', async ({ app }) => {
    const { ui, daemon, page } = app;
    daemon.assetsUnavailable = true;

    await ui.sendMessage('画个流程图');
    await daemon.feedLines([
      Lines.STREAM_START,
      Lines.sessionId('sess-mermaid-fallback'),
      Lines.contentDelta(MERMAID_REPLY),
      Lines.STREAM_END,
    ]);

    await daemon.waitForOutbound('get_webview_asset', 15000);

    // 没有图，但原始代码块仍在，且 loading 占位被清掉
    await expect(page.locator('.mermaid-loading')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('.mermaid-diagram')).toHaveCount(0);
    await expect(ui.assistantMessages.nth(0)).toContainText('flowchart TD');
    await expect(ui.errorMessages).toHaveCount(0);
  });
});
