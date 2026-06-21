# CC GUI — HBuilderX 插件

将 IDEA 版 CC GUI（Claude or Codex）移植到 HBuilderX。复用同一份前端（`../webview`）与
AI 桥接（`../ai-bridge`），仅用 Node.js 重写了原 Java/JCEF 胶水层。

## 架构

```
webview(React 单文件 HTML) ⟷ extension.js(HBuilderX 插件进程, Node16)
                                   ⟷ ai-bridge(用户系统 Node 子进程) ⟷ Claude/Codex CLI
```

- **桥接**：前端 `window.sendToJava("event:content")` 经 `hbuilderx.postMessage` 回流到宿主；
  宿主 `bridge.callJs(fn, ...args)` 经 `webview.postMessage` 调用前端 `window[fn](...args)`。
  shim 在 `lib/html-template.js` 注入，前端源码零改动。
- **运行时**：HBuilderX 内置 Node 仅 v16，因此 ai-bridge 由**用户系统 Node** 以子进程方式运行
  （阶段 1 接入）。

## 目录

| 文件 | 职责 | 对应 IDEA 实现 |
| --- | --- | --- |
| `extension.js` | 入口 activate/deactivate、命令注册 | ToolWindowFactory + ClaudeChatWindow |
| `lib/webview-host.js` | createWebView、加载/注入 HTML | WebviewInitializer + HtmlLoader |
| `lib/html-template.js` | 桥接 shim + 主题注入 | WebviewInitializer 注入 + HtmlLoader.injectIdeTheme |
| `lib/bridge-host.js` | 双向消息通道（dispatch + callJs） | ClaudeChatWindow.handleJavaScriptMessage/callJavaScript |
| `lib/message-router.js` | 出站事件 -> ai-bridge；bootstrap 初始状态 | MessageDispatcher + 各 handler |
| `lib/node-detector.js` | 探测用户系统 Node | bridge/NodeDetector |
| `lib/ai-bridge-client.js` | 启动 daemon、NDJSON 协议、按 id 解复用 | provider/common/DaemonBridge |
| `lib/stream-adapter.js` | 解析 `[CONTENT_DELTA]` 等标记行 | provider/claude/ClaudeStreamAdapter |
| `lib/claude-session.js` | 装配消息列表、驱动前端回调 | session/ClaudeMessageHandler + MessageJsonConverter |
| `lib/permission-bridge.js` | 权限/Ask/Plan 文件 IPC 监听与响应 | permission/{PermissionRequestWatcher,FileProtocol,Service} + PermissionHandler |
| `lib/prefs.js` | 全局状态持久化（model/mode/provider/providers）到 pref.json | settings/CodemossSettingsService（替代 VSCode globalState） |
| Provider 管理（在 `message-router.js` 内） | get/add/update/delete/switch/sort_providers + 激活 provider env 注入 daemon | handler/provider/* + cc-switch |
| `html/claude-chat.html` | 前端构建产物（自动生成，勿手改） | 同名资源 |

## 构建与调试

1. 构建前端（生成 `html/claude-chat.html`）：
   ```bash
   cd ../webview && npm install && npm run build
   ```
   `scripts/copy-dist.mjs` 会把单文件产物同时复制到本目录 `html/`。
2. 安装 ai-bridge 依赖（首次必需，Claude/Codex SDK 在此）：
   ```bash
   cd ../ai-bridge && npm install
   ```
   开发态下 `lib/ai-bridge-client.js` 会自动解析到仓库根的 `../ai-bridge`；
   发布时需把 `ai-bridge/` 一并打进插件目录。
3. 在 HBuilderX 中打开本目录 `hbuilderx-plugin/`，菜单 **运行 → 运行插件** 启动调试子窗体。
4. 子窗体中通过命令「打开 CC GUI 助手」或 **视图 → 显示扩展视图** 打开右侧 CC GUI 面板。
5. 查看 **OutputChannel「CC GUI」**：应能看到 `使用 Node: ...`、`ai-bridge ready`；
   发送一条消息后能看到 Claude 流式回复。

> 运行时说明（实测）：本机 HBuilderX 内置 Node 为 **v18.20.0**（`D:\HBuilderX\plugins\node\node.exe`），
> 满足 Claude/Codex SDK 的 `engines >=18` 且含全局 fetch，可直接用于跑 ai-bridge。
> `node-detector` 优先级：`ccgui.nodePath`(显式) → **HBuilderX 内置 Node（process.execPath，≥18 时采用）** → 系统 Node。
> 这与官方 `hbuilderx-ai-chat` 插件一致（其用 `process.execPath` fork 子进程）。
> 仅当内置 Node < 18（旧版 HBuilderX）时才回退系统 Node，并在 OutputChannel 提示。
>
> SDK 安装位置：`~/.codemoss/dependencies/claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk`
> （与 IDEA 版 DependencyManager 一致；本仓库联调时已手动安装）。
>
> 状态持久化：HBuilderX 不支持 VSCode 的 `context.globalState`（官方 AI 教程指出），
> 故 model/mode/provider 选择持久化到 `${hx.env.appData}/extensions/ccgui/pref.json`（见 `lib/prefs.js`），
> 重启后由 `bootstrap()` 恢复。输入历史由 webview 的 localStorage 持久化（无需宿主参与）。

## 联调状态（本机已完成的预检）

- ✅ webview 已构建，`html/claude-chat.html` 就位（5.9MB 单文件）。
- ✅ ai-bridge 依赖已装；Claude SDK 已装到 `~/.codemoss/dependencies/claude-sdk`。
- ✅ **真实 daemon 冒烟**：用 `AiBridgeClient` 拉起真实 `ai-bridge/daemon.js`，成功动态导入 Claude Agent SDK（`sdkPreloaded:true`，exports 含 `query`）。
- ⏳ 待真机：HBuilderX 内 webview 渲染 + postMessage 桥接；一次真实带鉴权的 API 回复。

> 鉴权：未移植 provider/API Key 管理（属阶段 3）。真机要拿到真实回复，需本机已 `claude` 登录
> （存在 `~/.claude` 凭据）或设置 `ANTHROPIC_API_KEY` 环境变量——ai-bridge 的 api-config 会读取 `~/.claude/settings.json`。

## 阶段进度

- [x] 阶段 0：脚手架 + 桥接冒烟
- [x] 阶段 1：发消息 + 流式回复（接 ai-bridge 子进程）—— 逻辑层已单测通过，待 HBuilderX 真机联调
- [x] 阶段 2：权限/Ask/Plan 文件 IPC + 新建/中断/续聊会话 —— 文件 IPC 往返已单测通过
  - 已覆盖：权限弹窗、AskUserQuestion、Plan 审批（不通则工具调用会卡住，这是阶段 2 核心）；新建会话、中断、按 id 续聊
  - 暂缓到阶段 3：历史列表浏览/搜索/删除/导出、收藏、历史消息 UI 重放（依赖会话 JSONL/DB 转换）
- [ ] 阶段 3：历史浏览 / 文件跳转 / 主题同步 / MCP / Agent 等增强
