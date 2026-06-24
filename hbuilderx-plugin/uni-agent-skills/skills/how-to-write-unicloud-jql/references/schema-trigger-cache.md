# DB Schema、触发器与缓存

当需要补充 schema 权限、值域校验、默认值、foreignKey、触发器或 JQL Redis 缓存时，按需读取本文件。

## DB Schema 配置要点

最小示例：

```json
{
  "bsonType": "object",
  "required": ["title"],
  "permission": {
    "read": true,
    "create": "auth.uid != null",
    "update": "doc.user_id == auth.uid",
    "delete": "doc.user_id == auth.uid",
    "count": true
  },
  "properties": {
    "_id": {
      "description": "ID，系统自动生成"
    },
    "title": {
      "bsonType": "string",
      "title": "标题",
      "trim": "both"
    },
    "user_id": {
      "bsonType": "string",
      "foreignKey": "uni-id-users._id",
      "forceDefaultValue": {
        "$env": "uid"
      },
      "permission": {
        "write": false
      }
    },
    "create_date": {
      "bsonType": "timestamp",
      "forceDefaultValue": {
        "$env": "now"
      }
    }
  }
}
```

配置规则：

- `permission` 默认都是 `false`；不配置不代表开放，admin 角色例外。
- 表级权限控制 `create`、`read`、`update`、`delete`、`count`。
- 字段级权限控制 `read`、`write`；子级需同时满足父级权限。
- 权限表达式常用变量：`auth.uid`、`auth.role`、`auth.permission`、`doc`、`now`。
- `foreignKey` 写在引用方字段上，格式为 `被引用表.被引用字段`，不要写反。
- `defaultValue` 可设置默认值，`forceDefaultValue` 会强制覆盖客户端传入值，适合 `user_id`、`create_date`、`update_date` 等字段。
- `validator`、`enum`、`pattern`、`format`、`fieldRules` 用于值域和字段关系校验。

## schema.ext.js 触发器

当需要数据一致性、自动补字段、读后计数、删除前备份等逻辑时，优先使用 JQL 数据库触发器，而不是 clientDB action。

```js
module.exports = {
  trigger: {
    beforeUpdate: async function ({ updateData } = {}) {
      updateData.update_date = Date.now()
    },
    afterRead: async function ({ result } = {}) {
      // 可在这里做读后统计、日志等服务端逻辑
    }
  }
}
```

触发时机包括：

- `beforeRead` / `afterRead`
- `beforeCount` / `afterCount`
- `beforeCreate` / `afterCreate`
- `beforeUpdate` / `afterUpdate`
- `beforeDelete` / `afterDelete`

注意：

- 触发器只在 JQL 操作时生效，传统 MongoDB API 不触发。
- 触发器在云端执行，适合放置不应暴露到客户端的数据库一致性逻辑。
- 触发器比 action 云函数更安全；不要新增可被客户端随意指定的 action 来实现通用触发逻辑。

## JQL Cache Redis

对于高频、低变化查询，可配置 JQL Redis 缓存。配置文件位置：

```text
uniCloud/cloudfunctions/common/uni-config-center/uni-jql-cache-redis.json
```

示例：

```json
[
  {
    "id": "banner-list",
    "jql": "db.collection('banner').where('status==1').orderBy('sort asc').limit(10).get()",
    "expiresIn": 3600
  }
]
```

规则：

- `jql` 字符串必须和实际执行的 JQL 语句保持一致，包括单双引号，否则无法命中缓存。
- 不可缓存使用了 action 的查询。
- `multiSend` 中的简单查询需要分别配置单条查询；联表查询可配置完整的 `getTemp` + `collection(...).get()` 语句。
- 数据变更后应删除 `unicloud:jql-cache:${id}:string` 对应 Redis key，让缓存失效。

