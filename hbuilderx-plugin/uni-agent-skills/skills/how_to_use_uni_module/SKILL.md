---
name: how-to-use-uni-module
description: 用于查询、安装和获取 uni_modules 插件信息。在 uni-app/uni-app x 项目中当用户要求查询、下载 uni_module 插件时使用
---

## 参数说明

| 参数           | 类型   | 必填 | 说明                                           |
| -------------- | ------ | ---- | ---------------------------------------------- |
| `project_path` | string | 是   | uni-app (x) 项目的绝对路径                     |
| `module_name`  | string | 是   | uni_modules 插件名称或功能描述（支持模糊匹配） |

---

## 执行逻辑 - 检查插件是否已安装

- Step 1. **检查本地插件目录**: 运行以下命令获取当前项目已安装的 uni_modules 插件列表：

```shell
node {SKILL_BASE}/uni_module.js list --project {project_path}
```

检查返回的插件列表中是否存在 `module_name`：

- **存在** → 转到 `执行逻辑 - 获取插件信息`
- **不存在** → 转到 Step 2

- Step 2. **语义匹配插件**: 运行以下命令获取所有可用的 uni_modules 插件列表：

```shell
node {SKILL_BASE}/uni_module.js plugins
```

该命令会返回插件列表的 Markdown 格式内容

**Agent 需要**：

1. 解析用户需求（module_name 可能是功能描述）
2. 对插件库执行语义相关性排序
3. 输出 Top 3 候选插件并等待用户选择
4. 用户确认后，转到 `执行逻辑 - 安装插件`

**评分原则**：

```
插件ID匹配 > 插件名称匹配 > 功能语义匹配 > keywords 匹配 > 名称相似度
```

---

## 执行逻辑 - 安装插件

运行以下命令安装指定的 uni_modules 插件：

```shell
node {SKILL_BASE}/uni_module.js install {module_name} --project {project_path}
```

命令执行结果：

- **成功** → 输出 `Module {module_name} installed successfully`，转到 `执行流程 - 获取插件信息`
- **失败** → 输出错误信息，转到 `失败处理策略`

---

## 执行逻辑 - 获取插件信息

运行以下命令获取插件的使用文档和注意事项：

```shell
node {SKILL_BASE}/uni_module.js inspect {module_name} --project {project_path}
```

命令会按以下优先级读取插件文档：

1. `LLM.md` - 专为 AI Agent 准备的文档
2. `README.md` - 标准文档
3. `readme.md` - 小写文档

返回结果：

- **成功** → 返回插件文档内容
- **NULL** → 插件中没有文档，建议调用 explorer agent 深度探索插件目录

---

## 失败处理策略

如果插件库中没有匹配的插件，Agent 必须返回：

```
未找到合适的 uni_modules 插件，建议：
- 使用原生 API 实现
- 手动开发插件
- 查阅官方文档
```

## **重要**：不得 silent fail，必须明确告知用户。

## Agent 响应指南

### 成功获取插件信息

```
我已查阅到 `{plugin_name}` 插件相关资料
```

### 需要用户选择插件

```
我找到多个可能符合需求的插件，请选择一个：
1. {plugin_1} - {description_1}
2. {plugin_2} - {description_2}
3. {plugin_3} - {description_3}
```

### 未找到匹配插件

```
没有查询到相关资料，我将继续探索 `{module_name}` 的实现方案
```

---

## 注意事项

1. **必须调用此 SKILL**：当后续任务需要基于插件实现/重构/开发/调试功能时
2. **自动匹配推荐**：如果插件不存在，不能直接失败，必须尝试匹配并推荐候选插件
3. **用户确认**：Agent 只负责推荐与排序，不做最终安装决策，必须让用户确认
4. **文件位置**：所有命令中的 uni_module.js 文件位于当前 SKILL 的根目录
