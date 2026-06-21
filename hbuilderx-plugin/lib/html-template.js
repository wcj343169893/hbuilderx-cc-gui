'use strict';

/**
 * 构建注入到 HBuilderX webview 的 HTML。
 *
 * 现有前端（webview/）由 vite-plugin-singlefile 打包为单文件 HTML，所有 JS/CSS
 * 内联。这里在 <head> 顶部注入一段经典内联脚本（在被 defer 的 module 脚本之前执行），
 * 完成两件事：
 *   1. 桥接 shim —— 复刻 JCEF 侧的 window.sendToJava（出站）与 window[fn](...args)（入站）
 *      两条通道，使 React 源码无需任何改动（bridge.ts 只判断 window.sendToJava 是否存在）。
 *   2. 主题变量 __INITIAL_IDE_THEME__ —— 对应 IDEA 版 HtmlLoader.injectIdeTheme，
 *      避免首帧主题闪烁。
 *
 * 对应 IDEA 实现：src/.../ui/WebviewInitializer.java（shim 注入、console 转发）、
 * src/.../util/HtmlLoader.java（主题注入）。
 */

/** 生成桥接 + 主题的内联脚本（不含外层 <script> 标签）。 */
function buildBridgeScript(theme) {
  const safeTheme = theme === 'dark' ? 'dark' : 'light';
  return `
window.__INITIAL_IDE_THEME__ = '${safeTheme}';
(function () {
  var hx = (typeof hbuilderx !== 'undefined') ? hbuilderx : null;
  function post(obj) { if (hx && hx.postMessage) { try { hx.postMessage(obj); } catch (e) {} } }

  // 出站：前端调用 window.sendToJava("event:content") -> 转发给插件宿主
  window.sendToJava = function (msg) { post({ __ch: 'toHost', payload: String(msg) }); };

  // 入站：插件宿主发来 { __ch:'callJs', fn, args } -> 调用对应的 window 回调
  function onMessage(e) {
    var m = (e && e.data !== undefined) ? e.data : e;
    if (!m || m.__ch !== 'callJs') return;
    var fn = m.fn;
    var args = m.args || [];
    if (typeof window[fn] === 'function') {
      try { window[fn].apply(window, args); } catch (err) { /* 单个回调出错不影响其它 */ }
    }
  }
  // 文档明确两种写法等价，二选一以避免重复派发
  if (hx && typeof hx.onDidReceiveMessage === 'function') {
    hx.onDidReceiveMessage(onMessage);
  } else {
    window.addEventListener('message', onMessage);
  }

  // console 转发到宿主 OutputChannel，便于调试（生产可在宿主侧按需关闭）
  ['log', 'warn', 'error'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      orig.apply(null, arguments);
      try {
        var parts = Array.prototype.slice.call(arguments).map(function (a) {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        });
        post({ __ch: 'console', level: level, text: parts.join(' ') });
      } catch (e) {}
    };
  });
})();`;
}

/**
 * 将桥接 shim 与主题变量注入到打包好的单文件 HTML 中。
 * @param {string} rawHtml webview 构建产物 claude-chat.html 的原始内容
 * @param {{ theme?: 'dark'|'light', backgroundColor?: string }} [opts]
 * @returns {string}
 */
function buildWebviewHtml(rawHtml, opts) {
  const options = opts || {};
  const theme = options.theme === 'dark' ? 'dark' : 'light';
  const bg = options.backgroundColor || (theme === 'dark' ? '#1e1e1e' : '#ffffff');

  let html = rawHtml;

  // 首帧防闪烁：给 <html>/<body> 加内联背景色（对应 HtmlLoader.injectIdeTheme）
  html = html.replace(/<html([^>]*)>/i, `<html$1 style="background-color:${bg};">`);
  html = html.replace(/<body([^>]*)>/i, `<body$1 style="background-color:${bg};">`);

  const scriptTag = `\n<script>${buildBridgeScript(theme)}\n</script>`;
  const headIdx = html.search(/<head[^>]*>/i);
  if (headIdx !== -1) {
    const insertPos = headIdx + html.match(/<head[^>]*>/i)[0].length;
    html = html.slice(0, insertPos) + scriptTag + html.slice(insertPos);
  } else {
    // 没有 <head> 时退化为前置注入
    html = scriptTag + html;
  }

  return html;
}

module.exports = { buildWebviewHtml, buildBridgeScript };
