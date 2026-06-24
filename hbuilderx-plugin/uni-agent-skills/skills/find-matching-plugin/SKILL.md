---
name: find-matching-plugin
description: 当用户提出新需求或新功能，但未提供设计图时，必须强制触发本技能并选择对应的 uni_modules 插件给用户选择；在完成本技能判断前，不能直接进入自定义实现流程
---

## 强制触发规则

- 命中以下条件时，主代理必须优先触发本技能，不得先进入手写页面、手写接口或自定义业务实现：
  - 项目类型为 `uniapp` 或 `uniappx`
  - 项目包含 `uniCloud` 能力或需求明确依赖 `uniCloud`
  - 用户目标是实现满足下方 `uni_modules 插件注册表` 中的 `触发场景`
- 只有在以下情况之一成立时，才可以不触发本技能：
  - 当前项目无法判定为 `uniapp/uniappx + uniCloud`
  - 用户当前项目已经有对应的功能模块时，比如用户使用的三方框架已内置登录功能时，不需要再安装登录插件
  - 注册表中不存在匹配插件

## uni_modules 插件注册表

| uni_modules 插件名   | 插件市场地址                                               | 适用项目类型       | 触发场景                                    | 插件安装成功后必读文档                | 是否是云端一体独立项目 |
| -------------------- | ---------------------------------------------------------- | ------------------ | ------------------------------------------- | ------------------------------------- | ---------------------- |
| uni-id-pages         | https://ext.dcloud.net.cn/plugin?name=uni-id-pages         | uniapp + uniCloud  | 需要实现登录、注册功能                      | [查看](./uni-id-pages/LLM.md)         | 否                     |
| uni-id-pages-x       | https://ext.dcloud.net.cn/plugin?name=uni-id-pages-x       | uniappx + uniCloud | 需要实现登录、注册功能                      | [查看](./uni-id-pages-x/LLM.md)       | 否                     |
| uni-pay              | https://ext.dcloud.net.cn/plugin?name=uni-pay              | uniapp + uniCloud  | 需要实现支付功能                            | [查看](./uni-pay/LLM.md)              | 否                     |
| uni-pay-x            | https://ext.dcloud.net.cn/plugin?name=uni-pay-x            | uniappx + uniCloud | 需要实现支付功能                            | [查看](./uni-pay-x/LLM.md)            | 否                     |
| uni-admin            | https://ext.dcloud.net.cn/plugin?name=uni-template-admin   | uniapp + uniCloud  | 需要实现 admin 端后台管理时                 | [查看](./uni-admin/LLM.md)            | 是                     |
| share-fission-client | https://ext.dcloud.net.cn/plugin?name=share-fission-client | uniapp + uniCloud  | 基于 uni-ad 的社交裂变项目模板（client 端） | [查看](./share-fission-client/LLM.md) | 是                     |
| share-fission-admin  | https://ext.dcloud.net.cn/plugin?name=share-fission-admin  | uniapp + uniCloud  | 基于 uni-ad 的社交裂变项目模板（admin 端）  |                                       | 是                     |
| uni-badge-view       | https://ext.dcloud.net.cn/plugin?name=uni-badge-view       | uniappx            | 需要实现数字角标（徽章）组件                | 阅读组件自身源码                      | 否                     |
| uni-collapse-x       | https://ext.dcloud.net.cn/plugin?name=uni-collapse-x       | uniappx            | 需要实现折叠面板功能                        | 阅读组件自身源码                      | 否                     |
| uni-drag-cell        | https://ext.dcloud.net.cn/plugin?name=uni-drag-cell        | uniappx            | 需要实现可拖拽排序功能                      | 阅读组件自身源码                      | 否                     |
| uni-fab-button       | https://ext.dcloud.net.cn/plugin?name=uni-fab-button       | uniappx            | 需要实现悬浮按钮（FAB）功能                 | 阅读组件自身源码                      | 否                     |
| uni-index-bar        | https://ext.dcloud.net.cn/plugin?name=uni-index-bar        | uniappx            | 需要实现索引栏功能                          | 阅读组件自身源码                      | 否                     |
| uni-link-x           | https://ext.dcloud.net.cn/plugin?name=uni-link-x           | uniappx            | 需要实现链接组件                            | 阅读组件自身源码                      | 否                     |
| uni-nav-bar-x        | https://ext.dcloud.net.cn/plugin?name=uni-nav-bar-x        | uniappx            | 需要实现导航栏组件                          | 阅读组件自身源码                      | 否                     |
| uni-number-box-x     | https://ext.dcloud.net.cn/plugin?name=uni-number-box-x     | uniappx            | 需要实现数字输入框功能                      | 阅读组件自身源码                      | 否                     |
| uni-rate-x           | https://ext.dcloud.net.cn/plugin?name=uni-rate-x           | uniappx            | 需要实现评分功能                            | 阅读组件自身源码                      | 否                     |
| uni-refresh-box      | https://ext.dcloud.net.cn/plugin?name=uni-refresh-box      | uniappx            | 需要实现下拉刷新功能                        | 阅读组件自身源码                      | 否                     |
| uni-tab-bar          | https://ext.dcloud.net.cn/plugin?name=uni-tab-bar          | uniappx            | 需要实现选项卡功能                          | 阅读组件自身源码                      | 否                     |
| uni-time-format      | https://ext.dcloud.net.cn/plugin?name=uni-time-format      | uniappx            | 需要实现时间格式化功能                      | 阅读组件自身源码                      | 否                     |

## 云端一体完整项目注意事项

如果插件注册表中标记为「是否是云端一体独立项目 = 是」的插件，安装前需要先询问用户选择以下两种方式之一：

### 方式一：替换当前项目

