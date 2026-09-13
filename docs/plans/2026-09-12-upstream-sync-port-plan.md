# 上游（jetbrains-cc-gui）新功能移植方案

- 日期：2026-09-12
- 上游仓库：https://github.com/zhukunpenglinyutong/jetbrains-cc-gui （本仓库的 fork 源）
- 目标：把上游 v0.4.6 ~ v0.5.5 期间新增的功能，成体系地移植到 HBuilderX 版（本仓库），并建立**常态化同步机制**，不再出现一次性落后 10+ 个版本的情况。

---

## 一、现状量化

| 项目 | 数据 |
|---|---|
| 共同祖先（merge base） | `4a41b9bb`（上游 `Merge PR #1276 / feature/v0.4.5`，2026-06-12） |
| 上游最新 | v0.5.5（2026-09-01） |
| 上游自 merge base 起的提交 | **540** 个 |
| 本仓库自 merge base 起的提交 | **54** 个 |
| 上游改动文件数 | webview 501 / src(Java) 320 / ai-bridge 140 |
| 本仓库改动文件数 | hbuilderx-plugin 85 / webview 56 / ai-bridge 9 / src 3 / e2e 13 |
| **两侧同时改过的文件（冲突候选）** | **54 个**（其中 10 个是 i18n 语言包，1 个是 `version/changelog.ts`） |
| 前后端契约现存缺口 | **26 个**（`node hbuilderx-plugin/scripts/check-message-contracts.js`，当前退出码 1） |
| 上游前端事件总数 / 本仓库 | 187 / 160，其中 **49 个上游事件本仓库 webview 尚无** |

### 关键结论

1. **本仓库与上游有共同祖先，可以走真正的 `git merge`**，不需要手工对拷文件。这是本方案的基础。
2. 两侧同改文件只有 54 个，且本仓库一侧的改动普遍只有几十行（最大的 `version/changelog.ts` 属于「本仓库独占」文件，直接取 ours）。**冲突是可控的，前提是按上游 tag 分批合并，而不是一次性 merge main。**
3. 真正的工作量不在合并，而在**第三层**：上游新功能的后端是 Java（`src/main/java`），HBuilderX 版必须在 `hbuilderx-plugin/lib/*.js` + `message-router.js` 里重写一份。新增了 147 个 Java 文件，其中约 21 个是 handler/service 级别的新后端。

---

## 二、三层架构与工作量归属

本仓库保留了上游完整目录结构，移植工作按层拆分：

| 层 | 目录 | 上游技术栈 | 移植方式 | 工作量 |
|---|---|---|---|---|
| 前端 | `webview/` | React + TS（与 IDE 无关） | **直接 git merge**，只解决 fork 适配点冲突 | 低（冲突解决） |
| 桥接 | `ai-bridge/` | Node（与 IDE 无关） | **直接 git merge**，新增 channel/service 原样可用 | 低 |
| IDE 宿主 | 上游 `src/`（Java） → 本仓库 `hbuilderx-plugin/`（JS） | IntelliJ Platform | **必须重写**：每个新 Java handler → JS service + `message-router.js` 的 case | **高（占 80%）** |

`src/`（Java）仍然 merge 进来，但**不投入编译与维护**，只作为两个用途：(1) 重写 HBuilderX 后端时的参考实现；(2) 保持后续 merge 的干净度（不删除可避免每次 merge 都产生 delete/modify 冲突）。

### 前端唯一的「缺了就静默失效」风险点

`webview` 合并进来后，前端会发出后端不认识的事件，走 `default` 分支静默丢弃，表现为「点了没反应 / 一直转圈」。本仓库已有治本工具：

```bash
node hbuilderx-plugin/scripts/check-message-contracts.js   # 缺口非空则 exit 1
```

**每个批次的验收门禁都以这个脚本为准**，并在批次结束前把缺口清零（实现 case，或登记进 `INTENTIONALLY_UNHANDLED` 白名单并写明理由）。

---

## 三、总体策略

