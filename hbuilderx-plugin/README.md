# hbuilderx-cc-gui — HBuilderX 插件

将 IDEA 版 CC GUI（Claude or Codex）移植到 HBuilderX。复用同一份前端（`../webview`）与
AI 桥接（`../ai-bridge`），仅用 Node.js 重写了原 Java/JCEF 胶水层。

- 仓库：<https://github.com/wcj343169893/hbuilderx-cc-gui>
- 插件 id（package.json `name`）：`hbuilderx-cc-gui`；发布者：重庆柔然科技有限公司
- 本插件基于开源项目 <https://github.com/zhukunpenglinyutong/jetbrains-cc-gui> 移植（MIT），感谢原作者。

> 本文件含**面向用户的「使用说明」**（见下一节）与**插件模块的开发/架构说明**。
> 更完整的产品介绍见仓库根目录的 [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md)。

## 使用说明

上手步骤：**装 SDK → 配供应商 → 选项目 → 开聊**。

### 1. 准备 Node 环境

需要 **Node.js ≥ 18**。插件默认优先用 **HBuilderX 内置 Node**（实测 v18.20.0），多数情况无需配置。
若要指定自带的 Node，到 **设置 → 基础配置 → Node.js 路径**（配置项 `ccgui.nodePath`，Windows 须以 `node.exe` 结尾）。
探测优先级：`ccgui.nodePath` → 内置 Node(≥18) → 系统 PATH 上的 Node。

### 2. 安装 SDK（首次必做）

插件**不内置** Claude/Codex 的 Node SDK（体积大、含平台相关二进制，不随插件分发），首次使用需**联网安装**：

1. 打开 CC GUI 面板 → **设置 → 依赖**；
2. 对要用的 **Claude SDK** / **Codex SDK** 点「安装」（连 npm registry，3 分钟超时、自动重试）；
3. 安装到 `~/.codemoss/dependencies/`，面板支持**选版本 / 升级 / 卸载 / 检查更新**，并实时显示日志。

> 未安装 SDK 时对话会报 `SDK_NOT_INSTALLED`。离线环境可预先手动把对应包装到上述目录。

### 3. 配置供应商（API Key / 登录）

到 **设置 → 供应商管理**，Claude 与 Codex 分别配置，支持多种接入方式：

- **官方直连**：填入 API Key（Claude 形如 `sk-ant-...`）；
- **第三方 / 代理预设**：内置智谱 GLM、Kimi K2、DeepSeek、MiniMax、小米 MiMo、阿里千问、OpenRouter，或自定义 Base URL；
- **复用 CLI 登录**（终端 `claude login` 的会话）/ 读取本地 `~/.claude/settings.json`（需一次性授权）/ 从 **cc-switch** 导入。

> 供应商配置写入 `~/.codemoss/config.json`，**默认不改动**你的 `~/.claude/settings.json`。

### 4. 选择项目

HBuilderX 左侧可同时打开多个项目，因此每个会话需**绑定到具体项目**。
会话名后会显示当前项目名（文件夹图标），**点击即可切换**；切换会开启新会话。

### 5. 开始对话

- **打开面板**：底部状态栏图标 / 快捷键 `Ctrl+Alt+C` / 命令「打开 CC GUI 助手」（资源管理器右键也可「发送到 CC GUI」）；
- 在输入框顶部**选择模型与模式**，输入问题发送（`Enter` 或 `Ctrl+Enter`）；
- 输入框支持：`@` 引用文件、`/` 斜杠命令、`#` 调用 Agent、`!` 插入提示词、粘贴 / 上传图片；
- 在编辑器中**选中代码后按 `Ctrl+Alt+A`**（或右键发送），会带文件路径与行号送入对话；
- AI 调用工具 / 改文件前会弹**权限确认**（含执行计划的 Plan 批准、AI 反问你的 Ask 卡片）。

### 支持哪些模型

> 模型列表随版本更新，最终以面板实际可选项为准。

