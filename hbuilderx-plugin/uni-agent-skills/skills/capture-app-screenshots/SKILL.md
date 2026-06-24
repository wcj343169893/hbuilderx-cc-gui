---
name: capture-app-screenshots
description: 获取 uni-app x 项目运行时截图。当需要进行 UI 验证、截图对比或记录页面状态时使用，支持 App 平台；Web 平台仅在 HBuilderX 5.08+ 版本中支持。
project: uniappx
---

### 参数说明

| 参数           | 类型   | 必填 | 说明                                                                                                           |
| -------------- | ------ | ---- | -------------------------------------------------------------------------------------------------------------- |
| `project_path` | string | 是   | uni-app x 项目的绝对路径                                                                                       |
| `platform`     | string | 是   | 编译平台：`app-android` / `app-ios` / `app-harmony` / `web`                                                    |
| `save_file`    | string | 是   | 截图保存的本地文件绝对路径，支持 `.png` / `.jpg` / `.jpeg` / `.webp`，推荐放置于 `{project_path}/screenshots/` |
| `full_page`    | bool   | 是   | 是否截全页面：`true` 截取包含超出可视区域的完整内容，`false` 仅截窗口内容，默认传 `false`                      |

### 执行逻辑

- Step 1. **获取 HBuilderX CLI 路径**：优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行 `./checkEnv.js` 做兜底检测。

- Step 2. **选择目标平台**: 让用户选择需要运行的平台。如果用户之前选择过了，自动使用用户之前选择的平台。

  - 当目标平台为 `web` 时，需确认当前 HBuilderX 版本是否为 `5.07+`；低于该版本时不要继续执行 Web 截图命令。

- Step 3. **执行截图命令**: 运行命令 `{hbuilderx_cli_path} screencap {platform} --project {project_path} --saveFile {save_file} --fullPage {full_page}`
