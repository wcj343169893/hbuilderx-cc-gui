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