- **Claude**：Opus 4.8、Opus 4.7、Fable 5、**Sonnet 4.6（默认）**、Haiku 4.5；Opus 系列可启用 **1M 上下文**。
- **Codex（GPT）**：GPT-5.5、GPT-5.4、GPT-5.4-Mini、GPT-5.3-Codex、GPT-5.3-Codex-Spark、GPT-5.2、GPT-5.2-Codex、GPT-5.1-Codex-Max、GPT-5.1-Codex-Mini。
- 还支持在面板中**添加自定义模型**。

### 支持哪些功能

- **对话**：多会话 / 多标签页、流式回复、随时中断、思考过程展开、Token 与上下文用量统计；
- **输入**：`@` 文件引用、图片（JPEG/PNG/GIF/WebP/SVG）、`/` 斜杠命令、`#` Agent、`!` 提示词库、发送编辑器选中代码；
- **历史**：浏览 / 搜索 / 深度全文检索、收藏、续聊与重放、标题手改或 AI 自动生成、导出；
- **代码**：Diff 可视化（可配默认展开与配色主题）；
- **扩展**：MCP 服务器、Skills 技能、Agents 智能体、Prompts 提示词库（全局 / 项目级）；
- **其他**：提示词增强、Git 提交信息生成、权限审批、用量与费用估算、主题 / 语言 / 字体 / 音效个性化。

> 技能 / Agent / MCP / 依赖联网安装等高级功能后端逻辑已就绪，真机点按体验建议参考文末「阶段进度」。

## 架构

```
webview(React 单文件 HTML) ⟷ extension.js(HBuilderX 插件进程, 内置 Node ≥18)
                                   ⟷ ai-bridge(Node 子进程) ⟷ Claude/Codex SDK/CLI
```

- **桥接**：前端 `window.sendToJava("event:content")` 经 `hbuilderx.postMessage` 回流到宿主；
  宿主 `bridge.callJs(fn, ...args)` 经 `webview.postMessage` 调用前端 `window[fn](...args)`。
  shim 在 `lib/html-template.js` 注入，前端源码零改动。
- **运行时**：ai-bridge 由 Node 子进程运行。优先使用 **HBuilderX 内置 Node（实测 v18.20.0）**，
  满足 Claude/Codex SDK 的 `engines >=18` 且含全局 fetch；仅在内置 Node < 18 时回退系统 Node。

## 目录