### 3.1 按上游 tag 逐版本合并（不要一次性 merge main）

```bash
git remote add upstream https://github.com/zhukunpenglinyutong/jetbrains-cc-gui
git fetch upstream main
git fetch upstream 'refs/tags/*:refs/tags/up-*'
git checkout -b sync/up-v0.4.7     # 每批一个分支
git merge up-v0.4.7                # 解冲突 → 补后端 → 验收 → 合回 main
```

理由：540 个提交一次性 merge，冲突会在 54 个文件里叠加成一团，且一旦出问题无法二分定位。逐 tag 合并后，每一批都是「可构建、可自测、可发版」的状态。

> **门禁前提（已满足，2026-09-13）**：B0 的三项既有测试失败已修、26 个契约缺口已清零、
> CI 门禁已接入 `.github/workflows/hbuilderx-ci.yml`，`npm test`（vitest + tsc 两段）与
> e2e 套件现在是可信门禁，下面每批次的「验收」有了依据，可以开始 B1。
> 清单与定位见 `docs/plans/2026-09-12-known-test-failures.md`。

### 3.2 每个批次固定四步

1. **merge**：`git merge up-vX.Y`，按第四节的归属规则解冲突；只解冲突，不顺手改业务逻辑。
2. **补后端**：跑契约校验，对每个新缺口在 `hbuilderx-plugin/lib/` 新增 service + 在 `message-router.js` 补 case；参照对应 Java handler 的行为。
3. **验收**：
   - `cd webview && npm run build`（单文件产物必须构建成功，并记录 `html/claude-chat.html` 体积变化）
   - `node hbuilderx-plugin/scripts/check-message-contracts.js` 缺口为 0
   - webview 单测 + `e2e/` 无头回归套件通过
   - HBuilderX 内手工走一遍该批次的新功能主路径
4. **提交**：一个批次一个 release（版本号 +0.0.1），`changelog.ts` 追加本批次条目（只写实际已生效的功能，没移植的不写）。

### 3.3 批次划分

