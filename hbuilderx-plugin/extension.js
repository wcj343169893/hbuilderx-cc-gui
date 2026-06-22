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

/**
 * 是否把日志输出到「CC GUI」OutputChannel。
 * 正式发布默认 **关闭**——只静默记录到磁盘日志文件，不向用户展示。
 * 开发期可通过 设置项 `ccgui.debugLog=true` 或 环境变量 `CCGUI_DEBUG=1` 打开。
 */
function isDebugLogEnabled() {
  const env = process.env.CCGUI_DEBUG;
  if (env === '1' || env === 'true') return true;
  try {
    return hx.workspace.getConfiguration().get('ccgui.debugLog') === true;
  } catch (e) {
    return false;
  }
}

/**
 * 构造 output：始终写磁盘日志文件（内部排查用）；仅当 channel 非空（调试模式）时才写
 * HBuilderX OutputChannel（即向用户可见）。
 */
function buildOutput(channel) {
  let fileOk = true;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, `==== CC GUI 会话开始 ====\n`, { flag: 'a' });
  } catch (e) { fileOk = false; }
  return {
    appendLine(s) {
      if (channel) {
        try { channel.appendLine(s); } catch (e) { /* ignore */ }
      }
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
let statusBar = null;

function activate(context) {
  // 正式发布默认不创建 OutputChannel（不向用户展示日志）；调试模式才创建并展示。
  const channel = isDebugLogEnabled() ? hx.window.createOutputChannel('CC GUI') : null;
  output = buildOutput(channel);
  output.appendLine(`[ccgui] 插件已激活 @ ${new Date().toISOString()}（日志文件: ${LOG_FILE}）`);

  try {
    const created = createCcGuiWebView(hx, VIEW_ID, output);
    panel = created.panel;
    bridge = created.bridge;

    // 接入事件路由：出站事件 -> ai-bridge；流式结果回灌前端。
    // 热升级复用旧 bridge 时，这里把其派发重新指向新建的 router（bridge 监听唯一，不会重复派发）。
    router = new MessageRouter(hx, bridge, output);
    bridge.onEvent((event, content) => router.dispatch(event, content));

    // 异步启动 ai-bridge daemon，就绪后下发初始状态
    router.init()
      .then(() => router.bootstrap())
      .catch((err) => output.appendLine(`[ccgui] router.init 失败: ${err && err.message}`));
  } catch (err) {
    output.appendLine(`[ccgui] 创建视图失败: ${err && err.stack ? err.stack : err}`);
    // 极端情况下无法复用旧视图（如缓存失效）：给用户清晰指引，而非留下损坏的界面。
    if (/already\s*registered/i.test((err && err.message) || String(err))) {
      try {
        hx.window.showInformationMessage('CC GUI 已更新，请重启 HBuilderX 以完成升级。', ['知道了']);
      } catch (e) { /* ignore */ }
    }
  }

  // 注册打开命令：聚焦到 CC GUI 视图
  const openCmd = hx.commands.registerCommand('extension.ccgui.open', () => {
    try {
      hx.window.showView({ viewId: VIEW_ID, containerId: CONTAINER_ID });
    } catch (err) {
      output.appendLine(`[ccgui] showView 失败: ${err && err.message}`);
    }
  });

  // 注册「发送选中代码到 CC GUI」：从当前活动编辑器取选区，组装为文件标签片段注入输入框。
  // 由编辑器右键 / 快捷键(ctrl+alt+a)触发，无 uri 入参，统一读 getActiveTextEditor()。
  const sendSelectionCmd = hx.commands.registerCommand('extension.ccgui.sendSelection', async () => {
    try {
      const editor = await hx.window.getActiveTextEditor();
      if (!editor) {
        output.appendLine('[ccgui] sendSelection: 无活动编辑器，忽略');
        return;
      }
      const absPath = editor.document.uri.fsPath;

      // editor.selection 是「字符偏移量」(active/anchor)，非行号；防御：非 number 则按无选区处理。
      const a = editor.selection && editor.selection.active;
      const b = editor.selection && editor.selection.anchor;
      const hasSel = typeof a === 'number' && typeof b === 'number' && a !== b;

      let snippet = `@${absPath}`;
      if (hasSel) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // 取整篇文本以把字符偏移换算成 1-based 行号
        let text = '';
        try {
          text = editor.document.getText({ start: 0, end: Number.MAX_SAFE_INTEGER }) || '';
        } catch (e) {
          text = '';
        }
        const startLine = lineOfOffset(text, lo);
        const endLine = lineOfOffset(text, hi);
        snippet = startLine === endLine
          ? `@${absPath}#L${startLine}`
          : `@${absPath}#L${startLine}-${endLine}`;
      }

      hx.window.showView({ viewId: VIEW_ID, containerId: CONTAINER_ID });
      // webview 可能首次展示时才 boot，且 addCodeSnippet 是「追加」语义不可重复调用，
      // 故用单次延迟调用，给前端留出 boot 时间。
      setTimeout(() => router.injectCodeSnippet(snippet), 250);
    } catch (err) {
      output.appendLine(`[ccgui] sendSelection 异常: ${err && err.message}`);
    }
  });

  // 注册「添加文件到 CC GUI」：资源管理器右键时第一个入参是被点中文件的 uri；
  // 编辑器右键 / 快捷键触发时 uri 为 undefined，回退读当前活动编辑器。
  const addFileCmd = hx.commands.registerCommand('extension.ccgui.addFile', async (uri) => {
    try {
      let absPath;
      if (uri && uri.fsPath) {
        absPath = uri.fsPath; // explorer 右键命中的文件
      } else {
        const editor = await hx.window.getActiveTextEditor();
        if (!editor) {
          output.appendLine('[ccgui] addFile: 无 uri 且无活动编辑器，忽略');
          return;
        }
        absPath = editor.document.uri.fsPath; // 编辑器 / 快捷键回退
      }

      hx.window.showView({ viewId: VIEW_ID, containerId: CONTAINER_ID });
      // 同 sendSelection：延迟单次注入，规避首次 boot 时序。
      setTimeout(() => router.injectFiles(absPath), 250);
    } catch (err) {
      output.appendLine(`[ccgui] addFile 异常: ${err && err.message}`);
    }
  });

  if (context && context.subscriptions) {
    context.subscriptions.push(openCmd, sendSelectionCmd, addFileCmd);
  }

  // 创建底部状态栏图标：点击打开 CC GUI 面板。
  // 整体兜底，失败仅记日志，避免阻断 activate。
  try {
    statusBar = hx.window.createStatusBarItem(hx.StatusBarAlignment.Right, 100);
    statusBar.text = '$(ccgui)';
    statusBar.tooltip = '打开 CC GUI 助手';
    statusBar.command = 'extension.ccgui.open';
    statusBar.show();
    output.appendLine('[ccgui] 状态栏图标已创建');
  } catch (e) {
    output.appendLine(`[ccgui] 状态栏图标创建失败: ${e && e.message}`);
  }
}

/**
 * 把字符偏移量换算成 1-based 行号：偏移之前出现的换行段数 + 1。
 * 兼容 CRLF / CR / LF。
 */
function lineOfOffset(text, off) {
  return text.slice(0, Math.max(0, off)).split(/\r\n|\r|\n/).length;
}

function deactivate() {
  try {
    if (router) router.dispose();
  } catch (e) {
    /* ignore */
  }
  // 故意**不** dispose panel：HBuilderX 的 panel.dispose() 只关闭 tab、不注销视图 provider，
  // 而热升级（不重启）会在新版 activate 重新 createWebView 同一 viewId 抛 "already registered"。
  // 保留视图与 bridge（globalThis.__ccguiWebView 持有引用）供新版复用，是规避该崩溃的关键。
  try {
    if (statusBar && typeof statusBar.dispose === 'function') {
      statusBar.dispose();
    }
  } catch (e) {
    /* ignore */
  }
  router = null;
  panel = null;
  bridge = null;
  statusBar = null;
  if (output) {
    output.appendLine('[ccgui] 插件已停用');
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { activate, deactivate };