| 文件 | 职责 | 对应 IDEA 实现 |
| --- | --- | --- |
| `extension.js` | 入口 activate/deactivate、命令注册、状态栏图标 | ToolWindowFactory + ClaudeChatWindow |
| `lib/webview-host.js` | createWebView、加载/注入 HTML | WebviewInitializer + HtmlLoader |
| `lib/html-template.js` | 桥接 shim + 主题注入 | WebviewInitializer 注入 + HtmlLoader.injectIdeTheme |
| `lib/bridge-host.js` | 双向消息通道（按首个冒号拆 event:content + callJs） | ClaudeChatWindow.handleJavaScriptMessage/callJavaScript |
| `lib/message-router.js` | 出站事件 -> ai-bridge；bootstrap 初始状态；各面板 dispatch | MessageDispatcher + 各 handler |
| `lib/node-detector.js` | 探测用于跑 ai-bridge 的 Node（优先内置 ≥18） | bridge/NodeDetector |
| `lib/ai-bridge-client.js` | 启动 daemon、NDJSON 协议、按 id 解复用 | provider/common/DaemonBridge |
| `lib/stream-adapter.js` | 解析 `[CONTENT_DELTA]` 等标记行 | provider/claude/ClaudeStreamAdapter |
| `lib/claude-session.js` | 装配消息列表、驱动前端回调 | session/ClaudeMessageHandler + MessageJsonConverter |
| `lib/permission-bridge.js` | 权限/Ask/Plan 文件 IPC 监听与响应 | permission/* + PermissionHandler |
| `lib/prefs.js` | 全局状态持久化（model/mode/provider/providers）到 pref.json | settings/CodemossSettingsService |
| `lib/skills-service.js` | 技能扫描/启停/导入（`.claude/skills` ↔ `.codemoss/skills`） | handler/skills + SkillsManager |
| `lib/history-service.js` | 历史列表/搜索/重放/收藏/标题（会话 JSONL + sidecar） | handler/history + 各 service |
| `lib/agent-service.js` | Agent CRUD/导入导出（`~/.codemoss/agent.json`） | AgentManager + AgentHandler |
| `lib/mcp-service.js` | MCP 配置 CRUD + 实时状态/工具（`~/.claude.json` + daemon RPC） | McpManager + McpHandler |
| `lib/dependency-service.js` | **SDK 联网安装/卸载/升级/版本查询**（`~/.codemoss/dependencies`） | dependency/DependencyManager + DependencyHandler |
| Provider 管理（在 `message-router.js` 内） | get/add/update/delete/switch/sort + 激活 provider env 注入 daemon | handler/provider/* + cc-switch |
| `html/claude-chat.html` | 前端构建产物（自动生成，勿手改，已 gitignored） | 同名资源 |

## 构建与调试

1. 构建前端（生成 `html/claude-chat.html`）：
   ```bash
   cd ../webview && npm install && npm run build
   ```
   `scripts/copy-dist.mjs` 会把单文件产物同时复制到本目录 `html/`。
2. 安装 ai-bridge 自身依赖（仅 `sql.js`，用于读 cc-switch 数据库）：
   ```bash
   cd ../ai-bridge && npm install
   ```
   开发态下 `lib/ai-bridge-client.js` 会自动解析到仓库根的 `../ai-bridge`；
   发布时需把 `ai-bridge/`（含其 `node_modules`）一并打进插件目录。
   > 注意：**Claude/Codex SDK 不在 ai-bridge 依赖里、也不随插件打包**，需另行安装（见下节）。
3. 在 HBuilderX 中打开本目录 `hbuilderx-plugin/`，菜单 **运行 → 运行插件** 启动调试子窗体。
4. 子窗体中通过命令「打开 CC GUI 助手」（或 `Ctrl+Alt+C` / 底部状态栏图标）打开右侧 CC GUI 面板。
5. 查看 **OutputChannel「CC GUI」** 或 `~/.codemoss/ccgui-debug.log`：应能看到 `使用 Node: ...`、
   `ai-bridge ready`；配置好 Provider/SDK 后发送一条消息能看到流式回复。

> 改动 `lib/*.js` 后**必须完全关闭插件调试子窗体再重新「运行插件」**——PluginHost 用 `require` 缓存
> 模块，仅重开视图不会重载新代码。

## 发行 / 打包（其他电脑安装必读）

插件被安装到 `HBuilderX/plugins/<id>/` 后是**独立目录**，没有仓库其余部分。因此发行前该目录
**必须自包含**这两样运行时产物，否则在别的电脑启动会报：

- `读取 HTML 失败: ENOENT ... \html\claude-chat.html` —— 缺 webview 构建产物
- `ai-bridge 启动失败: 未找到 ai-bridge 目录（daemon.js）` —— 缺桥接（它原本在仓库根，不在插件目录内）

发行步骤（缺一不可）：

```bash
# 1) 构建前端（生成 hbuilderx-plugin/html/claude-chat.html）
cd webview && npm install && npm run build
# 2) 安装 ai-bridge 依赖（sql.js）
cd ../ai-bridge && npm install
# 3) 把 ai-bridge 内置进插件目录（生成 hbuilderx-plugin/ai-bridge/，含 sql.js）
cd ../hbuilderx-plugin && npm run bundle
```

完成后 `hbuilderx-plugin/` 即自包含，可在 HBuilderX 里「发行 → 上传插件市场」，或整目录拷到
`HBuilderX/plugins/<id>/`。`lib/ai-bridge-client.js` 的 `resolveAiBridgeDir` 会优先用内置的
`hbuilderx-plugin/ai-bridge/`，开发态才回退仓库根的 `../ai-bridge`。

> **关于 .gitignore 与上传**：插件市场上传会按**插件目录内**的 `.gitignore` 过滤文件，所以
> `hbuilderx-plugin/` 内**不放任何 `.gitignore`**（`bundle.js` 复制 ai-bridge 时会剥掉所有 `.gitignore`）。
> `html/claude-chat.html` 与 `hbuilderx-plugin/ai-bridge/` 仍是生成产物、勿提交，但忽略规则只写在
> **主仓库根** `.gitignore`（上传不读根 ignore，故能正常打进包；git 也不会跟踪它们）。发行前用上面三条命令重新生成。
> **Claude/Codex SDK 不在包内**，由用户首次在「设置 → 依赖」联网安装到 `~/.codemoss`（见下节）。

## 依赖 / SDK 安装（重要）

本插件**不打包** Claude/Codex 的 Node SDK（claude-sdk 实测约 251MB，且含平台相关二进制，
不适合随插件分发）。SDK 由 `ai-bridge/utils/sdk-loader.js` 在运行时从用户目录动态加载：

```
~/.codemoss/dependencies/claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk
~/.codemoss/dependencies/codex-sdk/node_modules/@openai/codex-sdk
```

未安装时会抛 `SDK_NOT_INSTALLED`，对话无法进行。安装方式：

- **插件内一键安装（推荐）**：打开 CC GUI → **设置 → 依赖**，对 Claude / Codex SDK 点「安装」。
  该面板后端为 `lib/dependency-service.js`，移植自 IDEA `DependencyManager`，执行
  `npm install --include=optional --prefix <sdkDir> <pkg@版本>`（3 分钟超时 + 重试），实时回灌日志，
  支持选版本/升级/卸载/检查更新。**需要网络**（连 npm registry）；离线环境请预先手动安装到上述目录。
- npm 解析：优先 `spawn(node, [npm-cli.js, ...])`（无 shell，规避 Windows 下 `.cmd` 把包名里的
  `^` 当转义符的坑）。HBuilderX 内置 Node 目录通常没有 npm，会回退借用 PATH 上系统 Node 的
  `npm-cli.js`（用所选 node 去跑，纯 JS 版本无关）。
- 前提：可用的 **Node ≥18**（`node-detector` 优先级：`ccgui.nodePath` → 内置 Node(≥18) → 系统 Node）。

> 提示：SDK **首次**安装后无需重启即可使用（loader 每次发送都会 `existsSync` 检查，缓存只存成功加载）；
> 但**重装/切换版本**后 daemon 内可能仍缓存旧 SDK 模块，需关闭重开插件以清缓存。

## 运行时说明

- 状态持久化：HBuilderX 不支持 VSCode 的 `context.globalState`，故 model/mode/provider 选择持久化到
  `${hx.env.appData}/extensions/ccgui/pref.json`（见 `lib/prefs.js`，内部 `PLUGIN_ID='ccgui'` 未随
  包名改动）；重启后由 `bootstrap()` 恢复。输入历史由 webview 的 localStorage 持久化。
- Provider key/baseURL 走 `~/.codemoss/config.json`（`claude.providers` + `current`），并 patch 了
  `ai-bridge/config/api-config.js`，**刻意不碰用户的 `~/.claude/settings.json`**。
- 权限/Ask/Plan 走文件 IPC：daemon 写 `CLAUDE_PERMISSION_DIR` 下 request 文件并轮询 response，
  宿主 `permission-bridge.js` 据前端决定写 response。

## 阶段进度

- [x] 阶段 0：脚手架 + 桥接冒烟
- [x] 阶段 1：发消息 + 流式回复（接 ai-bridge 子进程）
- [x] 阶段 2：权限/Ask/Plan 文件 IPC + 会话新建/中断/续聊
- [x] 阶段 3：历史浏览/搜索/重放/收藏、文件跳转、IDE 主题同步、Provider 管理（含 DeepSeek）、
  斜杠命令、快捷键 + 右键菜单入口、底部状态栏图标、Skills / Agent / MCP 面板后端、
  **SDK 依赖联网安装面板**
- [ ] 待办：@file 输入框 `@` 补全；技能/Agent/MCP 与依赖安装的真机首验；
  daemon 清 SDK 缓存 RPC（让重装/换版本即时生效）

> 真机验证：逻辑层已自测/冒烟通过；HBuilderX 内 webview 渲染 + postMessage 桥接、一次真实带鉴权的
> API 回复、依赖面板实际 `npm install` 等仍建议在真机点按操作确认。
