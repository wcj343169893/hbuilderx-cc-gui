---
name: fix-console-error-uniapp-or-uniappx
description: 修复当前 uni-app/uni-app x 项目的运行控制台错误。当用户要求修复控制台报错、运行时错误或要求通过运行日志定位并直接修改代码时使用。
---

### 执行逻辑
- Step 1. **确认平台**：平台由用户指定；未指定时先询问。
  - uni-app 项目支持：`app-android` / `app-ios` / `app-harmony` / `web` / `mp-weixin` / `mp-alipay` / `mp-baidu` / `mp-toutiao` / `mp-qq` / `mp-360` / `mp-jd` / `mp-kuaishou` / `mp-lark` / `mp-xhs` / `mp-harmony`
  - uni-app x 项目支持：`app-android` / `app-ios` / `app-harmony` / `mp-weixin` / `web`
- Step 2. **首次全量日志**：运行 `node {SKILL_BASE}/getLogcat.js --platform "{platform}" --mode full`。
- Step 3. **修复项目代码**：根据日志线索判断根因；根因在项目代码中时，读取源码并直接修改。
- Step 4. **热更复检到无错误**：每次修改后运行 `node {SKILL_BASE}/getLogcat.js --platform "{platform}" --mode lastBuild`，重复直到控制台日志不再出现错误信息。

### 注意事项

- **禁止**执行语法校验、编译验证等与本技能无关的额外检查。
- **禁止**启动、重启、停止或重新运行，无法获取日志时提示用户先手动运行项目。
- 非项目代码报错不要直接修改；说明日志依据、影响范围和处理建议，不要声称已修复。
- 结束时说明结果：成功则列出修复内容和修改文件；连续 5 次仍失败则说明阻塞错误、已尝试修复和人工介入原因。
