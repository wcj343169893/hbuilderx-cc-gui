'use strict';

/**
 * 一次性探针插件：回答「HBuilderX 的 webview 能不能加载外部资源文件」。
 *
 * 背景：CC GUI 的前端产物是 5.8MB 单文件 HTML（webview.html 只接受字符串，
 * 没有基准 URL，所以一切都得内联）。若某种外部加载方式可用，就能把 mermaid
 * (2.35MB)、语言包 (754KB)、CSS、字体拆出去，首帧只加载 app shell。
 *
 * 用法：
 *   1. 把本目录整个拷到 HBuilderX 的插件目录（工具 → 插件安装目录），重启 HBuilderX
 *   2. 运行命令「探测 Webview 外部资源能力」
 *   3. 看「资源探针」输出面板里的结果表，把结果贴回仓库 issue / 文档
 *
 * 探测项：
 *   A. webview.asWebviewUri 是否存在（官方文档有，历史 issue 报过 undefined）
 *   B. <script src="file:///绝对路径">  能否执行
 *   C. <link  href="file:///绝对路径">  能否生效
 *   D. <base href="file:///目录/"> + 相对路径 能否生效
 *   E. <script src="http://127.0.0.1:端口/..."> 能否执行（本地回环服务）
 *   F. fetch('http://127.0.0.1:端口/...') 能否取到数据（需服务端带 CORS 头）
 *   G. import(URL.createObjectURL(new Blob([代码]))) 能否动态执行（决定「桥接下发代码」这条保底路线）
 *   H. 宿主 postMessage 传 2MB 字符串的往返耗时（决定大 chunk 走桥接是否可接受）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const hx = require('hbuilderx');

const ASSET_DIR = path.join(os.tmpdir(), 'ccgui-webview-probe');
const ROUNDS = ['absolute', 'baseHref'];

let output;
function log(line) {
  if (!output) output = hx.window.createOutputChannel('资源探针');
  output.show();
  output.appendLine(line);
}

/** 写出探针用的静态资源：两个 js（各自打一个全局标记）、一个 css、一个 json。 */
function writeAssets() {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const files = {
    'probe-file.js': 'window.__probe = window.__probe || {}; window.__probe.fileScript = true;',
    'probe-base.js': 'window.__probe = window.__probe || {}; window.__probe.baseScript = true;',
    'probe-http.js': 'window.__probe = window.__probe || {}; window.__probe.httpScript = true;',
    'probe.css': '#probe-css-target { color: rgb(1, 2, 3); }',
    'probe.json': JSON.stringify({ ok: true }),
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(ASSET_DIR, name), content, 'utf8');
  }
}

/** 起一个只绑定 127.0.0.1 的静态服务，带 CORS 头（fetch 需要）。 */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const name = path.basename((req.url || '').split('?')[0]);
      const file = path.join(ASSET_DIR, name);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const type = name.endsWith('.js') ? 'application/javascript'
        : name.endsWith('.css') ? 'text/css'
        : name.endsWith('.json') ? 'application/json' : 'text/plain';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(file));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fileUrl(name) {
  const p = path.join(ASSET_DIR, name).replace(/\\/g, '/');
  return 'file:///' + p.replace(/^\/+/, '');
}

