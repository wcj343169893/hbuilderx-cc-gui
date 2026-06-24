# <unicloud-db> 组件用法

当需要用 `<unicloud-db>` 组件实现列表、详情、分页、联表、加载更多或组件内增删改时，按需读取本文件。

## `<unicloud-db>` 组件用法

`<unicloud-db>` 是 clientDB 的组件封装，运行在客户端（uni-app / uni-app x）。客户端查询优先使用 `<unicloud-db>` 或 `uniCloud.database()` 的 JQL 能力；只有 JQL 查询无法实现、不适合在客户端暴露，或需要服务端聚合敏感逻辑时，才改用云函数/云对象等其他方式查询。

基础查询：

```html
<unicloud-db
  v-slot:default="{ data, loading, error, options }"
  collection="article"
  field="title,excerpt,author_id,create_date"
  where="status == 1"
  orderby="create_date desc"
  :page-size="20"
>
  <view v-if="error">{{ error.message || error.errMsg }}</view>
  <view v-else-if="loading">加载中...</view>
  <view v-else>
    <view v-for="item in data" :key="item._id">
      {{ item.title }}
    </view>
  </view>
</unicloud-db>
```

详情查询使用 `getone`，此时 `data` 是对象而不是数组：

```html
<unicloud-db
  v-slot:default="{ data, loading, error }"
  collection="article"
  field="title,content,create_date"
  :getone="true"
  :where="`_id == '${id}'`"
>
  <view v-if="error">{{ error.message || error.errMsg }}</view>
  <view v-else-if="loading">加载中...</view>
  <view v-else>{{ data.title }}</view>
</unicloud-db>
```

常用属性：

- `collection`：集合名；联表时可写 `"book,author"`，也可传 `getTemp()` 临时表数组。
- `field`：返回字段，多个字段用逗号分隔；支持 `oldName as newName`；不写会尝试返回所有字段，可能触发字段权限问题。
- `where`：JQL 查询条件，字符串或绑定变量；动态条件建议使用计算属性生成完整 JQL 字符串。
- `orderby`：排序规则，例如 `"create_date desc"` 或 `"sort asc,create_date desc"`。
- `page-size`：每页数量；默认分页数据会追加到 `data`。
- `page-data`：`add` 表示加载下一页时追加，适合移动端触底加载；`replace` 表示替换当前页，适合分页器。
- `page-current`：当前页；手动分页时可配合 `loadData({ current })`。
- `getcount`：是否返回总数；分页器场景必须开启。
- `getone`：是否只返回第一条，详情页常用。
- `loadtime`：加载时机，`auto` 默认自动加载，`onready` 在页面就绪后由属性变化触发，`manual` 完全手动加载。
- `foreign-key`：存在多个关联关系时手动指定使用哪个 `foreignKey`。
- `gettree`、`startwith`、`limitlevel`：树形查询。
- `groupby`、`group-field`、`distinct`：分组统计和去重。
- `@load`：查询成功且渲染前触发，可对 `data` 做展示前加工。
- `@error`：查询失败回调。

插槽返回值：

- `data`：查询结果；默认数组，`getone` 为 `true` 时为对象。
- `pagination`：分页信息，包含当前页、每页数量、总数等。
- `loading`：查询中状态。
- `hasMore`：是否还有下一页，适合控制 `uni-load-more`。
- `error`：错误对象。
- `options`：传给插槽的额外数据；小程序插槽访问外部数据受限时使用，不能传函数。

动态 `where` 写法：

```html
<template>
  <view>
    <input v-model="keyword" placeholder="搜索标题" />
    <unicloud-db
      ref="udb"
      v-slot:default="{ data, loading, error }"
      collection="article"
      field="title,create_date"
      :where="where"
      orderby="create_date desc"
    >
      <view v-if="error">{{ error.message || error.errMsg }}</view>
      <view v-else-if="loading">加载中...</view>
      <view v-else v-for="item in data" :key="item._id">{{ item.title }}</view>
    </unicloud-db>
  </view>
</template>

<script>
export default {
  data() {
    return {
      keyword: ''
    }
  },
  computed: {
    where() {
      if (!this.keyword) {
        return 'status == 1'
      }
      return `status == 1 && ${new RegExp(this.keyword, 'i')}.test(title)`
    }
  }
}
</script>
```

手动加载适合依赖路由参数、异步初始化或用户点击搜索的场景：

```html
<unicloud-db
  ref="udb"
  v-slot:default="{ data, loading, error }"
  collection="article"
  :where="where"
  loadtime="manual"
>
  <view v-if="error">{{ error.message || error.errMsg }}</view>
  <view v-else>{{ data }}</view>
</unicloud-db>
```

