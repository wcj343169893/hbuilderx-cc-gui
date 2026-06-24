---
name: launch-uniapp-or-uniappx
description: 运行 uni-app/uni-app x 项目到指定平台。当用户明确要求启动项目预览、运行到指定平台或运行到指定页面时使用。
---

### 参数说明

| 参数           | 类型   | 必填 | 说明                                                                      |
| -------------- | ------ | ---- | ------------------------------------------------------------------------- |
| `project_path` | string | 是   | uni-app/uni-app x 项目的绝对路径                                          |
| `platform`     | string | 是   | 目标平台：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web` |
| `page_path`    | string | 否   | 指定运行到的页面路径，取值是 `pages.json` 中注册的页面路径                |
| `page_query`   | string | 否   | 运行到指定页面时携带的参数，格式：`param1=value1&param2=value2`           |
| `browser_name` | string | 否   | 浏览器类型：`Built` / `Chrome` / `Firefox` / `Ie` / `Edge` / `Safari`，用到此参数时，如果用户没有明确指定，需要先让用户选择 |

### 执行逻辑

- Step 1. **获取 HBuilderX CLI 路径**：优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行 `./checkEnv.js` 做兜底检测。

- Step 2. **选择目标平台**： 让用户选择需要运行的平台。如果用户之前选择过了，自动使用用户之前选择的平台。
    **注意** uni-app和uni-app x项目支持的目标平台不同，区别如下：
    * uni-app 项目：`app-android` / `app-ios` / `app-harmony` / `web` / `mp-weixin` / `mp-alipay`/ `mp-baidu`/ `mp-toutiao` / `mp-qq` / `mp-360` / `mp-jd` / `mp-kuaishou` / `mp-lark` / `mp-xhs` / `mp-harmony`
    * uni-app x 项目：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web`

    **注意**：web平台**必须**先让用户选择运行的浏览器类型`browser_name`

- Step 3. **检查是否已经在运行**：运行命令 `node {SKILL_BASE}/checkLaunchState.js --platform {platform} --project_path {project_path}`
    * 如果返回 "未发现在指定平台运行的实例"：执行 `Step 4`
    * 如果命令退出码为 `2`，或返回“当前日志为非终态，不能判定为成功或失败”：表示 HBuilderX 仍在准备运行环境，此时**不能**判定为成功，也**不能**判定为失败；不要重复 launch，需要等待片刻后重试当前步骤。如果多次重试后仍是该状态，只能说明运行环境仍在准备中，必须如实告知用户仍在等待，不要汇报成功
    * 如果返回日志显示已正常运行：跳过 `Step 4`，同时告诉用户，当前项目已经在指定平台运行了。

- Step 4. **运行项目**：
  - 如果是直接运行：运行命令 `{hbuilderx_cli_path} launch {platform} --project {project_path}`
  - 如果是运行到指定页面：运行命令 `{hbuilderx_cli_path} launch {platform} --project {project_path} --pagePath {page_path} --pageQuery {page_query}`
**注意**：如果是web平台，需要追加命令参数`--browser {browser_name}`
**注意**：如果**当前HBuilderX版本**大于或者等于`5.11`，运行命令需要追加参数 `--ui true`；此模式下不需要进入 **watch 模式**。
**注意**：如果**当前HBuilderX版本**小于`5.11`，以上运行命令不会自动停止，运行起来后会进入 **watch 模式**，你**必须后台运行**此命令，然后通过 Skill `logcat-uniapp-or-uniappx` 定时轮询查看并输出运行日志。

### 注意事项
- 运行项目前**必须**要先检查是否已经在运行，避免重复运行

### 参考文档
- launch app(android/ios/harmony): https://hx.dcloud.net.cn/cli/launch-app
- launch web: https://hx.dcloud.net.cn/cli/launch-web
- launch 小程序: https://hx.dcloud.net.cn/cli/launch-miniProgram
