---
name: write-or-run-testcase-for-uniapp-or-uniappx
description: 为 uni-app/uni-app x 项目编写和运行自动化测试用例。当需要新增测试用例、执行自动化测试或排查测试失败时使用。
---

## 参数说明

| 参数           | 类型   | 必填 | 说明                                                                      |
| -------------- | ------ | ---- | ------------------------------------------------------------------------- |
| `project_path` | string | 是   | uni-app/uni-app x 项目的绝对路径                                          |
| `platform`     | string | 是   | 目标平台：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web` |

## 编写测试用例

- **特别注意** 写测试用例之前，一定先阅读 [参考资料](#参考资料)，更详细的学习如何写自动化测试用例，并回答以下问题：
  - 测试文件规范是什么？文件应该放到什么位置？
  - 核心API有哪些？
  - 举一些测试示例，着重说明下**如何截图**？
  - 有哪些常见问题？
- 以上问题回答完成后，再开始写测试用例
  > 注意截图API指定的目录在当前项目下

**注意** 如果项目下没有 `/env.js` 和 `/jest.config.js` 文件，不用创建，运行测试用例时会自动初始化配置

## 运行测试

> **特别注意** 运行测试必须在运行完编译验证通过后，才可以执行

### Step 1. **获取 HBuilderX CLI 路径**：优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行 `./checkEnv.js` 做兜底检测。

### Step 2. **检查自动化测试插件** 运行`./checkEnv.js --checkTestEnv`检查自动化测试插件`hbuilderx-for-uniapp-test`是否安装

- 若返回 "NOT": 停止执行并提示用户请先安装uni-app x自动化测试插件，插件市场地址：https://ext.dcloud.net.cn/plugin?id=5708
- 若返回 "OK" : 继续执行Step 3

### Step 3. **运行测试用例** 运行`{hbuilderx_cli_path} uniapp.test {platform} --project {project_path}` 执行测试用例

> 根据测试输出的报告分析失败的用例原因，解决修复失败的用例，保证所有用例必须全部通过

**常见问题解决**

- 9520端口被占用

  > 解决办法：查询9520端口被哪个进程占用的，如果是node，直接杀掉，如果是别的程序，询问用户是否自动杀掉重试运行测试

- 安装apk时报错：PrematureEOFError: Premature end of stream, needed 1 more bytes
  > 解决办法：先调用 SKILL： `launch-uniapp-or-uniappx` 将项目运行起来

## 参考资料

- [uni-app x自动化测试官方文档]({knowledges_base_dir}/uni-app-x/docs/worktile/auto/quick-start.md)
- [uni-app x自动化测试 API 文档]({knowledges_base_dir}/uni-app-x/docs/worktile/auto/api.md)
- [示例项目 hello-uni-app-x]({knowledges_base_dir}/uni-app-x/samples/hello-uni-app-x)
- [Jest 官方文档](https://jestjs.io)
- [HBuilderX 自动化测试插件](https://ext.dcloud.net.cn/plugin?id=5708)
