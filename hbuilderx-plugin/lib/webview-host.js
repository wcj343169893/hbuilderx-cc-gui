'use strict';

const fs = require('fs');
const path = require('path');
const { buildWebviewHtml } = require('./html-template');
const { BridgeHost } = require('./bridge-host');

const HTML_PATH = path.join(__dirname, '..', 'html', 'claude-chat.html');

// HBuilderX 内置的深色配色方案名（用于推断主题，避免首帧闪烁）
const DARK_COLOR_SCHEMES = new Set([
  'Monokai',
  'Atom One Dark',
  'Default Dark',
  'Dark',
]);

/** 从 HBuilderX 配置推断当前主题。 */
function resolveTheme(hx) {
  try {
    const config = hx.workspace.getConfiguration();
    const scheme = config.get('editor.colorScheme');
    if (typeof scheme === 'string' && DARK_COLOR_SCHEMES.has(scheme)) {
      return 'dark';
    }
    if (typeof scheme === 'string' && /dark/i.test(scheme)) {
      return 'dark';
    }
  } catch (e) {
    // 读取失败时退回浅色
  }
  return 'light';
}

function loadFallbackHtml(message) {
  return (
    '<!DOCTYPE html><html style="background:#1e1e1e;"><head><meta charset="UTF-8">' +
    '<title>CC GUI</title></head><body style="background:#1e1e1e;color:#fff;' +
    'font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
    '<div style="text-align:center;padding:40px;"><h1 style="color:#f85149;">加载聊天界面失败</h1>' +
    '<p>' + (message || '请确认 html/claude-chat.html 是否存在（需先在 webview/ 执行 npm run build）') +
    '</p></div></body></html>'
  );
}

/**
 * 创建 CC GUI 的 webview 视图，加载并注入前端 HTML，建立双向桥接。
 *
 * 对应 IDEA 实现：WebviewInitializer.createUIComponents + HtmlLoader.loadChatHtml。
 *
 * @param {object} hx require('hbuilderx')
 * @param {string} viewId contributes.views 中声明的视图 id
 * @param {{ appendLine: (s: string) => void }} output OutputChannel
 * @returns {{ panel: object, webview: object, bridge: BridgeHost }}
 */
function createCcGuiWebView(hx, viewId, output) {
  let panel = null;
  let reusedBridge = null;

  try {
    panel = hx.window.createWebView(viewId, { enableScripts: true });
  } catch (err) {
    // 热升级（不重启 HBuilderX 直接更新插件）时，旧版注册的视图 provider 不会随 deactivate 的
    // panel.dispose() 释放（dispose 只关闭 tab，不注销 provider），再次 createWebView 会抛
    // "WebviewView provider for '<id>' already registered"。同进程内 require 缓存虽被刷新，但
    // globalThis 保留——复用上次缓存的 panel/bridge，避免崩溃且无需重启 HBuilderX。
    const msg = (err && err.message) || String(err);
    const cached = globalThis.__ccguiWebView;
    if (/already\s*registered/i.test(msg) && cached && cached.panel && cached.panel.webView) {
      panel = cached.panel;
      reusedBridge = cached.bridge || null;
      output.appendLine(`[webview] 热升级：复用已注册视图与桥接（${msg}）`);
    } else {
      throw err; // 无可复用视图：交由上层提示重启 HBuilderX
    }
  }

  const webview = panel.webView;

  // 复用时沿用同一个 BridgeHost（保持其唯一的 onDidReceiveMessage 监听，避免重复注册导致重复派发），
  // 仅由调用方通过 bridge.onEvent(...) 把派发重新指向新的 router。
  let bridge = reusedBridge;
  if (bridge) {
    try { bridge.output = output; } catch (e) { /* ignore */ }
  } else {
    bridge = new BridgeHost(webview, output);
  }

  try {
    const rawHtml = fs.readFileSync(HTML_PATH, 'utf-8');
    const theme = resolveTheme(hx);
    webview.html = buildWebviewHtml(rawHtml, { theme });
    output.appendLine(`[webview] 已加载界面（theme=${theme}${reusedBridge ? '，热升级复用' : ''}）`);
  } catch (err) {
    output.appendLine(`[webview] 读取 HTML 失败: ${err && err.message}`);
    try { webview.html = loadFallbackHtml(); } catch (e) { /* ignore */ }
  }

  globalThis.__ccguiWebView = { panel, bridge };
  return { panel, webview, bridge };
}

module.exports = { createCcGuiWebView, resolveTheme, HTML_PATH };