| 批次 | 上游版本 | 规模（webview/ai-bridge/java 文件） | 主要新功能 | 需新增的 HBuilderX 后端 |
|---|---|---|---|---|
| B0 | —（前置） | — | **已完成（2026-09-13）**：清理现存 26 个契约缺口；修 3 项既有测试失败（`ModelSelect` 单测过时、e2e `resume-replay` 幽灵气泡、测试目录 tsc 类型错误，详见 `docs/plans/2026-09-12-known-test-failures.md`）；基线全绿后把契约校验 + webview 单测 + e2e 接入 `.github/workflows/hbuilderx-ci.yml` | 26 个 case（详见 3.4，已全部实现或登记白名单） |
| B1 ✅ | v0.4.6 | 54/23/38 | 权限模式热切换；**安全加固组**（默认 `default` 模式、PreToolUse 对 Bash/Agent 返回 `ask`、拦截 `NODE_OPTIONS`/`LD_PRELOAD`/`DYLD_*`、"始终允许"收敛到命令级、MCP stdio 元字符拒绝、`npm install --ignore-scripts`、配置文件 0600、危险路径检查扩展到 Bash 串与 `~`、Codex 沙箱默认 `workspace-write`） | `permission-bridge.js` / `permission-safety.js` 对齐；`dependency-service.js` 加 `--ignore-scripts`；配置写入权限 0600 |
| B2 ✅ | v0.4.7 | 49/14/76 | MCP Marketplace（内置/官方 Registry/GitHub Registry 多源 + 磁盘缓存）；从 Copilot 配置导入 MCP；自定义模型自定义单价；AskUserQuestion 通知开关；消息尾部「详细输出」开关；GPT-5.6 Sol/Terra/Luna（本仓库已自行实现，合并时以上游实现为准） | `mcp-marketplace-service.js`（对应 `McpMarketplaceService` + 4 个 client）、`mcp-service.js` 扩展导入能力、`model-pricing-service.js`；case：`get_mcp_marketplace_sources`、`search_mcp_marketplace`、`parse_copilot_mcp_config`、`set_custom_model_pricing` |
| B3 | v0.4.8 | 102/27/93 | 异步子代理生命周期跟踪（时长/token/用量，不再卡在 running）；Fable 档位贯通；Codex GPT-5.6 max reasoning 与模型别名 | `history-service.js` 分页：`load_codex_history_page`；子代理状态上报链路 |
| B4 | v0.4.9 | 220/3/76 | **TokenTracker 用量仪表盘（完整移植）**；MCP Claude/Codex 分页隔离；Codex provider 从 cc-switch 导入 + OpenAI 直连/预设大扩充；KaTeX 数学公式渲染；`/goal`；Codex skill 递归发现；SDK ≥0.3.182 校验。（Codex Pet 从本批次**移出**，见 B11） | **最重的一批**。`tokentracker-gateway.js`（探测/安装 `tokentracker-cli`、挑空闲端口串行起服、白名单转发 `tt_proxy`）+ **仪表盘独立 webview 入口**（`usage.html`，按需创建，不进主面板单文件）；`update_codex_mcp_server`；Codex cc-switch 导入 3 个 case。验收加一条：主面板 HTML 体积与 B3 持平 |
| B5 | v0.5 | 133/36/70 | **多 CLI 引擎第一波：Grok / Kimi / OpenCode / PI**（`ai-bridge` 新增 4 个 channel + 对应 service 目录）；Grok 常驻多轮 ACP daemon；Grok 500k 上下文环；Codex 自定义模型上下文窗口；Codex 从 `config.toml`/catalog 取模型；`@file` 可点击引用；通知声音 + 仅失焦时通知；Commit AI 流式；输入栏主题色 | CLI 探测与模型发现：`cli-status-service.js`（对应 `CliStatusDetector`）、`cli-models-service.js`；case：`get_cli_status`、`get_cli_models`、`set_system_notification_only_when_unfocused`、`set_ask_user_question_sound_notification_enabled`、`surface_damage_applied`、`history_dom_committed`；Commit AI 先做 spike（有 API 则按上游；无则降级为面板内流式 + 复制到剪贴板，diff 走本地 git 命令） |
| B6 | v0.5.1 | 93/31/45 | PI/OpenCode/Kimi 会话历史读取（含 OpenCode 1.x SQLite）；历史模型/agent 还原 + 多引擎导出；Grok 动态模型发现；**引用选中文本进输入框**（Ctrl/Cmd+Shift+Q）；Prompt Enhancer / Commit AI 扩展到 6 引擎；CLI 图片附件；`/mcp`；模型收藏置顶与厂商分组 | `history-service.js` 接入各引擎 reader；`enhance_prompt` 契约重新对齐（本仓库当前未发该事件） |
| B7 | v0.5.2 | 35/15/16 | 子代理进程详情展示原始 prompt | `load_subagent_statuses` |
| B8 | v0.5.3 | 74/53/55 | **DeepSeek Harness (DSH)**：WebSocket 桥、流式文本/思考、工具调用、审批与提问、模型发现、多轮会话、历史管理 | `dsh-service.js`（对应 `DshHostHandler`，管理 daemon 生命周期）；case：`get_dsh_status`、`start_dsh_host`、`stop_dsh_host`、`save_dsh_settings` |
| B9 | v0.5.4 | 146/36/99 | **OMP (Oh My Pi) provider**；**Claude plan-usage 进度条**（5h/7d 窗口消耗速度配色，z.ai/GLM 走 monitor quota）；DSH agent preset 切换；模型/effort/speed/1M 收进紧凑下拉；Codex Pet 扩展 | `plan-usage-service.js`（对应 `ClaudePlanUsageService`）；`set_dsh_preset`；OMP channel 仅需桥接透传 |
| B10 | v0.5.5 | 54/12/25 | 变更日志弹窗开源横幅 + Star；CLI provider 可隐藏 + CLI 设置深链；设置页社区区块重做（外链走系统浏览器）；品牌/README 更新为多引擎 | 外链打开走 HBuilderX API；品牌文案保持本仓库自有（不取上游） |
| B11 | —（本仓库自有） | — | **Codex Pet 重做**：webview 内精灵图渲染器 + 宿主资产服务（本地宠物 → petdex 安装 → hatch 孵化） | `codex-pet-service.js` + 16 个 pet case；详见 `docs/plans/2026-09-12-codex-pet-hbuilderx-design.md` |

