// Changelog for the hbuilderx-cc-gui repository (HBuilderX 移植版)
// 与 hbuilderx-plugin/changelog.md 保持同步（版本号以 hbuilderx-plugin/package.json 为准）。
// 手动维护：构建的 prebuild 只生成 version.ts，不会覆盖本文件。

export interface ChangelogEntry {
  version: string;
  date: string;
  content: {
    en: string;
    zh: string;
  };
}

export const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    version: '0.2.1',
    date: '2026-07-12',
    content: {
      en: `✨ Features
- DeepSeek peak-pricing guard: when sending on DeepSeek during peak hours (Beijing 9-12 / 14-18, 2× price), a dialog lets you choose Plan / Queue for off-peak / Send now (pick thinking depth) / Cancel
- Off-peak auto-execution of the queue: each task runs in a fresh session (no context bloat), model auto-picked by difficulty, execution permission mode selectable at queue time
- In-chat "DeepSeek off-peak queue" panel (view / remove / clear)
- Auto-retry on transient send errors (e.g. "API request failed", timeout, 5xx, network); configurable count/interval
- Status-bar icon tooltip shows the current version

🐛 Fixes
- Fix plugin-host out-of-memory crash / freeze on long sessions (cap oversized tool_use/tool_result content, e.g. whole files & command output)
- Fix: after a crash, reopening a history session then sending showed nothing while still executing (message sequence mismatch)
- Fix cross-project / cross-session analysis-stream bleed (runtimeSessionEpoch isolation)

🛠 Improvements
- New session with a temp file active now keeps the last project path
- Throttle thinking-stream full refreshes; add a local index cache for the history list`,
      zh: `✨ 新功能
- DeepSeek 峰谷定价「高峰守卫」：高峰时段（北京时间 9-12 / 14-18，2 倍价）用 DeepSeek 发送时弹窗选择——制定开发计划 / 加入队列（平价自动执行）/ 立即发送（选思考深度）/ 取消
- 平价时段自动分批执行队列：每个任务用全新会话执行（避免上下文膨胀），按难度自动选模型，入队时可指定执行权限模式
- 会话界面「DeepSeek 平价执行队列」面板（查看 / 移除 / 清空）
- 发送遇瞬时错误（如「API request failed」、超时、5xx、网络中断）自动重试，次数/间隔可在设置里配置
- 底部状态栏图标悬浮提示显示当前版本号

🐛 修复
- 修复长会话（大上下文 + 大量文件读写/命令输出）导致插件宿主内存耗尽而卡死/崩溃：对超大的 tool_use/tool_result 内容（整份文件、命令全部输出等）截断
- 修复上次会话崩溃后重开历史会话再发消息时，消息区不显示、却仍在后台执行的问题（消息序列号错位）
- 修复不同项目 / 会话的分析流互相串扰（runtimeSessionEpoch 运行时隔离）

🛠 优化
- 新建会话时若正编辑临时文件，沿用上一次的项目路径
- 思考流全量刷新改为节流；历史会话列表新增本地索引缓存`,
    },
  },
  {
    version: '0.2.0',
    date: '2026-07-02',
    content: {
      en: `✨ Features / Improvements
- "View diff" now shows a full-file side-by-side comparison; unchanged regions are folded and expand on click
- Diff view theme follows Settings → Basic Config → UI Theme
- Large-file diff performance: very large files fall back to a fast comparison to avoid freezing

🛠 Other
- Remove internal test menu; clean up legacy diff temp-file logic`,
      zh: `✨ 新功能 / 优化
- 「查看差异」升级为整文件左右对比，未改动区自动折叠、可点击展开
- 差异视图主题跟随「设置 → 基础配置 → 界面主题」
- 大文件差异性能优化：超大文件自动降级为快速对比，避免卡顿

🛠 其他
- 移除内部测试菜单，清理旧的差异临时文件逻辑`,
    },
  },
  {
    version: '0.1.9',
    date: '2026-06-27',
    content: {
      en: `✨ Features
- Click the token percentage indicator to open the Context Usage dialog
- "Compact" button in Context Usage dialog to compress conversation context

🐛 Fixes
- Diff functions now show toast warnings for empty/invalid file paths
- Backend diff handler shows user-facing error messages for invalid paths
- Fix mid-stream message causing garbled conversation bubbles
- Fix long thinking content pushing page too tall (max-height 250px + scroll)
- Fix temporary directory paths being linkified as clickable file links`,
      zh: `✨ 新功能
- Token 百分比圆环点击直接打开上下文用量弹窗
- 上下文用量弹窗新增「Compact」按钮，一键压缩对话上下文

🐛 修复
- 前端 diff 函数空路径弹出 toast 警告提示
- 后端 diff 处理器空/越界路径显示用户错误提示
- 修复流式中途新消息导致对话气泡错乱的问题
- 修复长思考内容撑高页面（限制 250px + 可滚动 + 底部渐隐遮罩）
- 修复临时目录路径被错误渲染为可点击文件链接`,
    },
  },
  {
    version: '0.1.8',
    date: '2026-06-25',
    content: {
      en: `🛠 Fixes
- Fix garbled conversation / duplicated answer bubbles after several follow-up questions in the same session (dedup history replay on resume + correct message sequence)
- Fix the "View diff" button on tool cards doing nothing: it now opens a before / after comparison of the change`,
      zh: `🛠 本次更新
- 修复同一会话多次提问后，中间对话显示错乱 / 回答气泡重复合并的问题（续聊重放历史时去重 + 修正消息序号）
- 修复点击工具卡片「查看差异」按钮没有反应的问题：现在会打开修改前 / 后的内容对比`,
    },
  },
  {
    version: '0.1.7',
    date: '2026-06-25',
    content: {
      en: `✨ New
- Bundled the official HBuilderX uni-app x skills (23 in total: runtime screenshots, console logcat, syntax / compile checks, component usage, best practices, and more). Enable any of them with one click in the Skills panel to use them in chat (requires HBuilderX installed)

🛠 Fixes
- Fix the elapsed-time counter stopping early while files are being edited / commands are running, which made it look like the AI had already finished
- Fix the follow-up question bubble jumping above the previous turn's thinking (a side effect of the issue above)`,
      zh: `✨ 新增
- 内置 HBuilderX 官方 uni-app x 技能（共 23 个：运行截图、控制台日志、语法 / 编译检查、组件用法、最佳实践等），在「技能」面板一键启用即可在对话中调用（需已安装 HBuilderX）

🛠 修复
- 修复修改文件 / 执行命令期间，计时提前停止、让人误以为 AI 已执行完毕的问题
- 修复由上述问题连带导致的：新提问气泡跑到上一轮思考过程上方`,
    },
  },
  {
    version: '0.1.6',
    date: '2026-06-24',
    content: {
      en: `🛠 Changes
- Fix "Auto Mode" still asking for permission on file writes / commands in the current project: it now truly bypasses approvals and runs automatically, no per-operation confirmation
- Fix follow-up questions in the same session having their reply merged into the previous answer bubble; each turn now renders as its own message`,
      zh: `🛠 本次更新
- 修复「自动模式」下对当前项目的写入 / 命令操作仍弹出授权确认的问题：现已真正自动放行，无需逐次确认
- 修复同一会话中连续追问时，AI 新回复并入上一条回答气泡的问题；现在每轮各自独立成条`,
    },
  },
  {
    version: '0.1.5',
    date: '2026-06-23',
    content: {
      en: `🛠 Changes
- Fix the chat "context usage" always showing 0%: it now computes and shows the real percentage based on the current model's context window (e.g. 200K / 1M), and updates immediately when you switch models`,
      zh: `🛠 本次更新
- 修复聊天时「上下文用量」一直显示 0% 的问题：现已按当前模型的上下文窗口（如 200K / 1M）正确计算并显示百分比，切换模型时也会立即刷新`,
    },
  },
  {
    version: '0.1.4',
    date: '2026-06-23',
    content: {
      en: `🛠 Changes
- Fix "Use CLI login info" doing nothing on click: the card now lights up as enabled, shows your logged-in account, and applies the auth immediately
- Fix Node.js path / Claude CLI path / working directory failing to save under Settings → Basic Config → Environment`,
      zh: `🛠 本次更新
- 修复点击「使用 CLI 登录信息」无反应的问题：现可正常启用、显示登录账号，且鉴权即时生效
- 修复「设置 → 基础配置 → 环境」中 Node.js 路径 / Claude CLI 路径 / 工作目录无法保存的问题`,
    },
  },
  {
    version: '0.1.3',
    date: '2026-06-22',
    content: {
      en: `🛠 Changes
- Fix the input box \`@\` file completion returning no matches: you can now search by file name / path keyword, and it lists the current project directory when there's no keyword`,
      zh: `🛠 本次更新
- 修复输入框 \`@\` 文件补全无匹配的问题：现已支持按文件名/路径关键字搜索，无关键字时列出当前项目目录`,
    },
  },
  {
    version: '0.1.2',
    date: '2026-06-22',
    content: {
      en: `✨ What's New
- Multi-project support: the current session's project is shown at the top and can be switched with a click; by default it picks the project of the file you're editing, falling back to the first open project, and prompts you to create one when none is open
- Fix the project name occasionally not showing in the header; add the project-info API so project-scoped prompts work
- Add a user-facing "Usage Guide" to the README`,
      zh: `✨ 本次更新
- 新增多项目支持：顶部展示当前会话所属项目，可点击切换；默认按「当前编辑文件所属项目 → 第一个项目」选取，无项目时提示先创建
- 修复顶部项目名偶发不显示的问题；补全项目信息接口（项目级提示词可用）
- README 新增面向普通用户的「使用说明」`,
    },
  },
  {
    version: '0.1.1',
    date: '2026-06-22',
    content: {
      en: `🛠 Changes
- Install required dependencies`,
      zh: `🛠 本次更新
- 安装必要依赖`,
    },
  },
  {
    version: '0.1.0',
    date: '2026-06-22',
    content: {
      en: `🎉 Initial release`,
      zh: `🎉 初始化`,
    },
  },
];
