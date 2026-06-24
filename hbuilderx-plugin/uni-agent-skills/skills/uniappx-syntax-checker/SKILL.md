---
name: uniappx-syntax-checker
description: 验证 uni-app x 项目下 uts 文件、uvue 文件的语法合法性。验证 uts、uvue 文件语法时使用，在 uts、uvue 代码变更后必须调用此工具。
project: uniappx
---

### 参数说明

| 参数           | 类型   | 必填 | 说明                                                                      |
| -------------- | ------ | ---- | ------------------------------------------------------------------------- |
| `project_path` | string | 是   | uni-app x 项目的绝对路径                                                  |
| `platform`     | string | 是   | 验证平台：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web` |
| `file_path`    | string | 是   | 被校验的文件绝对路径，仅支持 `.uvue`、`.uts` 文件                           |

### 执行逻辑

- Step 1. **获取 HBuilderX CLI 路径**：优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行 `./checkEnv.js` 做兜底检测。

- Step 2. **选择目标平台**：让用户选择需要验证的平台，或者自动使用用户上次选择的平台。

- Step 3. **执行语法检查**：运行 `{hbuilderx_cli_path} lsp lint --platform {platform} --project {project_path} --file {file_path}`。
  - 命令本身必须设置超时（ 15 秒），不要只依赖调用方或 provider 的超时兜底，避免 CLI 挂起导致任务长时间无响应。
  - 若没有错误：任务达成。
  - 若存在错误：捕获错误信息。

### Response Handling (For Agent)

- **If Success**：返回 "未发现校验错误"。
- **If Failure**：返回原始校验日志。Agent 必须根据日志中的文件路径和错误代码，结合以下本地文档和d.ts定义进行自修复：
  - UTS相关文档：
    - 文档1：`{knowledges_base_dir}/uni-app-x/docs/uts/compiler-known-issues.md`
    - uts和ts差异： `{knowledges_base_dir}/uni-app-x/docs/uts/uts_diff_ts.md`
    - d.ts目录： `{knowledges_base_dir}/uni-app-x/types/uni-app-x/types`
  - CSS文档目录：`{knowledges_base_dir}/uni-app-x/docs/css/`
  - UVUE内置组件文档目录：`{knowledges_base_dir}/uni-app-x/docs/component/`

### Guidelines for Agent

- 如果连续修复 5 次仍未校验成功，请停止并向用户申请人工介入。