> 规模列是该 tag 相对上一个 tag 的改动文件数，用于排期参考，不等于工作量。

### 3.3.1 执行记录与对本方案的勘误（随批次滚动更新）

> 合并用 `git merge up-vX.Y`（tag 已按 `refs/tags/*:refs/tags/up-*` 取到本地）。
> 注意仓库初始是 **浅克隆**，必须先 `git fetch --unshallow origin` 才能算出 merge-base。

| 批次 | 状态 | 合并到 | 冲突数 | 新增契约缺口 | 主面板产物 |
|---|---|---|---|---|---|
| B0 | ✅ 2026-09-13 | — | — | — | 2.17 MB |
| B0d | ✅ 2026-09-13 | — | — | 门禁修正，暴露 46+1 既有欠账 | — |
| B1 | ✅ 2026-09-13 | `up-v0.4.6-fix` | 6 | 0 | 2.25 MB |
| B2 | ✅ 2026-09-13 | `up-v0.4.7` | 3 | 6（已清零） | 2.30 MB |

**B0d（插入批次）：契约门禁此前在说谎。**
校验脚本的正则要求事件名后紧跟闭合引号，看不见本仓库大量使用的冒号形式
（`sendToJava('get_streaming_enabled:')`、`` sendToJava(`set_ui_font_config:${...}`) ``），
所以长期报「缺口=0」，实际欠着 **46 个**；入站方向（宿主 `callJs` → 前端 `window.x =` 注册）
则完全没查，查出 1 处真实空转（`taskHealthUpdate`）。已修正正则、补上入站校验，并引入
`KNOWN_GAPS` / `KNOWN_INBOUND_GAPS` 欠账清单：清单内不阻断门禁，**清单外的新缺口一律失败**，
清单内已实现的条目也失败（强制清单只减不增）。每条欠账都标了归属批次。
**这意味着 3.2 节「验收」的第二条要改读法**：不再是「缺口为 0」，而是「**新增**缺口为 0，
且欠账清单只减不增」。门禁自身也有了测试（`hbuilderx-plugin/scripts/check-message-contracts.test.js`）。

**对 3.3 节 B2 行的勘误（有证据，见 B2 合并提交）：**
- 「GPT-5.6 Sol/Terra/Luna（本仓库已自行实现，合并时**以上游实现为准**）」——**错**。上游 0.4.7
  最高只到 `gpt-5.5`，这三个模型是本仓库 `eda243dc` 自己加的。按原文处理会静默删掉它们，
  且契约校验与单测都发现不了。正确做法：`types.ts` / `ModelSelect.tsx` 的 **Claude 段取上游、
  Codex 段取 ours**。0.4.7 实际改的是 Claude 模型表（删 `claude-opus-4-7`、加 `claude-sonnet-5`）。
- 「消息尾部『详细输出』开关」**不在 0.4.7**，在 0.4.8 → 归 **B3**。

**B1 的一处附带修正**：本仓库原先把 esbuild 选项写在 `build.esbuild` 下，Vite 不读该位置，
等于 `drop: ['console']` 从未生效。合并时按上游改到顶层 `esbuild`，同时采纳上游的
`keepNames: true`（ErrorBoundary 提取组件链所需，生产诊断用）。代价约 70 KB——
2.17 → 2.25 MB 的增量里，功能内容本身只占约 10 KB。

