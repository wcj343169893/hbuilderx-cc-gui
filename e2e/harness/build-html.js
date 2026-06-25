'use strict';

/**
 * 构建用于无头测试的页面 HTML。
 *
 * 关键：直接复用**真实发布产物** hbuilderx-plugin/html/claude-chat.html
 * 与**真实的桥接 shim 注入** lib/html-template.js（buildWebviewHtml）。
 * 这样测试跑的就是用户实际拿到的那份 webview + 那段 shim，不是仿造品。
 *
 * 唯一被「mock」的是 daemon 的 stdout —— 由 mock-daemon.js 脚本化回放，
 * 经真实的 stream-adapter + claude-session 装配器，产生真实的 window.* 回调序列。
 *
 * `window.hbuilderx` 这个传输层不在这里注入，而是由 fixtures.js 用 Playwright
 * 的 addInitScript 在页面任何脚本之前注入，使生产 shim 能接上 Playwright 的
 * exposeFunction 通道。
 */

const fs = require('fs');
const path = require('path');
const { buildWebviewHtml } = require('../../hbuilderx-plugin/lib/html-template');

const HTML_PATH = path.join(__dirname, '..', '..', 'hbuilderx-plugin', 'html', 'claude-chat.html');

/**
 * @param {{ theme?: 'dark'|'light' }} [opts]
 * @returns {string} 注入了生产桥接 shim 的完整单文件 HTML
 */
function buildTestHtml(opts) {
  const options = opts || {};
  if (!fs.existsSync(HTML_PATH)) {
    throw new Error(
      `缺少 webview 构建产物: ${HTML_PATH}\n` +
      '请先构建前端：cd webview && npm install && npm run build（产物会输出到 hbuilderx-plugin/html/claude-chat.html）',
    );
  }
  const raw = fs.readFileSync(HTML_PATH, 'utf-8');
  return buildWebviewHtml(raw, { theme: options.theme === 'dark' ? 'dark' : 'light' });
}

module.exports = { buildTestHtml, HTML_PATH };
