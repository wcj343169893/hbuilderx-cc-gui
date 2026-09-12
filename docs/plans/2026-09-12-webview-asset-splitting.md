# webview 单文件产物拆分可行性（实测 + 方案）

- 日期：2026-09-12
- 起因：担心单文件 HTML 过大
- 当前实测：`webview` 产物 **5.81 MB**（gzip 1.63 MB），其中 **mermaid 全家桶 2.6 MB（45%）本来是懒加载，却被单文件插件拍平成必加载**
- 结论：**能拆，但拆到什么程度取决于 HBuilderX webview 的外部资源能力**。已写好一次性探针（`docs/testing/probe-hbuilderx-webview-assets/`），跑一次即可在三条路线里定选。**另有两项改造完全不依赖平台能力，无论探针结果如何都该做。**

---

## 一、实测数据（本仓库 main，`npm run build`）

```
dist/index.html  5,806,602 字节（5.81 MB）│ gzip 1,629 KB
结构：1 个 <script type="module"> ≈ 5.0 MB + 1 个 <style> ≈ 500 KB
```

按来源拆开（同一份代码，改用分包构建量出来的真实体积，minify 后）：

| 来源 | 体积 | 说明 |
|---|---:|---|
| **mermaid** | 1,306 KB | 图表渲染 |
| **cytoscape + cytoscape-fcose + layout-base** | 617 KB | mermaid 的布局依赖 |
| **katex** | 258 KB | mermaid 的公式依赖（不是我们自己引的） |
| **@mermaid-js/parser + langium + chevrotain + vscode-jsonrpc/lsp** | 422 KB | mermaid 的语法解析依赖 |
| **—— mermaid 全家桶合计** | **≈ 2,603 KB** | **占 45%** |
| **i18n 10 个语言包** | 754 KB | 用户只会用其中一种 |
| app 自身代码 | 811 KB | 组件/hooks/业务逻辑，正常 |
| CSS（单文件，未分割） | 349 KB | |
| react + react-dom | 193 KB | |
| codicon.ttf（内联 data URL） | 122 KB | |
| 图标数据（folder-icons + tech-icons×3） | 143 KB | 源码 956 KB，tree-shaking 后只剩这些 |
| @lobehub/icons | 121 KB | |
| highlight.js（core + 按需语言） | 79 KB | |
| 其余依赖（antd/rc-*、marked、dompurify、i18next、es-toolkit…） | ≈ 600 KB | |

### 两个现成的结论（与平台能力无关）

1. **mermaid 的懒加载是失效的。** `MarkdownBlock.tsx:145` 已经写成 `await import('mermaid')`，但 `vite-plugin-singlefile` 会强制 `inlineDynamicImports`（见 `node_modules/vite-plugin-singlefile/dist/esm/index.js:46`），动态 chunk 被拍平进同一个 module script。结果：**每次打开面板都要下发并解析这 2.6 MB，哪怕整个会话里没有一张图表。**
2. **10 份语言包全量内联。** 754 KB 里用户只用得上一份（约 85 KB）。

---

## 二、为什么不能简单改成多文件

`hbuilderx-plugin/lib/webview-host.js:92` 是：

```js
webview.html = buildWebviewHtml(rawHtml, { theme });
```

HBuilderX 的 webview **只接受 HTML 字符串**（官方 API 文档里 `WebViewOptions` 只有 `enableScripts` 一个选项，没有 VS Code 那样的 `localResourceRoots`）。字符串注入的文档没有基准 URL，相对路径资源无从解析——这才是「必须单文件」的根因，不是偷懒。

