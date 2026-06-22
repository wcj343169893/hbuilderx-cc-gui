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
