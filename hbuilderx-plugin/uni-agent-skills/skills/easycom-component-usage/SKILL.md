---
name: easycom-component-usage
description: 获取 uni-app/uni-app x 项目中的 easycom 组件列表或指定组件的元数据和用法。当需要查看项目中 easycom 组件清单、查看某个组件的属性配置及使用方式或排查组件识别问题时使用（仅 HBuilderX 版本为 5.07 及以上支持）。
---

## 参数说明

| 参数           | 类型   | 必填 | 说明                                                                      |
| -------------- | ------ | ---- | ------------------------------------------------------------------------- |
| `project_path` | string | 否   | uni-app/uni-app x 项目的绝对路径                                          |
| `file_path`    | string | 否   | 目标组件文件的绝对路径                                                   |

## 执行逻辑

- Step 1. **获取 HBuilderX CLI 路径**：优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行 `./checkEnv.js` 做兜底检测。

- Step 2. **执行命令**

  * FEATURE 1. **获取组件列表**：运行 `{hbuilderx_cli_path} lsp getComponentList --projectPath {project_path}`

  * FEATURE 2. **获取组件详细数据**：运行 `{hbuilderx_cli_path} lsp getComponentsData --filePath {file_path}`

- Step 3. **返回结果**：
  - 成功时返回 CLI 原始 JSON 数据
  - 失败时返回原始错误信息