**B4 开工前必须先做的 spike（来自 B4 侦察，写在这里以免遗忘）：**
1. `tokentracker-cli` 要求 **node ≥ 20**。HBuilderX 内置 Node 若低于 20，整条通路起不来——
   不达标就在探测阶段直接返回明确原因，别让用户点了安装再失败。
2. `usage.html` 是独立 webview、独立桥，`tt_*` 四个 case 的回包必须发回**发起请求的那条桥**，
   需要给 `MessageRouter.dispatch` 加第三个 `bridge` 参数。写错的表现是仪表盘永远转圈且无报错。
3. **KaTeX 绝不能直接内联**：`vite-plugin-singlefile` 会把 `assetsInlineLimit` 强制覆盖成
   `() => true`，katex.css 的 60 个字体引用会全部 base64 化，主面板 +1.56 MB 直接翻倍。
   必须走已有的「资源通道」按需下发。
4. 契约脚本对 `sendToJava(type, ...)`（事件名是变量）和 `${prefix}` 拼接仍是盲区，
   B4 的 `tokentrackerBridge.ts` 正好是变量形式——需要配一张手工声明表，否则门禁会放行真实缺口。

---

### 3.4 B0 现存 26 个缺口（合并前必须先清）—— **已清零（2026-09-13）**

`clear_input_history`、`create_new_tab`、`delete_input_history_item`、`get_linkify_capabilities`、`get_mode`、`get_node_processes`、`get_selected_agent`、`get_thinking_enabled`、`get_usage_statistics`、`kill_all_orphans`、`kill_node_process`、`open_class`、`read_clipboard`、`record_input_history`、`refresh_file`、`restart_node_daemon`、`rewind_files`、`set_auto_open_file_enabled`、`set_selected_agent`、`set_send_shortcut`、`set_streaming_enabled`、`set_thinking_enabled`、`show_interactive_diff`、`undo_all_file_changes`、`undo_file_changes`、`write_clipboard`

处理原则：能实现的实现；HBuilderX 无对应 API 的（如 `open_class`）在前端隐藏入口**并且**登记白名单，避免留「能点不能用」的按钮。先清零的理由是：基线为 0 时，后续每批次的 `diff` 才能准确反映「这一批引入了哪些新缺口」。

**处理结果**（`node hbuilderx-plugin/scripts/check-message-contracts.js` 现已 0 缺口 exit 0）：

- **真正实现（22 个）**：设置类（`get_mode`/`get_thinking_enabled`/`set_thinking_enabled`/`set_streaming_enabled`/
  `set_send_shortcut`/`set_auto_open_file_enabled`/`get_selected_agent`/`set_selected_agent`，持久化走 `pref.json`）；
  输入历史镜像（`record_input_history`/`delete_input_history_item`/`clear_input_history`，新增
  `hbuilderx-plugin/lib/input-history-store.js`）；剪贴板（`read_clipboard`/`write_clipboard`，走
  `hx.env.clipboard`）；Node 进程面板（`get_node_processes`/`kill_node_process`/`kill_all_orphans`/
  `restart_node_daemon`，MVP：只管理宿主自身这一个 ai-bridge daemon 子进程，无 Java 版跨引擎注册表，
  不编造 CHANNEL/ORPHAN 数据）；文件操作（`refresh_file` 存在性校验+日志；`undo_file_changes`/
  `undo_all_file_changes` 按 Java UndoFileHandler 算法用 `fs` 直接读写；`rewind_files` 转发到
  daemon `claude.rewindFiles`，真正的文件回滚在 Claude Agent SDK 的文件检查点能力里，ai-bridge 侧
  已是完整实现，只补了 HBuilderX host 转发这一层）；`show_interactive_diff`（复用 `open_diff_editor`
  的 `.ccdiff` 自定义编辑器机制，加 `interactive:true` 渲染「应用/拒绝」按钮，见
  `hbuilderx-plugin/lib/diff-editor-provider.js`；顺手修复了该文件里潜伏的 `_notifyDiff` 未定义
  bug）；`get_linkify_capabilities`（如实回 `classNavigationEnabled:false`）；`get_usage_statistics`
  MVP（真实会话数 + 逐会话 token 用量，费用/逐模型聚合留给 B4 TokenTracker，不编造数字）。
