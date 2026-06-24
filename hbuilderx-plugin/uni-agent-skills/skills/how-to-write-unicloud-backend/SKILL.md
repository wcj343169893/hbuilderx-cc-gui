---
name: how-to-write-unicloud-backend
description: 为 uni-app 或者 uni-app x 项目初始化 uniCloud 环境、创建和本地运行云函数/云对象、操作云数据库、查询uniCloud本地调试运行日志，当任务涉及 uniCloud 后端开发、验证、测试时，必须优先使用此技能，并执行“强制前置检查”
---

## 使用场景

当需要为 uni-app (x) 项目添加 uniCloud 服务端能力时使用，包括：

- 创建云函数处理业务逻辑
- 配置云数据库和数据模型
- 实现用户认证和权限管理
- 生成类型安全的前端调用接口
- 云函数和云对象方法测试
- 云数据库相关操作
- 查询 uniCloud 本地调试日志

---

## 参数说明

- `project_path` (必填): uni-app (x) 项目的绝对路径
- `unicloud_provider` (必填): uniCloud 服务商，可选: `aliyun` / `alipay` / `tcb`
- `all_unicloud_providers` (必填): 支持的服务商列表，逗号分隔（如 `aliyun,alipay,tcb`）
- `space_id` (可选): 云空间ID或名称，关联云空间时需要提供
- `resource_type` (可选): 资源类型，可选: `cloudfunction` / `cloudobject` / `common` / `db` / `vf` / `action` / `space`
- `cloud_function_name` (可选): 云函数名称，本地运行云函数时需要提供
- `cloud_object_name` (可选): 云对象名称，本地运行云对象时需要提供
- `cloud_object_function_name` (可选): 云对象的方法名称，本地运行云对象时需要提供

---

## 强制前置检查（必须执行）

在创建、修改、运行任何 uniCloud 资源前，必须先获取项目的 uniCloud 基本信息来判断 uniCloud 资源目录所在位置。

命令返回数据包含以下基本信息：

1. 服务空间信息
2. 是否关联其他项目服务空间
3. 关联其他项目服务空间的项目信息

当关联了其他项目的服务空间，后续 uniCloud 开发目录要重定向到其他项目中的 uniCloud 目录下。严禁在当前项目中操作 uniCloud 目录。

运行以下命令获取基本信息：

```shell
node {SKILL_BASE}/unicloud.js info --provider {unicloud_provider} --project {project_path}
```

**强制规则：**

- 未执行 “获取项目 uniCloud 基本信息” 前，禁止创建、修改、运行任何云函数、云对象、公共模块、数据库资源
- 不能仅凭项目根目录下存在 uniCloud-alipay、uniCloud-aliyun、uniCloud-tcb 等目录，就认定该目录是最终应操作的 uniCloud 目录
- 所有后续写操作都必须以 “获取项目 uniCloud 基本信息” 返回结果为准
- 若 “获取项目 uniCloud 基本信息” 显示当前项目关联了其他项目的服务空间，则后续必须重定向到对应项目中的 uniCloud 目录，严禁继续操作当前项目中的本地 uniCloud-* 目录
- 如果命令执行结果为"操作不支持"或者"未知操作"。
  - 必须立即停止创建、修改、运行云函数/云对象
  - 必须明确告知用户当前 HBuilderX 版本不支持该能力，建议升级到 5.08+
  - 未经用户明确同意，不得直接在当前项目的 uniCloud-* 目录下创建或修改资源。如果用户明确同意走降级路径，才允许基于本地已存在的 uniCloud-{provider} 目录继续操作，并必须告知用户：此方式无法确认是否关联了其他项目的云空间，存在改错目录的风险。

## 执行流程 - 初始化 uniCloud 环境

### 步骤 1: 环境检查

运行命令检查项目是否已初始化 uniCloud：

```shell
node {SKILL_BASE}/unicloud.js list {all_unicloud_providers} --project {project_path}
```

- 若已存在：继续执行后续步骤
- 若不存在：转到 `步骤 2`

### 步骤 2: 初始化服务商

询问用户选择 uniCloud 服务商，执行初始化：

```shell
node {SKILL_BASE}/unicloud.js init {unicloud_provider} --project {project_path}
```

- 成功：转到 `步骤 3`
- 失败：终止并提示错误信息

### 步骤 3: 关联云服务空间

查询可用的云空间列表：

```shell
node {SKILL_BASE}/unicloud.js resources --project {project_path} --provider {unicloud_provider} --type space --cloud
```

询问用户选择云空间后，执行项目关联到云空间命令：

```shell
node {SKILL_BASE}/unicloud.js assignspace --project {project_path} --provider {unicloud_provider} --space {space_id}
```

---

## 执行流程 - 创建本地云函数

