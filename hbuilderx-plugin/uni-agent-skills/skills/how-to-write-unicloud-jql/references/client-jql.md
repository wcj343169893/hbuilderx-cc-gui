# 客户端 JQL API 常用写法

当需要在客户端（uni-app / uni-app x）使用 `uniCloud.database()` 编写 JQL 查询或轻量增删改时，按需读取本文件。

## 客户端 JQL 基础写法

```js
const db = uniCloud.database()

const res = await db.collection('article')
  .where('status == 1 && publish_date <= $cloudEnv_now')
  .field('title,excerpt,author_id,create_date')
  .orderBy('create_date desc')
  .skip((page - 1) * pageSize)
  .limit(pageSize)
  .get({
    getCount: true
  })
```

常用规则：

- `where` 支持字符串表达式：`==`、`!=`、`>`、`>=`、`<`、`<=`、`in`、`&&`、`||`、`/regexp/.test(field)`。
- `where` 也支持对象写法：`where({ user_id: db.getCloudEnv('$cloudEnv_uid') })`。
- 云端环境变量包括 `$cloudEnv_uid`、`$cloudEnv_now`、`$cloudEnv_clientIP`。
- `field('a,b,c')` 默认返回 `_id`；可使用 `field('title as name')` 设置别名。
- `orderBy('score desc, create_date desc')` 支持多字段排序，默认升序。
- `limit` 默认 100，通常最大 1000；列表查询必须做分页，不要一次性返回大量数据。
- `get({ getOne: true })` 等价于取一条，通常搭配 `where` 或 `orderBy`。
- `count()` 只统计数量；`get({ getCount: true })` 查询列表并同时返回总数。

## 增删改写法

新增：

```js
const res = await db.collection('todo').add({
  title,
  done: false
})
```

批量新增：

```js
const res = await db.collection('todo').add([
  { title: '任务1' },
  { title: '任务2' }
])
```

更新：

```js
const res = await db.collection('todo')
  .doc(id)
  .update({
    title,
    done
  })
```

按条件批量更新：

```js
const res = await db.collection('todo')
  .where('user_id == $cloudEnv_uid && done == false')
  .update({
    done: true
  })
```

删除：

```js
const res = await db.collection('todo')
  .doc(id)
  .remove()
```

限制：

- JQL 禁止 `set`。
- JQL 更新不支持 `db.command.inc` 等更新操作符。
- 更新嵌套字段时不要写 `{'a.b.c': 1}`，应写 `{ a: { b: { c: 1 } } }`。
- 更新数组指定下标或数组内匹配元素不是 JQL 支持场景，应改用服务端原生 MongoDB API 或调整数据结构。

## 联表查询

优先使用 `getTemp()` 先过滤主表/副表，再组合成虚拟联表，避免直接全表联查：

```js
const db = uniCloud.database()

const order = db.collection('order')
  .where('user_id == $cloudEnv_uid')
  .field('book_id,quantity,create_date')
  .orderBy('create_date desc')
  .limit(20)
  .getTemp()

const book = db.collection('book')
  .field('_id,title,author,cover')
  .getTemp()

const res = await db.collection(order, book)
  .where('/三国/.test(book_id.title)')
  .field('book_id{title,author,cover},quantity,create_date')
  .get()
```

联表规则：

- 必须在 schema 中配置 `foreignKey`，例如 `order.book_id` 字段配置为 `"foreignKey": "book._id"`。
- 临时表中如果使用 `field`，必须保留关联字段：主表保留 `book_id`，副表保留 `_id`。
- 主表某字段指向副表时，返回结果会把副表数据嵌入主表关联字段下，如 `book_id: [{ title, author }]`。
- 生成虚拟联表后，原关联字段会被副表内容替换；过滤原值时通常使用 `book_id._id == "xxx"`。
- 多表联查只能依赖主表与副表之间的 `foreignKey`，不要依赖副表与副表之间的关系。
- 需要手动指定多个 `foreignKey` 中的某一个时，使用 `foreignKey()` 后再 `where()`。

## 分组、统计和去重

按字段分组统计：

```js
const res = await db.collection('score')
  .groupBy('grade,class')
  .groupField('sum(score) as totalScore,avg(score) as avgScore,count(*) as totalStudents')
  .get()
```

按日期分组：

```js
const res = await db.collection('uni-id-users')
  .groupBy('dateToString(add(new Date(0),register_date),"%Y-%m-%d","+0800") as date')
  .groupField('count(*) as newUserCount')
  .orderBy('date desc')
  .get()
```

去重：

```js
const res = await db.collection('article')
  .field('category_id')
  .distinct()
  .get()
```

注意：

- `groupField` 内使用 `count(*)`、`sum(field)`、`avg(field)` 等累积器。
- 如果在 `groupBy` 前使用 `field`，该 `field` 是预处理字段，后续只能使用预处理后的字段。
- 统计数量会触发 `count` 权限校验；不要轻易给敏感表开放 `count: true`。

## 树形查询

适合分类、部门、菜单等父子结构。前提是在 schema 中配置 `parentKey`。

```js
const res = await db.collection('department')
  .where('status == 0')
  .get({
    getTree: {
      limitLevel: 3
    }
  })
```

使用规则：

- 集合中每个节点是一条记录，通过 `parent_id` 等字段表达父子关系。
- schema 中在父级引用字段配置 `parentKey`，例如 `"parentKey": "_id"`。
- 查询子节点、父节点路径时优先使用 JQL 的 `getTree` / `getTreePath` 能力，不要手写多次查库递归。

