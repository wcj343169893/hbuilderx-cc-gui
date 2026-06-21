'use strict';

/**
 * CC GUI（Claude or Codex）HBuilderX 插件入口。
 *
 * 阶段 0：脚手架 + 桥接冒烟。
 *   - 在右侧视图区创建 webview，加载复用自 webview/ 的单文件前端。
 *   - 建立 sendToJava / callJs 双向桥接，前端 console 与事件回流到 OutputChannel。
 * 后续阶段在 onEvent 分发器接入 MessageRouter + ai-bridge 子进程。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const hx = require('hbuilderx');
const { createCcGuiWebView } = require('./lib/webview-host');
const { MessageRouter } = require('./lib/message-router');

const VIEW_ID = 'ccgui.chatView';
const CONTAINER_ID = 'ccgui.container';

// 调试日志文件：HBuilderX 的 .log 不收录插件 OutputChannel 输出，故同时写一份到磁盘便于排查。
const LOG_FILE = path.join(os.homedir(), '.codemoss', 'ccgui-debug.log');

/** 构造 output：同时写 HBuilderX OutputChannel 和磁盘日志文件。 */
function buildOutput(channel) {
  let fileOk = true;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, `==== CC GUI 会话开始 ====\n`, { flag: 'a' });
  } catch (e) { fileOk = false; }
  return {
    appendLine(s) {
      try { channel.appendLine(s); } catch (e) { /* ignore */ }
      if (fileOk) {
        try { fs.appendFileSync(LOG_FILE, s + '\n'); } catch (e) { /* ignore */ }
      }
    },
  };
}

let output = null;
let panel = null;
let bridge = null;
let router = null;

function activate(context) {
  const channel = hx.window.createOutputChannel('CC GUI');
  output = buildOutput(channel);
  output.appendLine(`[ccgui] 插件已激活 @ ${new Date().toISOString()}（日志文件: ${LOG_FILE}）`);

  try {
    const created = createCcGuiWebView(hx, VIEW_ID, output);
    panel = created.panel;
    bridge = created.bridge;

    // 接入事件路由：出站事件 -> ai-bridge；流式结果回灌前端
    router = new MessageRouter(hx, bridge, output);
    bridge.onEvent((event, content) => router.dispatch(event, content));

    // 异步启动 ai-bridge daemon，就绪后下发初始状态
    router.init()
      .then(() => router.bootstrap())
      .catch((err) => output.appendLine(`[ccgui] router.init 失败: ${err && err.message}`));
  } catch (err) {
    output.appendLine(`[ccgui] 创建视图失败: ${err && err.stack ? err.stack : err}`);
  }

  // 注册打开命令：聚焦到 CC GUI 视图
  const openCmd = hx.commands.registerCommand('extension.ccgui.open', () => {
    try {
      hx.window.showView({ viewId: VIEW_ID, containerId: CONTAINER_ID });
    } catch (err) {
      output.appendLine(`[ccgui] showView 失败: ${err && err.message}`);
    }
  });

  if (context && context.subscriptions) {
    context.subscriptions.push(openCmd);
  }
}

function deactivate() {
  try {
    if (router) router.dispose();
  } catch (e) {
    /* ignore */
  }
  try {
    if (panel && typeof panel.dispose === 'function') {
      panel.dispose();
    }
  } catch (e) {
    /* ignore */
  }
  router = null;
  panel = null;
  bridge = null;
  if (output) {
    output.appendLine('[ccgui] 插件已停用');
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { activate, deactivate };