- **隐藏入口 + 登记白名单（2 个）**：`create_new_tab`（HBuilderX 单例 webview 无 IntelliJ 多 tab
  概念，`ChatHeader.tsx` 的新建 tab 按钮改为按 `onNewTab` 是否传入条件渲染，`App.tsx` 不再传）；
  `open_class`（HBuilderX 非 Java IDE 无 PSI，`classNavigationEnabled` 恒为 false 已使前端自动隐藏
  入口，见 `webview/src/utils/linkify.ts`）。均登记进
  `hbuilderx-plugin/scripts/check-message-contracts.js` 的 `INTENTIONALLY_UNHANDLED` 白名单。

---

## 四、冲突解决规则（按文件归属预先定调）

合并时不要临场判断，按下表执行：

| 文件 / 范围 | 归属 | 规则 |
|---|---|---|
| `webview/src/version/changelog.ts` | **本仓库独占** | 取 ours；上游条目不并入（本仓库 changelog 走自己的版本线，`hbuilderx-plugin/changelog.md` 由 bundle 时自动生成） |
| `README.md` / `README.zh-CN.md` / 品牌文案 / `package.json` 的 id/publisher/version | **本仓库独占** | 取 ours；只手工吸收上游「功能说明」段落 |
| `webview/src/i18n/locales/*.json`（10 个） | **双向合并** | 取 theirs 为基底，再把本仓库新增的 key 追加回去（本仓库侧改动仅十几行，逐 key 核对） |
| `webview/src/utils/bridge.ts`、`webview/src/global.d.ts` | **适配层，需人工** | 取 theirs 的新增契约类型，保留本仓库的 HBuilderX 桥接实现；改完必须跑契约校验 |
| `webview/scripts/copy-dist.mjs` | **本仓库独占** | 取 ours（多了一份 HBuilderX 产物路径） |
| `ai-bridge/**` 本仓库改过的 9 个文件 | **以上游为基底** | 取 theirs，再把本仓库的修复重新 apply 上去（下面列明） |
| `src/main/java/**` | **全部取 theirs** | 不编译、不维护，仅作参考实现 |
| `hbuilderx-plugin/**` | **本仓库独占** | 上游不存在，不会冲突 |

### 必须在合并后重新确认仍然生效的本仓库自有修复

这些是本仓库在共享目录里打的补丁，取 theirs 后容易被冲掉，每批次 merge 后逐条回归：

- `ai-bridge/channels/codex-channel.js` / `services/codex/message-service.js`：Codex 中断真正终止本轮、错误透传 stdout、单次请求 config 覆盖
- `ai-bridge/services/claude/runtime-lifecycle.js` / `persistent-query-service.js`：中断后再发送看不到回复、后台仍在执行；按进程树清理孙进程防孤儿
- `ai-bridge/daemon.js`：版本号运行时读取插件 package.json
- `ai-bridge/utils/permission-mapper.js`：自动模式仍弹授权的修复
- `webview` 侧：DeepSeek 峰谷守卫/队列面板、整文件左右对比 DiffViewer、上下文百分比点击打开用量弹窗 + Compact、任务/子代理耗时与 token、会话项目名、uni-agent 技能面板
- 本仓库已自行实现、上游也有的功能（GPT-5.6 模型列表、Codex 订阅配额面板）：**统一改为以上游实现为准**，删除本仓库的重复实现，避免双份代码长期分叉

---

## 五、上游 Java handler → HBuilderX JS 映射表

移植第三层时按此表建文件，一个 Java handler 对应一个 JS service，保持命名可追溯：