官方文档里确实有 `webView.asWebviewUri(localResource)`（把本地文件路径转成 webview 内可用 URI），但 dcloudio 官方文档仓库的 [issue #53](https://github.com/dcloudio/hbuilderx-extension-docs/issues/53) 报告过：在 3.6.15 上 `webView.asWebviewUri` 运行时是 `undefined`，且类型签名写的是返回 `void`。该 issue **没有官方回复**。HBuilderX 5.x 上是否已修复，只能实测。

---

## 三、先跑探针（5 分钟，一次性）

`docs/testing/probe-hbuilderx-webview-assets/` 是一个独立的小插件，不动主插件任何代码。拷进 HBuilderX 插件目录 → 重启 → 运行命令「探测 Webview 外部资源能力」，输出面板会给出：

| 探测项 | 说明 |
|---|---|
| A | `webview.asWebviewUri` 是否存在 |
| B | `<script src="file:///绝对路径">` 能否执行 |
| C | `<link href="file:///绝对路径">` 能否生效 |
| D | `<base href="file:///目录/">` + 相对路径能否生效 |
| E | `<script src="http://127.0.0.1:端口/…">` 能否执行 |
| F | `fetch('http://127.0.0.1:端口/…')` 能否取数（服务端已带 CORS 头） |
| G | `import(URL.createObjectURL(new Blob([代码])))` 能否动态执行 |
| H | 宿主 `postMessage` 传 2 MB 字符串的往返耗时 |

G 和 H 决定保底路线是否成立：只要 G 可用，**桥接本身就能当资源通道**（宿主读盘 → 字符串下发 → blob 动态 import），完全不需要平台支持外部 URL。

---

## 四、三条路线（按探针结果选）

### 路线 1：平台支持本地文件（A 或 B+C 或 D 任一可用）

最省事：去掉 `vite-plugin-singlefile`，`webview` 正常产出 `index.html + assets/*`，`copy-dist.mjs` 改为整目录同步到 `hbuilderx-plugin/html/`；宿主读 `index.html` 后把资源引用改写成 `asWebviewUri`（或 `file://` 绝对路径 / 注入 `<base>`）。vite 的 code splitting、动态 import、CSS 分割全部自然生效。

- 首帧只加载 app shell：**约 1.2~1.5 MB**（app + react + CSS + 当前语言）
- mermaid 真正按需加载
- 代价：宿主要做一次 HTML 引用改写；IDEA 版仍可继续用单文件产物（两种产物并存，`copy-dist.mjs` 分别处理）

### 路线 2：本地回环服务（E+F 可用）

把整个前端交给一个 `127.0.0.1` 静态服务，`webview.html` 只放一个极小的 loader（或直接 iframe 指向它）。这条路线最干净，且**和 TokenTracker 仪表盘要用的本地网关是同一个服务**（见移植方案 B4），基础设施复用。

- 首帧同路线 1，且资源带 HTTP 缓存
- 代价：多一个常驻端口与进程；必须只绑 `127.0.0.1`、随机端口、URL 带一次性 token（防本机其他进程抓取）；要处理安全软件拦截、插件热升级时换端口、webview 重载

### 路线 3：保底（外部 URL 全不可用，只要 G 可用）

仍然是单文件，但把大块资源从构建产物里拿出来，改成**按需经桥接下发**：

| 改造 | 手段 | 省 |
|---|---|---|
| mermaid 全家桶 | 构建成独立 chunk 文件放 `hbuilderx-plugin/html/chunks/`；首次遇到图表时前端向宿主要，宿主读盘回传字符串 → `import(blob URL)` | **≈ 2.6 MB** |
| 语言包 | 只内联当前语言（或 zh+en），其余按需走桥接取 JSON | **≈ 580 KB** |
| codicon 字体 | 需要时按 data URL 下发 | ≈ 122 KB |
| 图标数据 | 同上（收益小，可不做） | ≈ 143 KB |

- 预计 5.81 MB → **约 2.4~2.6 MB**，首帧解析量减半以上
- 代价：首次用到 mermaid 时多一次大字符串 RPC（探针 H 给出耗时；若过慢就分片下发或 base64+gzip）
- 这条路线不依赖任何平台能力，**即使探针全红也能落地**

### 无论选哪条都该先做的两件事

1. **语言包按需**：10 份全量内联没有任何理由，先砍到当前语言（路线 1/2 下是天然 code split，路线 3 下走桥接）。
2. **mermaid 不再拍平**：路线 1/2 自然解决；路线 3 用 blob import。这一项单独就能把产物砍掉 45%。

---

## 五、风险

- **路径兼容**：`file://` 路线要处理 Windows 盘符、路径含空格与中文、HBuilderX 插件目录被装在 `C:\Program Files` 这类带空格的位置。
- **端口与安全软件**：路线 2 在国内 Windows 环境常遇到安全软件拦截本地监听；必须有「起不来就退回单文件」的降级分支，不能让面板打不开。
- **热升级**：本仓库已有「插件热升级后复用 webview」的处理（`webview-host.js`），换路线后要一并回归，避免升级后指向旧端口/旧资源目录。
- **两套宿主并存**：IDEA 版（`src/main/resources/html/claude-chat.html`）仍吃单文件。`copy-dist.mjs` 要同时产出「单文件给 IDEA」和「拆分产物给 HBuilderX」，别把上游的构建链改坏——这也是后续 merge 的冲突点，改动要集中在 `copy-dist.mjs` 和一个新的 vite 配置里。
- **CSP**：目前注入的 HTML 没有设 CSP；如果将来加，要把选定路线的来源写进白名单。

---

## 六、下一步

1. 跑探针，把 A~H 结果回填到本文档（路线就此确定）。
2. 无论结果如何，先做「语言包按需」+「mermaid 不再拍平」，这两项吃掉大约 3.2 MB。
3. 路线确定后，再决定 TokenTracker 仪表盘是走「独立 webview 入口」（单文件路线下的必要妥协）还是直接作为一条普通路由按需加载（路线 1/2 下更自然）——移植方案 B4 的验收条款相应更新。

### 复现实测的构建配置

```ts
// 量各依赖真实体积：按包名分 chunk
rollupOptions: { output: { manualChunks(id) {
  const m = id.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
  if (m) return 'pkg-' + m[1].replace('/', '__');
} } }

// 量语言包/图标数据体积：把它们单独拉成 chunk
if (/src\/i18n\/locales\/[\w-]+\.json$/.test(id)) return 'data-locales';
if (/src\/utils\/icons\/(folder-icons|tech-icons-[123])\.ts$/.test(id)) return 'data-icons';
```
