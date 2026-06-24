---
name: logcat-uniapp-or-uniappx
description: 获取 uni-app/uni-app x 项目运行控制台日志（控制台输出、告警、错误）。当需要查看控制台报错或者告警、查看控制台日志输出、排查运行时逻辑或者错误时使用。
---

### 参数说明

| 参数           | 类型   | 必填 | 说明                                                                      |
| -------------- | ------ | ---- | ------------------------------------------------------------------------- |
| `project_path` | string | 是   | uni-app/uni-app x 项目的绝对路径                                          |
| `platform`     | string | 是   | 目标平台：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web` |

### 执行逻辑

- Step 1. **选择目标平台**: 让用户选择需要运行的目标平台。如果用户之前选择过了，自动使用用户之前选择的平台。
    **注意** uni-app和uni-app x项目支持的目标平台不同，区别如下：
    * uni-app 项目：`app-android` / `app-ios` / `app-harmony` / `web` / `mp-weixin` / `mp-alipay`/ `mp-baidu`/ `mp-toutiao` / `mp-qq` / `mp-360` / `mp-jd` / `mp-kuaishou` / `mp-lark` / `mp-xhs` / `mp-harmony`
    * uni-app x 项目：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web`

- Step 2. **获取运行日志**: 运行命令 `node {SKILL_BASE}/getLogcat.js --project_path "{project_path}" --platform "{platform}" --mode full`

    **注意**：如果命令退出码为 `2`，或输出包含“当前日志为非终态，不能判定为成功或失败”，表示 HBuilderX 仍在准备运行环境。
    此时**不能**判定为成功，也**不能**判定为失败；不要基于当前日志下结论，需要等待片刻后重试当前步骤。如果多次重试后仍是该状态，只能说明运行环境仍在准备中，必须如实告知用户仍在等待，不要汇报成功。

### 参考文档
- logcat app(android/ios/harmony): https://hx.dcloud.net.cn/cli/logcat-app
- logcat web: https://hx.dcloud.net.cn/cli/logcat-web
- logcat 小程序: https://hx.dcloud.net.cn/cli/logcat-miniProgram
- logcat uniCloud: https://hx.dcloud.net.cn/cli/logcat-unicloud