| 上游 Java | 新增 `hbuilderx-plugin/lib/` | 批次 |
|---|---|---|
| `mcp/marketplace/McpMarketplaceService` + `BuiltIn/Registry/GitHubOrg/Http` 4 个 client + `handler/marketplace/McpMarketplaceHandler` | `mcp-marketplace-service.js` | B2 |
| `mcp/importer/McpServerImportService` + `handler/importer/McpServerImportHandler` | `mcp-import-service.js` | B2 |
| `handler/provider/CustomModelPricingHandler` + `settings/ModelPricing` + `provider/pricing/*` | `model-pricing-service.js` | B2 |
| `handler/TokenTrackerHandler` + 本地网关 | `tokentracker-gateway.js` | B4 |
| `cli/CliStatusDetector` + `cli/CliToolId` + `handler/CliStatusHandler` | `cli-status-service.js` | B5 |
| `handler/CliModelsHandler` + `provider/{grok,kimi,opencode,pi,omp}/*ModelsProvider` | `cli-models-service.js` | B5/B9 |
| `service/commit/CommitAIClient` 等 5 个文件 | `commit-ai-service.js`（依赖 spike 结果） | B5 |
| `handler/history/CodexExecHistoryReplay`、`CodexSubagentHistoryLoader` + 各引擎 reader | 扩展 `history-service.js` / `codex-history-service.js` | B3/B6 |
| `provider/dsh/*` + `handler/DshHostHandler` + `handler/DshPresetHandler` | `dsh-service.js` | B8/B9 |
| `provider/claude/ClaudePlanUsageService` + `handler/provider/claude/ClaudePlanUsageHandler` | `plan-usage-service.js` | B9 |
| `handler/CodexPetHandler` + `CodexPetFloatingService` | `codex-pet-service.js`（**取舍项**，见第六节） | 待定 |
| `util/IdeFocusState`、`ui/SurfaceFrameFence`、`OsrImeCaretFix`、`JcefModuleAvailability` | 不移植（IntelliJ/JCEF 专有） | — |

---

## 六、风险、取舍与需要先做的 spike

### 取舍决策（2026-09-12 已定，三项全做）