运行以下命令在项目中创建本地云函数

```shell
node {SKILL_BASE}/unicloud.js create --project {project_path} --provider {unicloud_provider} --type cloudfunction --name {cloud_function_name}
```

命令执行成功后输出以下内容

```
Cloud function create success with name "{cloud_function_name}".
Index file path: {cloud_function_file_path}
Param file path: {cloud_function_param_file_path}
```

---

## 执行流程 - 创建本地云对象

运行以下命令在项目中创建本地云对象

```shell
node {SKILL_BASE}/unicloud.js create --project {project_path} --provider {unicloud_provider} --type cloudobject --name {cloud_object_name}
```

命令执行成功后输出以下内容

```
Cloud object create success with name "{cloud_object_name}".
Index file path: {cloud_object_file_path}
Param file path: {cloud_object_param_file_path}
```

---

## 执行流程 - 写完后的强制语法验证

创建或修改任何 uniCloud 后端资源后，必须先进行语法验证，再运行云函数/云对象或交付结果。

适用范围：

- 云函数、云对象、公共模块中的 `.js` / `.cjs` / `.mjs` 文件
- 云函数或公共模块的 `package.json`或者任何`*.json`文件
- 数据库 `*.schema.json`
- `*.schema.ext.js`
- 运行参数文件，如 `{cloud_function_name}.param.json`、`{cloud_object_name}.param.js`

强制规则：

- 只要本次任务新增或修改了 uniCloud 后端代码，就必须执行至少一项与改动文件匹配的语法验证。
- 语法验证必须在本地运行云函数/云对象之前执行；不得用“运行本地云函数/云对象”替代语法验证。
- 如果语法验证失败，必须先修复语法错误，再继续执行本地运行、上传或交付。
- 如果因为环境限制无法执行语法验证，必须在回复中明确说明未验证的文件、原因和建议用户执行的命令。

JavaScript 文件语法验证：

```shell
node --check {javascript_file_path}
```

JSON 文件语法验证：

```shell
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" {json_file_path}
```

如果云函数/云对象目录内存在自己的 `package.json` 且已配置 lint、test、build、typecheck 等脚本，应优先选择与本次改动范围最小匹配的脚本做补充验证。例如：

```shell
npm run lint
npm run build
npm test
```

注意：

- 不要为了语法验证主动新增调试 `console.log`。
- 不要为了通过验证修改与本次任务无关的业务逻辑。
- `*.param.js` 虽然主要用于 HBuilderX 本地运行参数配置，但仍应保证 JavaScript 语法可解析。

---

## 执行流程 - 运行本地云函数

### 步骤 1: 检查云函数文件

运行命令获取云函数文件列表

```shell
node {SKILL_BASE}/unicloud.js getpath --project {project_path} --provider {unicloud_provider} --name {cloud_function_name}
```

找到云函数文件，会输出以下内容，然后转到 `步骤 2`：

```
Cloud function files with name "{cloud_function_name}":
Index file path: {cloud_function_file_path}
Param file path: {cloud_function_param_file_path}
```

找到云函数文件后，必须先执行 `执行流程 - 写完后的强制语法验证`，验证通过后再转到 `步骤 2`。

没有找到云函数文件: 转到 `执行流程 - 创建本地云函数`，创建成功后先执行 `执行流程 - 写完后的强制语法验证`，验证通过后再转到 `步骤 2`

### 步骤 2: 提取云函数参数并设置参数配置文件

1. 依据云函数文件路径读取文件内容，分析函数代码并提取出 `运行参数`
2. 根据 `运行参数` 生成可用于测试的 Mock 数据并配置到 `{cloud_function_name}.param.json` 中，然后转到 `步骤 3`

**参数配置文件参考**
如果需要模拟客户端类型，可以在运行参数内添加 clientInfo 字段，完整字段列表见下方说明

```jsonc
{
  "otherParam": "***",
  "clientInfo": {
    // HBuilderX 3.5.1 之前的版本需要传全大写的参数才可以在context内使用context.OS、context.LOCALE等
    "OS": "ios", // 系统类型 ios、android
    "PLATFORM": "web", // 客户端类型 app、web、mp-weixin、mp-alipay等
    "DEVICEID": "", // 设备id
    "APPID": "", // 应用DCloud AppId
    "LOCALE": "", // 客户端语言
    // HBuilderX 3.5.1 及更高版本无需传入大写参数，以上参数对应写法如下
    "osName": "ios", // 系统类型 ios、android
    "uniPlatform": "web", // 客户端类型 app、web、mp-weixin、mp-alipay等
    "deviceId": "", // 设备id
    "appId": "", // 应用DCloud AppId
    "locale": "", // 客户端语言
    // HBuilderX 3.5.1 及更高版本还允许模拟调用来源（context.SOURCE）、客户端ip（context.CLIENTIP）、客户端ua（context.CLIENTUA）
    "source": "client", // 调用来源，不传时默认为 client
    "clientIP": "127.0.0.1", // 客户端ip，不传时默认为 127.0.0.1
    "ua": "xx MicroMessenger/xxx", // 客户端ua，不传时默认为 HBuilderX
    // ...其他客户端信息
  },
}
```

