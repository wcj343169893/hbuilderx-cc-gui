# 云函数和云对象内使用 JQL

当用户明确要求云函数/云对象使用 JQL，或项目已有云端 JQL，或需要依赖 schema/JQL 能力时，按需读取本文件。

## 云函数和云对象内使用 JQL

云函数：

```js
'use strict'

exports.main = async (event, context) => {
  const dbJQL = uniCloud.databaseForJQL({
    event,
    context
  })

  const res = await dbJQL.collection('article')
    .where('status == 1')
    .orderBy('create_date desc')
    .limit(20)
    .get()

  return res
}
```

云对象：

```js
module.exports = {
  async listArticles() {
    const dbJQL = uniCloud.databaseForJQL({
      clientInfo: this.getClientInfo()
    })

    return await dbJQL.collection('article')
      .where('status == 1')
      .limit(20)
      .get()
  }
}
```

指定执行身份：

```js
dbJQL.setUser({
  role: ['admin'],
  permission: []
})
```

注意：

- `setUser` 会影响后续 JQL 的 schema 权限校验身份；仅在服务端可信代码中使用。
- 如果云函数自己实现复杂权限，可将 schema 权限设为保守值，并在服务端以 admin 角色执行必要操作。
- 不要为了通过权限校验而在客户端伪造身份或绕过 schema。

