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