> **注意**
>
> - 非本地运行环境下客户端getSystemInfoSync也会获取ua参数并上传给云函数，但是云函数会从http请求头里面获取ua而不是clientInfo里面的ua

### 步骤 3: 运行云函数

运行以下命令执行函数，函数执行完毕后，转到 `结束流程`

```shell
node {SKILL_BASE}/unicloud.js exec --project {project_path} --provider {unicloud_provider} --type cloudfunction --name {cloud_function_name}
```

---

## 执行流程 - 运行本地云对象

### 步骤 1: 检查云对象文件

运行命令获取云对象文件列表

```shell
node {SKILL_BASE}/unicloud.js getpath --project {project_path} --provider {unicloud_provider} --name {cloud_object_name}
```

找到云对象文件，会输出以下内容，然后转到 `步骤 2`：

```
Cloud object files with name "{cloud_object_name}":
Index file path: {cloud_object_file_path}
Param file path: {cloud_object_param_file_path}
```

找到云对象文件后，必须先执行 `执行流程 - 写完后的强制语法验证`，验证通过后再转到 `步骤 2`。

没有找到云对象文件: 转到 `执行流程 - 创建本地云对象`，创建成功后先执行 `执行流程 - 写完后的强制语法验证`，验证通过后再转到 `步骤 2`

### 步骤 2: 提取云对象方法参数并设置参数配置文件

1. 依据云对象文件路径读取文件内容，分析要运行的方法代码并提取出 `运行参数`
2. 根据 `运行参数` 生成可用于测试的 Mock 数据并配置到 `{cloud_object_name}.param.js` 中，然后转到 `步骤 3`
   **参数配置文件参考**

```js
const clientInfo = {
  // 模拟clientInfo
  appId: "xxx",
  uniPlatform: "web",
  source: "client", // 调用来源，不传时默认为 client
  clientIP: "127.0.0.1", // 客户端ip，不传时默认为 127.0.0.1
  userAgent: "xx MicroMessenger/xxx", // 客户端ua，不传时默认为 HBuilderX
  uniIdToken: "xxx",
}
login("name-demo", "password-demo") // 调用login方法传入参数'name-demo'和'password-demo'
```

- `const clientInfo = {xxx}` 为模拟客户端信息，完整 clientInfo 列表请参考：[getClientInfo](https://doc.dcloud.net.cn/uniCloud/cloud-obj.html#get-client-info)
- `login('xxx', 'xxx')` 用于指定调用的方法名和参数。
  > **注意**:
  >
  > - 此文件并非可执行的js文件，仅用来配置参数，因此不可在文件内定义变量并使用
  > - 如果存在多个方法、参数配置运行时会使用第一个

### 步骤 3: 运行云对象

运行以下命令执行对象，对象执行完毕后，转到 `结束流程`

```shell
node {SKILL_BASE}/unicloud.js exec --project {project_path} --provider {unicloud_provider} --type cloudobject --name {cloud_object_name}
```

---


## 执行流程 - 更多操作

更多 uniCloud 云空间功能（如云数据库、资源查看、上传、下载等）相关操作可使用 HBuilderX CLI 提供的命令行工具完成。
优先使用上下文中已经提供的 `hbuilderx_cli_path`。当上下文中不存在时，运行以下命令做兜底检测：

```shell
node {SKILL_BASE}/unicloud.js getcli
```

查看 HBuilderX CLI 关于 uniCloud 帮助文档，了解更多 uniCloud 命令用法：

```shell
{HBUILDERX_CLI_PATH} cloud functions --help
```

查看 SKILL 相关命令，了解更多当前 SKILL 支持的 uniCloud 相关命令：

```shell
node {SKILL_BASE}/unicloud.js --help
```

---

## 结束流程 - 委派子智能体处理

**重要：将后端开发任务委派给 `uniCloud Subagent` 子智能体**

委派时需提供：

1. **业务实体定义**：数据模型、字段类型、关联关系
2. **预期数据流**：接口输入输出、业务流程描述
3. **功能需求**：具体要实现的功能点

子智能体将生成：

- 类型安全的云函数/云对象代码
- 对应的 TypeScript 接口定义
- 数据库 schema 和权限配置

**注意**：不要自行编写后端代码，以保持上下文清晰和代码质量一致性。
