---
name: verify-uniappx-compile-error
description: 验证 uni-app x 项目的编译合法性。当用户要求验证语法错误时使用，对项目内代码存在新增、删除、修改等操作后必须使用。
project: uniappx
---

### 参数说明

| 参数           | 类型   | 必填 | 说明                                                                      |
| -------------- | ------ | ---- | ------------------------------------------------------------------------- |
| `project_path` | string | 是   | uni-app x 项目的绝对路径                                                  |
| `platform`     | string | 是   | 编译平台：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web` |

### 执行逻辑

- Step 1. **获取 HBuilderX CLI 路径**：优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行 `./checkEnv.js` 做兜底检测。

- Step 2. **选择目标编译平台**: 让用户选择需要验证的平台，或者自动使用用户上次选择的平台。

- Step 3. **检查是否已经在运行**：必须先运行命令 `node {SKILL_BASE}/../launch-uniapp-or-uniappx/checkLaunchState.js --platform "{platform}" --project_path "{project_path}"`。
  - 如果项目正在运行：停止本技能流程，改为调用 `fix-console-error-uniapp-or-uniappx` 技能。
  - 如果未发现在指定平台运行的实例：继续执行 Step 4 的编译检查。

- Step 4. **执行编译检查**: 仅当 Step 3 明确返回 "未发现在指定平台运行的实例" 时，运行 `{hbuilderx_cli_path} launch {platform} --project {project_path} --compile true`。
  - 若没有错误：任务达成。
  - 若存在错误：捕获错误信息，并修复完成，然后继续验证直到没有错误

### Response Handling (For Agent)

- **If Success**: 返回 "Build Successful"。
- **If Failure**: 返回原始编译日志。Agent 必须根据日志中的文件路径和错误代码，结合以下本地文档和d.ts定义进行自修复：
  - 文档1: `{knowledges_base_dir}/uni-app-x/docs/uts/compiler-known-issues.md`
  - 文档2: `{knowledges_base_dir}/uni-app-x/docs/uts/uts_diff_ts.md`
  - d.ts目录: `{knowledges_base_dir}/uni-app-x/types/uni-app-x/types`

### Guidelines for Agent

- 运行中的项目统一交给 `fix-console-error-uniapp-or-uniappx` 技能处理。
- 执行编译检查前必须先完成 Step 3 的运行态检查；未得到“未发现在指定平台运行的实例”时，禁止运行 `launch ... --compile true`。
- 如果连续修复 5 次仍未编译成功，请停止并向用户申请人工介入。