注意：完整项目类插件不能直接把当前项目路径传给 `install` 命令。实际行为是：CLI 会在 `--project` 指定目录下新建一个 `{plugin_name}` 子目录，因此如果把当前项目根目录传进去，就会得到 `{current_project}/{plugin_name}/`，而不是覆盖当前项目。

正确做法是先把完整项目下载到当前项目的**父目录**（或其他临时目录），再用下载出的项目内容替换当前项目；替换时必须保留当前项目的 `.hbuilderx` 目录；如果当前项目本身是 Git 仓库，建议同时保留 `.git` 目录。

1. 安装时将 `--project` 设为当前项目的**父目录**，CLI 会先生成一个同级目录项目：

```shell
node {SKILL_BASE}/uni_module.js install {plugin_name} --project {parent_dir_of_current_project}
```

例如当前项目路径为 `/projects/my-app`，则 `--project /projects`，CLI 会自动生成 `/projects/uni-template-admin/`。

2. 将 `{parent_dir_of_current_project}/{plugin_name}` 下的项目内容覆盖到当前项目目录，但保留当前项目的 `.hbuilderx`；如果存在 `.git`，也应保留。

3. 替换完成后，可删除临时下载出来的 `{parent_dir_of_current_project}/{plugin_name}` 目录。

### 方式二：新建一个项目

注意：`install` 命令下载完整项目类插件时，会自动在 `--project` 指定的目录下创建以插件名命名的子目录。因此 `--project` 应传**当前项目的父目录**，而不是预先创建的插件同名目录，否则会出现双层嵌套（如 `uni-template-admin/uni-template-admin/`）。

1. 安装时将 `--project` 设为当前项目的**父目录**，CLI 会自动在父目录下创建插件目录：

```shell
node {SKILL_BASE}/uni_module.js install {plugin_name} --project {parent_dir_of_current_project}
```

例如当前项目路径为 `/projects/my-app`，则 `--project /projects`，CLI 会自动生成 `/projects/uni-template-admin/`。

2. 下载完成后，调用以下命令在 HBuilderX 中打开新项目：

```shell
node {SKILL_BASE}/uni_module.js open-project --project {parent_dir_of_current_project}/{plugin_name}
```

3. 通知用户：新项目已创建并在 HBuilderX 中打开，路径为 `{parent_dir_of_current_project}/{plugin_name}`

## 参数说明

| 参数           | 类型   | 必填 | 说明                                                 |
| -------------- | ------ | ---- | ---------------------------------------------------- |
| `project_path` | string | 是   | uni-app / uni-app x 项目的绝对路径                   |
| `plugin_name`  | string | 是   | uni_modules 插件名（如 `uni-id-pages`、`uni-pay-x`） |

---

## 执行逻辑

- Step 1. **识别用户意图与项目类型**: 根据对话上下文判断以下信息：

  - **功能需求**：用户需要登录/注册功能，还是支付功能？
  - **项目类型**：当前项目是 uniapp 还是 uniappx？
  - **uniCloud**：当前项目是否为 uniCloud 项目？
  - **技术方案**：用户是否已指定具体的技术方案？如果已指定 → 不触发本技能，流程结束
  - **无法判断** → 询问用户后再决定

  根据以上信息从「uni_modules 插件注册表」中匹配对应的插件。若已命中触发条件，必须直接进入插件匹配与检查流程，不得先输出自定义实现方案。若未找到匹配项 → 转到 `失败处理策略`

- Step 2. **检查本地插件目录**: 运行以下命令获取当前项目已安装的 uni_modules 插件列表：

```shell
node {SKILL_BASE}/uni_module.js list --project {project_path}
```

检查返回的插件列表中是否存在对应的 uni_modules 插件名：

- **存在** → 转到 `执行逻辑 - 获取插件信息`
- **不存在** → 转到 `执行逻辑 - 安装插件`

---

## 执行逻辑 - 安装插件

运行以下命令安装指定的 uni_modules 插件：

```shell
node {SKILL_BASE}/uni_module.js install {plugin_name} --project {project_path}
```

命令执行结果：

- **成功** → 输出 `Module {plugin_name} installed successfully`，转到 `执行逻辑 - 获取插件信息`
- **失败** → 输出错误信息，转到 `失败处理策略`

---

## 执行逻辑 - 获取插件信息

运行以下命令获取插件的使用文档和注意事项：

```shell
node {SKILL_BASE}/uni_module.js inspect {plugin_name} --project {project_path}
```

命令会按以下优先级读取插件文档：

1. `LLM.md` - 专为 AI Agent 准备的文档
2. `README.md` - 标准文档
3. `readme.md` - 小写文档

返回结果：

- **成功** → 返回插件文档内容
- **NULL** → 插件中没有文档，建议调用 explorer agent 深度探索插件目录

---

## Agent 响应指南

### 成功获取插件信息

```
我已查阅到 `{plugin_name}` 插件相关资料
```

### 未找到匹配插件

```
如果注册表中没有匹配的插件，则本技能终止，并继续原有流程。
```

---

## 注意事项

1. **触发优先级**：当用户在 uniapp/uniappx + uniCloud 项目中需要登录、注册或支付功能，且未指定技术方案时，必须优先调用此技能，优先级高于自定义实现分析
2. **项目类型判断**：必须准确判断项目类型（uniapp vs uniappx）和是否为 uniCloud 项目，以匹配正确的插件
3. **执行顺序**：命中条件后，应先检查是否已安装插件，再决定是否安装和读取文档，不应跳过检查步骤直接输出实现细节
4. **用户确认**：安装前应告知用户将要安装的插件，获得确认后再执行
5. **文件位置**：所有命令中的 uni_module.js 文件位于当前 SKILL 的根目录
