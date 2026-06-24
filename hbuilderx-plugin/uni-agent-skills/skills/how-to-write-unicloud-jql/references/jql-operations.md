# JQL 支持操作速查

当任务需要判断 JQL 能否实现某类数据库操作，或需要事务、聚合、复杂统计示例时，按需读取本文件。

## 入口

- 客户端（uni-app / uni-app x）：`const db = uniCloud.database()`。
- 云函数/云对象：`const dbJQL = uniCloud.databaseForJQL({ event, context })` 或 `uniCloud.databaseForJQL({ clientInfo: this.getClientInfo() })`。
- 客户端查询优先使用 JQL/clientDB 或 `<unicloud-db>`；JQL 查询无法实现、不适合在客户端暴露，或需要服务端聚合敏感逻辑时，再改用云函数/云对象等其他方式查询。
- 云函数/云对象中只有在用户明确要求 JQL、项目已有 JQL、或需要 schema / foreignKey / tree / trigger 等 JQL 能力时才使用 JQL。

## JQL 支持的操作概览

### 查询类

- 单表查询：`collection().where().field().orderBy().skip().limit().get()`。
- 按文档 ID 查询：`collection().doc(id).get()`。
- 单条查询：`get({ getOne: true })`。
- 同时返回总数：`get({ getCount: true })`。
- 只统计数量：`collection().where().count()`。
- 分页：`skip(offset).limit(pageSize)`，组件中用 `page-size`、`page-current`、`page-data`。
- 排序：`orderBy('field1 asc,field2 desc')`。
- 字段过滤与别名：`field('title,author as writer')`。
- 正则查询：`where('/keyword/i.test(title)')`。
- 复杂条件：`where('status == 1 && price > 0')`、`where('field in ["a","b"]')`。
- 数据库运算方法：在 `where`、`field`、`groupBy`、`groupField` 中使用 `add()`、`eq()`、`dateToString()`、`sum()` 等。

### 联表、树和批量发送

- 基于 schema `foreignKey` 的联表查询：`collection('order,book')` 或临时表 `collection(orderTemp, bookTemp)`。
- 推荐临时表联表：`db.collection('order').where(...).field(...).getTemp()` 后再 `db.collection(orderTemp, bookTemp).get()`。
- 手动指定关联关系：`foreignKey()`，用于多个 `foreignKey` 只希望部分生效的场景。
- 树形查询：schema 中配置 `parentKey` 后使用 `get({ getTree: ... })` / `getTreePath`。
- 多请求合并：`multiSend(temp1, temp2)`，只能合并查询类请求。

### 统计和聚合类

- 分组统计：`groupBy('grade,class').groupField('sum(score) as total,count(*) as count').get()`。
- 去重：`field('category_id').distinct().get()`。
- MongoDB 聚合管道：`collection().aggregate().match(...).group(...).project(...).end()`，适合 JQL 链式语法难以表达的复杂读取。
- 地理位置查询：`geoNear()`，用于地理位置附近数据读取。

### 写入类

- 新增单条/多条：`collection().add(object | array)`。
- 按 ID 更新：`collection().doc(id).update(data)`。
- 按条件更新：`collection().where(condition).update(data)`。
- 按 ID 删除：`collection().doc(id).remove()`。
- 按条件删除：`collection().where(condition).remove()`。
- 事务：`startTransaction()` 后在事务对象上执行多条 `add/update/remove`，再 `commit()` 或 `rollback()`。

### Schema 相关能力

- 权限校验：表级 `create/read/update/delete/count`，字段级 `read/write`。
- 值域校验：`required`、`bsonType`、`enum`、`pattern`、`format`、`fieldRules`、`validateFunction`。
- 默认值：`defaultValue`、`forceDefaultValue`，支持 `{ "$env": "now" }`、`{ "$env": "uid" }`、`{ "$env": "clientIP" }`。
- 关联关系：`foreignKey`。
- 树形关系：`parentKey`。
- 触发器：`${collection}.schema.ext.js` 中的 `beforeRead/afterRead/beforeCreate/afterCreate/...`。
- Redis 缓存：`uni-jql-cache-redis.json` 配置固定 JQL 查询缓存。

## 操作限制

