---
name: optimize-subpackage
description: 当用户需要优化主包大小、进行分包、减小包体积、主包超限、拆分页面到分包、小程序瘦身、分析包体积时使用此技能
---

## 操作步骤

### 步骤 1：分析 `pages.json` 的主包、tabBar 与现有分包配置

读取 `pages.json` 文件，识别：

1. `pages` 数组中的所有主包页面
2. `tabBar.list` 中的 tabBar 页面路径
3. 现有的 `subPackages` 分包配置

**关键规则**：tabBar 页面必须保留在主包，其他页面都应该配置为分包。

对比主包页面和 tabBar 页面，找出所有**非 tabBar 的主包页面**，这些页面都应该配置为分包。

**分包路径规则**：

- `pages/user/user` → root: `pages/user`, path: `user`
- `pages/detail/info` → root: `pages/detail`, path: `info`
- `pages/about`（只有一层）→ **无法分包**，必须保留在主包

### 步骤 2：扫描 `static/` 目录，识别可迁移的大体积资源

扫描 `static/` 目录，识别图片、视频、音频等静态资源文件。

**建议上传到云存储的资源**：

- 图片文件（.png, .jpg, .jpeg, .gif, .webp, .svg）
- 视频文件（.mp4, .webm, .avi）
- 音频文件（.mp3, .wav, .ogg）

**必须保留在本地的资源**：

- tabBar 图标（在 tabBar.list 中引用的图片）
- 字体文件（.ttf, .woff, .woff2）
- 启动图、logo 等启动时必需的资源

### 步骤 3：调整 `pages.json` 分包配置，保留 tabBar 与不可分包页面在主包

**分包配置格式**

```json
{
  "pages": [
    // 只保留 tabBar 页面和无法分包的页面
    { "path": "pages/home/home", "style": {...} },
    { "path": "pages/mine/mine", "style": {...} }
  ],
  "subPackages": [
    {
      "root": "pages/detail",
      "pages": [
        {"path": "detail", "style": {...}}
      ]
    },
    {
      "root": "pages/user",
      "pages": [
        {"path": "user", "style": {...}},
        {"path": "profile", "style": {...}}
      ]
    }
  ],
  "tabBar": {
    "list": [...]
  }
}
```

**执行步骤**

**重要：不需要移动任何文件，只需修改 pages.json 配置**

1. 分析页面路径结构，确定分包方式：

   - `pages/user/user` → root: `pages/user`, path: `user`
   - `pages/detail/info` → root: `pages/detail`, path: `info`
   - `pages/about`（只有一层）→ **无法分包**，必须保留在主包，如果此页面不是 tabbar 页面，则报告中要让用户自己处理

2. 更新 `pages.json`：

   - 从 `pages` 数组中移除可分包的页面
   - 按 root 分组添加到 `subPackages` 配置中

3. 相同 root 的页面合并到同一个分包：
   ```json
   {
     "root": "pages/user",
     "pages": [
       {"path": "user", "style": {...}},
       {"path": "profile", "style": {...}}
     ]
   }
   ```

注意：如果项目已有 subPackages 配置，应该是合并而不是覆盖现有分包

### 步骤 4: 开启分包优化配置

检查用户的项目 `manifest.json` 文件是否开启了分包优化配置，如果开启了，跳过此步骤，示例参考下方 `json片段`

没有需要主动开启，步骤如下：

- 查找 `manifest.json` 下的 `mp-weixin`、`mp-qq`、`mp-baidu`、`mp-toutiao`、`mp-kuaishou`、`mp-alipay`、`mp-xhs`、`mp-jd` 等平台配置项
- 如果存在上述平台配置项，添加 `"optimization": { "subPackages": true }` 配置项，示例如下

```json
// manifest.json
{ 
  "mp-weixin": {
    "optimization": {
      "subPackages": true
    }
  },
  "mp-alipay": {
    "optimization": {
      "subPackages": true
    }
  }
}
```

**注意**：不要改动原有的其他配置项

### 步骤 5：复查配置并输出主包优化结果

**强制要求**：无论本次是否修改了配置文件，最终报告里都必须包含“开启运行时代码压缩”小节，并明确写出运行时代码压缩的开启路径。

执行完成后，输出最终报告：

注意：必须在报告的最后，添加以下提示

- 请手动开启运行时代码压缩
- 菜单路径：运行 -> 运行到小程序模拟器
- 勾选：运行时是否压缩代码
- 然后重新点击运行
- 开启后，调试包体积通常可进一步减小 30%-50%

## 注意事项

- tabBar 页面绝对不能配置为分包
- **不需要移动文件**，只修改 pages.json 配置，页面跳转路径也无需更新
- 只有两层及以上路径的页面（如 `pages/xxx/xxx`）才能分包
- 单层路径页面（如 `pages/about`）无法分包，因为不能将 `pages` 目录作为分包根目录
- 微信小程序限制：单个分包 2MB，总包 20MB
- 最终报告不要漏掉开启运行时代码压缩
