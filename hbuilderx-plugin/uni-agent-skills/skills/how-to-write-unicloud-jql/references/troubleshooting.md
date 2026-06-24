# JQL 方法顺序与错误排查

当 JQL 报语法、权限、校验、联表或加载异常时，按需读取本文件。

## 方法调用顺序限制

单表查询中下列方法必须按顺序调用：

```text
collection -> aggregate -> geoNear -> doc -> where -> field -> groupBy -> groupField
```

联表临时表：

```text
collection -> geoNear -> where -> field -> orderBy -> skip -> limit -> getTemp
```

虚拟联表：

```text
collection -> foreignKey -> where -> field -> groupBy -> groupField -> distinct -> orderBy -> skip -> limit -> get
```

新增、修改、删除限制：

```js
db.collection('xx').add({})
db.collection('xx').doc('xxx').update({})
db.collection('xx').where('condition').update({})
db.collection('xx').doc('xxx').remove()
db.collection('xx').where('condition').remove()
```

## 错误排查

常见错误码：

- `PERMISSION_ERROR`：schema 权限不满足。检查表级权限、字段权限、查询 where 是否包含 schema 要求的 `doc` 条件、是否需要登录或 admin 角色。
- `VALIDATION_ERROR`：schema 值域校验失败。检查 `required`、`bsonType`、`enum`、`pattern`、`fieldRules`、`forceDefaultValue`。
- `SYNTAX_ERROR`：JQL 表达式语法错误。检查引号、字段名、方法顺序、正则写法、是否使用了不支持的操作符。
- `TOKEN_INVALID_*`：登录 token 无效或过期。检查 uni-id 配置和客户端登录态。
- `DUPLICATE_KEY`：唯一索引冲突。

排查步骤：

1. 确认入口使用正确：客户端使用 `uniCloud.database()`，云函数/云对象使用 `uniCloud.databaseForJQL()`。
2. 确认本地或云端 schema 已保存/上传，且操作的是正确服务空间。
3. 用最小 `field` 查询，避免默认读取无权限字段。
4. 将 schema 权限表达式与实际 `where` 对齐，例如权限是 `doc.user_id == auth.uid`，查询也应先过滤 `user_id == $cloudEnv_uid`。
5. 联表失败时检查 `foreignKey` 是否写反，临时表 `field` 是否保留关联字段。
6. 云函数内失败时检查 `uni-cloud-jql` 扩展、`event/context` 或 `clientInfo` 是否正确传入。

