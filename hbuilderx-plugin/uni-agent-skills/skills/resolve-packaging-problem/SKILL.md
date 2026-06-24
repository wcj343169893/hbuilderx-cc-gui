---
name: resolve-packaging-problem
description: 解决云打包失败和报错问题，当修复Android/iOS平台云打包失败错误时使用
project: uniappx
experimental: true
---

## 变量说明

| 变量						| 说明																																				|
| --------------|  -------------------------------------------------------------------------|
| `project_path`| uni-app/uni-app x 项目的绝对路径																							|

## 辅助诊断信息

- 提交云打包的代码本地目录
  * Android：`<project_path>/unpackage/dist/build/app-android`
    **注意**：生成的kt代码在`<project_path>/unpackage/dist/build/app-android/.uniappx/android/src`目录下
  * iOS：`<project_path>/unpackage/dist/build/app-ios`

## References
- https://doc.dcloud.net.cn/uni-app-x/tutorial/app-package.html
- https://doc.dcloud.net.cn/uni-app-x/tutorial/app-env.html