```js
export default {
  data() {
    return {
      id: '',
      where: ''
    }
  },
  onLoad(query) {
    this.id = query.id || ''
    this.where = `_id == '${this.id}'`
  },
  onReady() {
    if (this.id) {
      this.$refs.udb.loadData()
    }
  }
}
```

移动端触底加载：

```html
<unicloud-db
  ref="udb"
  v-slot:default="{ data, loading, hasMore, error }"
  collection="article"
  field="title,create_date"
  orderby="create_date desc"
  page-data="add"
  :page-size="20"
>
  <view v-if="error">{{ error.message || error.errMsg }}</view>
  <view v-for="item in data" :key="item._id">{{ item.title }}</view>
  <view v-if="loading">加载中...</view>
  <uni-load-more v-else-if="!hasMore" status="noMore" />
</unicloud-db>
```

```js
export default {
  onReachBottom() {
    this.$refs.udb.loadMore()
  },
  onPullDownRefresh() {
    this.$refs.udb.loadData({ clear: true }, () => {
      uni.stopPullDownRefresh()
    })
  }
}
```

分页器分页：

```html
<unicloud-db
  ref="udb"
  v-slot:default="{ data, pagination, loading, error }"
  collection="article"
  field="title,create_date"
  orderby="create_date desc"
  page-data="replace"
  :getcount="true"
  :page-size="20"
>
  <view v-if="error">{{ error.message || error.errMsg }}</view>
  <view v-for="item in data" :key="item._id">{{ item.title }}</view>
  <view v-if="loading">加载中...</view>
  <uni-pagination
    show-icon
    :page-size="pagination.size"
    :total="pagination.count"
    @change="onPageChange"
  />
</unicloud-db>
```

```js
export default {
  methods: {
    onPageChange(e) {
      this.$refs.udb.loadData({ current: e.current })
    }
  }
}
```

组件联表查询：

```html
<unicloud-db
  v-slot:default="{ data, loading, error }"
  collection="order,book"
  field="book_id{title,author,cover},quantity,create_date"
  where="book_id.title == '三国演义'"
>
  <view v-if="error">{{ error.message || error.errMsg }}</view>
  <view v-else>{{ data }}</view>
</unicloud-db>
```

数据量较大时，优先传临时表数组，先过滤主表再联表：

```html
<template>
  <unicloud-db v-slot:default="{ data, loading, error }" :collection="collectionList">
    <view v-if="error">{{ error.message || error.errMsg }}</view>
    <view v-else>{{ data }}</view>
  </unicloud-db>
</template>

<script>
const db = uniCloud.database()

export default {
  data() {
    return {
      collectionList: [
        db.collection('order')
          .where('user_id == $cloudEnv_uid')
          .field('book_id,quantity,create_date')
          .getTemp(),
        db.collection('book')
          .field('_id,title,author,cover')
          .getTemp()
      ]
    }
  }
}
</script>
```

组件方法：

- `loadData(options, callback)`：加载数据；`options.clear = true` 会清空数据和分页信息，常用于下拉刷新或重新搜索。
- `loadMore()`：加载下一页，成功后当前页加 1。
- `clear()`：清空已加载数据，不重置分页。
- `reset()`：重置分页，不清空已加载数据。
- `refresh()`：清空并重新加载当前页。
- `remove(id, options)`：按 `_id` 删除，支持单个 id 或 id 数组；不支持任意 `where` 删除。
- `add(value, options)`：新增数据，并封装 toast/loading/callback。
- `update(id, value, options)`：按 `_id` 更新，同时更新组件内部 `data`，使页面自动差量刷新。
- `dataList`：可通过 `this.$refs.udb.dataList` 读取或调整组件内部数据。

增删改示例：

```js
this.$refs.udb.add({ title: '新文章' }, {
  toastTitle: '新增成功'
})

this.$refs.udb.update(id, { title: '新标题' }, {
  toastTitle: '修改成功'
})

this.$refs.udb.remove(id, {
  confirmTitle: '提示',
  confirmContent: '确认删除该数据？'
})
```

组件注意事项：

- `<unicloud-db>` 仍然走 JQL 和 DB Schema 权限；前端非 admin 用户必须有对应表级、字段级权限。
- 列表页建议显式写 `field`，避免默认读取无权限字段导致 `PERMISSION_ERROR`。
- `where` 中拼接用户输入时要注意引号和转义；搜索输入应做防抖，避免每个字符都触发查询。
- `collection/action/field/getcount/orderby/where` 变化会清空已有数据；`page-current/page-size` 变化通常不重置数据，`page-data="replace"` 和 `loadtime="manual"` 除外。
- `manual` 属性已过时，优先使用 `loadtime="manual"`。
- 新增、更新、删除同样受 schema 的 `create`、`update`、`delete` 和字段 `write` 权限限制。
- 对阅读量 +1、写审计日志等服务端副作用，优先用 `schema.ext.js` 触发器；旧 `action` 能力只在维护老项目时考虑。