| 功能 | 决策 | 做法 |
|---|---|---|
| **Codex Pet（陪伴宠物）** | **做，但重做而非移植** | 上游是 IntelliJ Swing 浮窗（约 4150 行 Java），HBuilderX 无浮窗 API；改为「宿主只管资产与状态、渲染全在 webview」。可直接借鉴 MIT 的 [pet-viewer-for-codex](https://github.com/yutat23/pet-viewer-for-codex)（VS Code webview + 精灵图动画 + 读 `~/.codex/pets`，和上游同一套资产约定）与 [vscode-pets](https://github.com/tonybaloney/vscode-pets)。详见 `docs/plans/2026-09-12-codex-pet-hbuilderx-design.md`，排为独立批次 **B11** |
| **TokenTracker 仪表盘** | **完整移植** | 不只是补齐：本仓库的 `get_usage_statistics` 本来就在 26 个契约缺口里，也就是说**当前用量统计在 HBuilderX 版根本没实现**，仪表盘是在填真空洞，而不是替换一个能用的功能。数据通路沿用上游的 `tt_proxy` 桥接代理（webview 不直连 127.0.0.1），宿主侧新增 `tokentracker-gateway.js`：探测/安装 `tokentracker-cli` → 挑空闲端口串行起服 → 白名单转发。**额外要求（本仓库特有）**：仪表盘必须作为**独立 webview 入口**构建，不得并入主面板的单文件 HTML（理由见下「体积风险」），见 B4 验收 |
| **Commit AI 流式** | **按建议：先 spike，不行就降级** | spike：确认 HBuilderX 是否有可写入的源码管理/提交信息 API（上游走 Git4Idea 读 diff + 写 IDEA 提交面板）。有 → 按上游实现；无 → 降级为「在 CC GUI 面板内流式生成 + 一键复制到剪贴板」，并在设置页说明差异。diff 读取一律走本地 `git` 命令，不依赖 IDE 能力 |

### 体积风险（硬约束）

`webview` 构建产物是**单文件 HTML**（`webview/scripts/copy-dist.mjs` 把 `dist/index.html` 同时拷给 IDEA 与 HBuilderX）。这不是偷懒：`hbuilderx-plugin/lib/webview-host.js:92` 是 `webview.html = <字符串>`——**HBuilderX webview 吃的是 HTML 字符串，没有基准 URL，相对路径资源无法解析**，所以一切必须内联。

**实测基线（2026-09-12）：当前产物 5.81 MB（gzip 1.63 MB）**，其中 mermaid 全家桶 2.6 MB（45%，本应懒加载却被 `vite-plugin-singlefile` 拍平成必加载）、10 份语言包 754 KB。详细构成、拆分可行性与三条路线见 `docs/plans/2026-09-12-webview-asset-splitting.md`，并已备好一次性探针 `docs/testing/probe-hbuilderx-webview-assets/`。

B4 的 TokenTracker dashboard（含 vendored 组件、10 语言 i18n、品牌资源、3D 热力图）、KaTeX，以及 B5/B6 的多引擎 UI 都会在此基础上继续加码。对策已定：

1. **仪表盘独立入口**：`webview` 增加第二个 Vite 入口（如 `usage.html`）→ 产物 `hbuilderx-plugin/html/usage.html`，由宿主在用户打开用量面板时**按需**创建 webview（独立 view 或独立 tab），主面板 HTML 不受影响。数据仍走 `tt_proxy`，与上游一致。
2. **大资产不进构建**：宠物精灵图等运行时资产由宿主读盘后以 data URL 经桥接下发（见宠物方案），不参与 webview 构建。
3. **每批次验收记录产物体积**，主面板 HTML 设一个告警阈值，超了就先拆入口再继续。
4. ~~**先行瘦身（与移植批次解耦，建议插在 B0）**~~ —— **已完成（2026-09-12）**：mermaid 整包与 7 个非内置语言包移出产物，改为经「资源通道」（`get_webview_asset` + blob import）按需下发，**产物 5.81 MB → 2.17 MB**。详见 `docs/plans/2026-09-12-webview-asset-splitting.md` 第七节。B4 的仪表盘体积预算以 2.17 MB 为新基线。

### 进程与资源风险

新增 6 个 CLI 引擎各自带常驻进程（Grok ACP daemon、DSH WebSocket daemon、OMP、PI…）。本仓库已踩过「中断后孙进程成孤儿」的坑，新引擎要**复用现有的进程树清理与 daemon 自愈逻辑**，不要各写一套；`kill_all_orphans` / `kill_node_process`（B0 缺口里就有）要一并覆盖新引擎。

---

## 七、常态化同步机制（一次性补完之后）

1. 保留 `upstream` remote，每次上游发版后在 `sync/up-vX.Y` 分支走一遍四步流程，单版本差距下冲突基本是零星的。
2. `.github/workflows` 增加门禁：契约校验 + webview 单测 + webview build（产物体积输出到日志）。
3. 在 `CONTRIBUTING.md` 写明共享目录（`webview/`、`ai-bridge/`）的改动规范：**优先在上游修，再同步下来**；必须本地改的，集中到可识别的适配点，别散落在业务组件里，降低后续 merge 成本。

---

## 八、建议执行顺序

```
B0（清缺口 + CI 门禁）
 → B1（安全加固，风险最高收益最明确，优先）
 → B2 → B3
 → B4（先定 TokenTracker / Codex Pet 取舍再动手）
 → B5 → B6（多引擎，体量大但后端模式统一，可连做）
 → B7 → B8 → B9 → B10
 → B11（Codex Pet 重做，自有实现，可与任意批次并行）
```

B1 之所以排在第一批功能批次：它修的是默认放行工具、恶意仓库 `.claude/settings.json` 自动放行 Bash、`npm install` 安装钩子 RCE、环境变量注入这类安全问题，和功能移植进度无关，越早越好。

每批次结束即可发一个 HBuilderX 版本，用户侧能持续看到进展，也便于问题定位到具体批次。
