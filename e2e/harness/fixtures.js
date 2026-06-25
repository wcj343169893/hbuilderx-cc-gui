'use strict';

/**
 * Playwright 测试夹具：把页面（真实 webview 产物 + 生产 shim）与 mock-daemon 接起来。
 *
 * 传输层（对应 HBuilderX webview.postMessage / onDidReceiveMessage）：
 *   出站 页面→Node：生产 shim 调 hbuilderx.postMessage(obj) → 我们用 exposeFunction 暴露的
 *                    window.__ccguiToHost(obj) → 解析 {__ch:'toHost',payload:"event:content"} → daemon.handleOutbound
 *   入站 Node→页面：daemon.callJs(fn,args) → page.evaluate 调 window.__ccguiDeliver({__ch:'callJs',fn,args})
 *                    → 生产 shim 的 onMessage → window[fn](...args)
 *
 * window.hbuilderx 由 addInitScript 在任何页面脚本（含生产 shim）之前注入，
 * 使生产 shim 的 `typeof hbuilderx !== 'undefined'` 成立、走 IDE 模式。
 */

const { test: base, expect } = require('@playwright/test');
const { buildTestHtml } = require('./build-html');
const { MockDaemon, Lines } = require('./mock-daemon');

// 任意 https 源（保证 secure context；HTML 是单文件，无外部资源，route 只需兜主文档）
const PAGE_URL = 'https://ccgui.test/';

const test = base.extend({
  // 是否启用 page.clock（时间相关测试：stall 看门狗 / 计时）。必须在 goto 前 install。
  clockEnabled: [false, { option: true }],

  // 主夹具：返回 { page, daemon, ui }，已 bootstrap 且 SDK 就绪、可直接发消息。
  app: async ({ page, clockEnabled }, use) => {
    let daemon; // 先声明，exposeFunction 回调里引用

    // 1) 出站：页面 → Node
    await page.exposeFunction('__ccguiToHost', (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.__ch === 'toHost' && typeof obj.payload === 'string') {
        const idx = obj.payload.indexOf(':');
        const event = idx === -1 ? obj.payload : obj.payload.slice(0, idx);
        const content = idx === -1 ? '' : obj.payload.slice(idx + 1);
        if (daemon) daemon.handleOutbound(event, content);
      }
      // obj.__ch === 'console' 忽略（生产 shim 的 console 转发）
    });

    // 2) 注入 window.hbuilderx（在生产 shim 之前）
    await page.addInitScript(() => {
      window.hbuilderx = {
        postMessage: (o) => { try { window.__ccguiToHost(o); } catch (e) { /* ignore */ } },
        onDidReceiveMessage: (cb) => { window.__ccguiDeliver = cb; },
      };
    });

    // 3) 入站：Node → 页面（保序由 daemon._chain 保证）
    const deliver = (fn, args) => page.evaluate(
      ([f, a]) => { if (typeof window.__ccguiDeliver === 'function') window.__ccguiDeliver({ __ch: 'callJs', fn: f, args: a }); },
      [fn, args],
    ).catch(() => { /* 页面关闭等忽略 */ });

    daemon = new MockDaemon(deliver);

    // 4) 时间控制（必须在 goto 前）
    if (clockEnabled) {
      await page.clock.install();
    }

    // 5) 兜住主文档，加载真实 webview 产物
    const html = buildTestHtml({ theme: 'light' });
    await page.route(PAGE_URL, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });

    // 6) 等应用挂载（输入框出现）
    const input = page.locator('.input-editable');
    await expect(input).toBeVisible({ timeout: 15000 });

    // 6.1) 关掉首启 changelog 弹窗（测试环境 localStorage 全新，每次都会弹，且其遮罩拦截点击）
    const overlay = page.locator('.changelog-overlay');
    if (await overlay.count()) {
      await page.locator('.changelog-close-btn').click({ timeout: 5000 }).catch(() => {});
      await expect(overlay).toHaveCount(0).catch(() => {});
    }

    // 7) 初始下发 + 等前端权威地拉取依赖状态（settingsBootstrap 会发 get_dependency_status，
    //    那是 React 注册真实回调之后的请求，answer 它即可让 sdkStatusLoaded 变 true）。
    await daemon.bootstrap();
    try { await daemon.waitForOutbound('get_dependency_status', 10000); } catch (e) { /* 已在 bootstrap 推过也行 */ }
    await daemon.flush();

    const ui = makeUi(page, daemon);
    await use({ page, daemon, ui, Lines });
  },
});

/** 常用 UI 操作/定位封装。 */
function makeUi(page, daemon) {
  return {
    input: page.locator('.input-editable'),
    submitButton: page.locator('.submit-button'),
    stopButton: page.locator('.submit-button.stop-button'),
    messagesContainer: page.locator('.messages-container'),
    messages: page.locator('.messages-container .message'),
    userMessages: page.locator('.messages-container .message.user'),
    assistantMessages: page.locator('.messages-container .message.assistant'),
    errorMessages: page.locator('.messages-container .message.error'),
    waitingIndicator: page.locator('.waiting-indicator'),
    waitingSeconds: page.locator('.waiting-seconds'),
    projectChip: page.locator('.chat-header, .chat-header-bar').first(),

    /**
     * 在输入框输入并点发送；随后等待 daemon 收到 send_message（隐式校验「SDK 就绪、可发送」）。
     * @returns {Promise<string>} send_message 的 content（JSON 字符串）
     */
    async sendMessage(text) {
      await this.input.click();
      await page.keyboard.type(text);
      await this.submitButton.click();
      return daemon.waitForOutbound('send_message', 8000);
    },
  };
}

module.exports = { test, expect, Lines, PAGE_URL };