- JQL 会序列化数据库操作参数，除 `Date`、`RegExp` 外，不支持不可 JSON 序列化的值，例如 `undefined`。
- 为了严格权限控制，JQL 禁止 `set` 方法。
- 常规 JQL 更新不支持 `db.command.inc` 等更新操作符。
- 更新嵌套字段不能写 `{'a.b.c': 1}`，应写 `{ a: { b: { c: 1 } } }`。
- JQL 暂不支持更新数组内指定下标元素或匹配条件元素。
- 新增只允许 `collection().add()`。
- 修改只允许 `collection().doc(id).update({})` 或 `collection().where(condition).update({})`。
- 删除只允许 `collection().doc(id).remove()` 或 `collection().where(condition).remove()`。
- 联表临时表中如果使用 `field`，必须保留关联字段，否则无法建立关联关系。

## 方法顺序

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

## 事务操作示例

JQL 事务用于把多条新增、更新、删除合并成原子操作。常见场景：创建订单并扣库存、转账、写主表和明细表。事务通常放在云函数/云对象中，不要把跨表一致性流程放在客户端。

```js
'use strict'

exports.main = async (event, context) => {
  const { productId, quantity } = event
  const dbJQL = uniCloud.databaseForJQL({ event, context })
  const transaction = await dbJQL.startTransaction()

  try {
    const productRes = await transaction.collection('product')
      .doc(productId)
      .get({ getOne: true })

    const product = productRes.data
    if (!product || product.stock < quantity) {
      throw new Error('库存不足')
    }

    const orderRes = await transaction.collection('order').add({
      product_id: productId,
      quantity,
      status: 'created',
      create_date: Date.now()
    })

    await transaction.collection('product')
      .doc(productId)
      .update({
        stock: product.stock - quantity
      })

    await transaction.commit()

    return {
      errCode: 0,
      orderId: orderRes.id
    }
  } catch (error) {
    await transaction.rollback()
    return {
      errCode: 'ORDER_CREATE_FAILED',
      errMsg: error.message || '创建订单失败'
    }
  }
}
```

事务注意事项：

- HBuilderX 4.81+ 支持 JQL 事务。
- JQL 事务不支持 `doc.set`、`where.updateAndReturn`。
- JQL 事务中的 `update` 不支持更新操作符；如果必须使用 `inc` 等原生更新操作符，应使用 `uniCloud.database()` 的原生事务。
- 事务中仍应考虑 schema 权限和值域校验；服务端可信逻辑可结合 `setUser()` 指定执行身份。
- 触发器入参中的 `transaction` 对象是原生 `uniCloud.database()` 事务对象，可用于判断当前是否在事务内执行。

## MongoDB 聚合操作说明

JQL API 支持 `aggregate()` 管道读取数据。适合以下场景：

- JQL 的 `where/field/groupBy/groupField` 难以表达的复杂读取。
- 需要 `$match`、`$project`、`$group`、`$sort`、`$sample` 等 MongoDB 聚合阶段。
- 随机抽样、复杂数组处理、复杂字段投影、跨阶段计算。

示例：随机取 `status` 为 1 的 20 条数据。

```js
const db = uniCloud.database()

const res = await db.collection('article')
  .aggregate()
  .match({
    status: 1
  })
  .sample({
    size: 20
  })
  .end()
```

云函数/云对象中使用 JQL 聚合时，入口换成 `databaseForJQL`：

```js
const dbJQL = uniCloud.databaseForJQL({ event, context })

const res = await dbJQL.collection('article')
  .aggregate()
  .match({
    status: 1
  })
  .project({
    title: 1,
    create_date: 1
  })
  .sort({
    create_date: -1
  })
  .end()
```

聚合注意事项：

- 聚合是读取类操作，链式末尾使用 `end()`，不是 `get()`。
- 如果简单统计能用 `groupBy/groupField` 表达，优先使用 JQL 简化写法，代码更短、更贴近 schema 权限模型。
- 聚合管道写法更接近 MongoDB 原生聚合，复杂度更高；只有普通 JQL 查询/统计不足时再使用。
- 聚合仍需要考虑 schema 权限、字段权限和敏感字段访问限制。
- 在 `<unicloud-db>` 组件中通常不用直接写聚合；组件展示列表、详情、分页、联表时优先使用组件属性或临时表联表。

## multiSend 示例

```js
const db = uniCloud.database()
const bannerQuery = db.collection('banner').field('url,image').getTemp()
const noticeQuery = db.collection('notice').field('text,url,level').getTemp()
const res = await db.multiSend(bannerQuery, noticeQuery)

const bannerResult = res.dataList[0]
const noticeResult = res.dataList[1]
```

注意：`multiSend` 的整体 `errCode` 为 0 不代表每条子查询都成功，需要分别检查 `dataList` 内每一项的 `errCode` / `errMsg`。