function buildHtml(round, port) {
  const baseTag = round === 'baseHref'
    ? `<base href="${fileUrl('').replace(/[^/]*$/, '')}">`
    : '';
  const relativeScript = round === 'baseHref' ? '<script src="probe-base.js"></script>' : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
${baseTag}
<link rel="stylesheet" href="${fileUrl('probe.css')}">
<script src="${fileUrl('probe-file.js')}"></script>
<script src="http://127.0.0.1:${port}/probe-http.js"></script>
${relativeScript}
</head><body>
<div id="probe-css-target">probe</div>
<pre id="out">探测中…</pre>
<script>
(function () {
  window.__probe = window.__probe || {};
  var p = window.__probe;
  var cssOk = getComputedStyle(document.getElementById('probe-css-target')).color.replace(/\\s/g, '') === 'rgb(1,2,3)';
  function report(fetchOk) {
    var result = {
      round: ${JSON.stringify(round)},
      fileScript: !!p.fileScript,
      baseScript: !!p.baseScript,
      cssLink: cssOk,
      httpScript: !!p.httpScript,
      httpFetch: fetchOk,
      blobImport: !!(window.__probe && window.__probe.blobImport)
    };
    document.getElementById('out').textContent = JSON.stringify(result, null, 2);
    try { hbuilderx.postMessage({ command: 'probeResult', result: result }); } catch (e) {}
  }
  function blobImport() {
    try {
      var code = 'export default 42;';
      var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      return import(/* @vite-ignore */ url).then(function (m) { return m.default === 42; }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  var fetchOk = fetch('http://127.0.0.1:${port}/probe.json')
    .then(function (r) { return r.json(); })
    .then(function (j) { return !!(j && j.ok); })
    .catch(function () { return false; });
  Promise.all([fetchOk, blobImport()]).then(function (rs) {
    window.__probe.blobImport = rs[1];
    report(rs[0]);
  });

  // H：等宿主发来 2MB 字符串，回报往返耗时
  try {
    hbuilderx.onDidReceiveMessage(function (msg) {
      if (!msg || msg.command !== 'bigString') return;
      hbuilderx.postMessage({ command: 'bigStringEcho', length: (msg.payload || '').length, sentAt: msg.sentAt });
    });
  } catch (e) {}
})();
</script>
</body></html>`;
}

function mark(v) { return v ? '✅ 可用' : '❌ 不可用'; }

function printResult(r) {
  if (r.round === 'absolute') {
    log('──── 绝对路径轮次 ────');
    log('B. <script src="file:///…">      ' + mark(r.fileScript));
    log('C. <link href="file:///…">       ' + mark(r.cssLink));
    log('E. <script src="http://127.0.0.1:…"> ' + mark(r.httpScript));
    log('F. fetch("http://127.0.0.1:…")   ' + mark(r.httpFetch));
    log('G. import(blob: URL)             ' + mark(r.blobImport));
  } else {
    log('──── base href 轮次 ────');
    log('D. <base href="file:///…"> + 相对路径 ' + mark(r.baseScript));
  }
}

function activate(context) {
  context.subscriptions.push(
    hx.commands.registerCommand('extension.probeWebviewAssets', async () => {
      try {
        writeAssets();
        const server = await startServer();
        const port = server.address().port;
        log('资源目录：' + ASSET_DIR);
        log('本地服务：http://127.0.0.1:' + port);

        const panel = hx.window.createWebView('probe.view', { enableScripts: true });
        const webview = panel.webView;
        log('A. webview.asWebviewUri        ' + (typeof webview.asWebviewUri === 'function' ? '✅ 存在' : '❌ 不存在（' + typeof webview.asWebviewUri + '）'));

        let round = 0;
        webview.onDidReceiveMessage((msg) => {
          if (msg && msg.command === 'bigStringEcho') {
            log('H. postMessage 2MB 字符串往返   ' + (Date.now() - msg.sentAt) + ' ms（收到 ' + msg.length + ' 字符）');
            return;
          }
          if (!msg || msg.command !== 'probeResult') return;
          printResult(msg.result);
          round += 1;
          if (round === 1) {
            // 第一轮结束后顺手量一下桥接传大字符串的耗时
            const payload = 'x'.repeat(2 * 1024 * 1024);
            webview.postMessage({ command: 'bigString', payload, sentAt: Date.now() });
          }
          if (round < ROUNDS.length) {
            webview.html = buildHtml(ROUNDS[round], port);
          } else {
            log('探测结束。请把以上结果回填到 docs/plans/2026-09-12-webview-asset-splitting.md');
            try { server.close(); } catch (e) {}
          }
        });
        webview.html = buildHtml(ROUNDS[0], port);
      } catch (error) {
        log('探测失败：' + (error && error.message ? error.message : String(error)));
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
