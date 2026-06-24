---
name: how-to-write-unicloud-jql-database
description: 当用户需要在 uni-app 或 uni-app x 客户端使用 uniCloud.database() / <unicloud-db> 实现 JQL/clientDB 查询，或在已明确使用 JQL 的云函数/云对象中实现 JQL 查询、增删改、联表、分页、统计、schema 权限时，必须使用此技能
---

## 使用场景

当任务涉及以下任一需求时使用本技能：

- 客户端通过 `uniCloud.database()`、clientDB 或 `<unicloud-db>` 查询、分页、排序、筛选 uniCloud 数据库。
- 编写 JQL 的 `where`、`field`、`orderBy`、`groupBy`、`groupField`、`getTree`、`distinct`、`multiSend` 等语句。
- 基于 `foreignKey` 实现联表查询，或基于 `parentKey` 实现树形查询。
- 为 JQL 查询补充 `DB Schema`、字段校验、默认值、权限规则、触发器或缓存。
- 用户明确要求云函数/云对象使用 JQL，或项目既有云端代码已经使用 JQL。
- 排查 `PERMISSION_ERROR`、`VALIDATION_ERROR`、字段不可读写、联表查不到数据等 JQL 问题。

## 核心原则

- 客户端（uni-app / uni-app x）使用 `uniCloud.database()` 获取 JQL/clientDB 数据库对象；云函数/云对象使用 `uniCloud.databaseForJQL()` 获取 JQL 数据库对象。
- 客户端查询数据库时优先使用 JQL/clientDB（`uniCloud.database()` 或 `<unicloud-db>`）；只有 JQL 查询无法实现、不适合在客户端暴露，或需要服务端聚合敏感逻辑时，才改用云函数/云对象等其他方式查询。
- 只有通过 JQL 操作数据库时，`DB Schema` 的值域校验、默认值、权限、`foreignKey`、触发器才会生效；传统 MongoDB API 不会触发这些能力。
- 客户端直接查库时必须先检查或补齐目标集合的 `*.schema.json`，尤其是 `permission`，禁止为了方便把敏感表默认设为全开放。
- 云函数/云对象中不要默认把数据库操作改成 JQL；只有用户已明确要求 JQL、项目既有代码已经使用 JQL、或任务需要依赖 DB Schema/JQL 联表/树查询/触发器等 JQL 能力时，才使用 `uniCloud.databaseForJQL()`。
- 如果用户只是要求“写云函数/云对象操作数据库”，且没有提到 JQL，也没有既有 JQL 代码或 schema 能力依赖，则不要主动切换为 JQL，应遵循项目现有数据库访问方式。
- 不要在客户端读写 `password` 类型字段；clientDB 无论权限如何都不能访问此类字段。

## 强制前置检查

使用本技能前，必须先通过 `how-to-write-unicloud-backend` 技能获取项目的 uniCloud 基本信息，确认实际服务商、服务空间关联关系、是否关联其他项目服务空间，以及最终应该操作的 `uniCloud-<provider>` 目录。

强制规则：

- 未完成 `how-to-write-unicloud-backend` 的“获取项目 uniCloud 基本信息”前，禁止创建、修改或判断任何 `database/*.schema.json`、`schema.ext.js`、云函数、云对象中的 JQL 代码。
- 不能仅凭当前项目根目录存在 `uniCloud-aliyun`、`uniCloud-tcb` 或 `uniCloud-alipay` 目录，就认定该目录是最终应操作目录。
- 如果基本信息显示当前项目关联了其他项目的服务空间，后续 JQL、schema、触发器相关写操作必须重定向到被关联项目的 uniCloud 目录。

完成基本信息获取后，再确认：目标服务商和最终目录、目标集合 schema、字段与权限、联表 `foreignKey`、树形 `parentKey`、云端 JQL 扩展库、是否需要 `setUser()`。

## JQL 支持操作概览

- 查询：`where`、`field`、`orderBy`、`skip`、`limit`、`get`、`getOne`、`getCount`、`count`。
- 条件：比较、范围、`in`、`&&`、`||`、正则 `.test()`、云端环境变量、数据库运算方法。
- 联表：基于 schema `foreignKey`，支持字符串联表和 `getTemp()` 临时表联表。
- 树：基于 schema `parentKey`，支持 `getTree` / `getTreePath`。
- 写入：`add`、`doc(id).update`、`where(...).update`、`doc(id).remove`、`where(...).remove`。
- 统计：`groupBy`、`groupField`、`distinct`、`count(*)`、`sum`、`avg` 等。
- 聚合：支持 `aggregate()` 管道读取。
- 批量：`multiSend()` 可合并多条查询请求。
- 事务：支持 JQL 事务，适合跨表原子更新，仅支持在云函数/云对象中使用。
- Schema 能力：权限、值域校验、默认值、`foreignKey`、`parentKey`、`schema.ext.js` 触发器、Redis 查询缓存。

## 按需加载参考

主文件只保留基本说明。根据任务类型读取对应参考文件，不要一次性加载全部：

- 客户端 JQL API、轻量增删改、联表、统计、树查询：`references/client-jql.md`。
- `<unicloud-db>` 组件列表、详情、分页、联表、加载更多、组件方法：`references/unicloud-db-component.md`。
- JQL 支持操作速查、方法顺序、限制、事务示例、MongoDB 聚合、`multiSend`：`references/jql-operations.md`。
- 云函数/云对象中使用 JQL、`databaseForJQL()`、`setUser()`：`references/cloud-jql.md`。
- `DB Schema`、权限、字段校验、默认值、`foreignKey`、触发器、JQL Redis 缓存：`references/schema-trigger-cache.md`。
- 权限、校验、语法、联表、加载异常排查：`references/troubleshooting.md`。

## 实现要求

- 优先复用项目既有集合名、字段名、schema、权限表达式和数据库访问风格。
- 生成客户端 JQL 时，优先给出显式 `field`，避免默认读取无权限字段。
- 生成联表查询时，先检查并说明依赖的 `foreignKey`；数据量较大时优先用 `getTemp()` 临时表联表。
- 生成分页列表时，必须限制 `limit` / `page-size`，不要一次性读取大量数据。
- 生成云端 JQL 前，先确认用户明确要求 JQL、项目已有 JQL，或确实需要 schema/JQL 能力。
- 修改 schema、触发器或云端 JQL 后，说明需要上传/部署 schema 或云函数/云对象后才会在云端生效。
