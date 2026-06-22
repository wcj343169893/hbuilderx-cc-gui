<div align="center">

# CC GUI（Claude or Codex）· HBuilderX 插件

> 在 HBuilderX 中可视化使用 **Claude Code** 与 **OpenAI Codex** 的 AI 编程助手

<img width="120" alt="CC GUI Logo" src="./docs/images/idea-claude-code-gui-logo.png" />

**简体中文** · [English Summary](#english-summary)

仓库地址：<https://github.com/wcj343169893/hbuilderx-cc-gui>

</div>

---

`hbuilderx-cc-gui` 是一款 **HBuilderX 插件**，在 IDE 右侧面板中提供 **Claude Code** 和 **OpenAI Codex** 双 AI 引擎的可视化操作界面，让 AI 辅助编程在 HBuilderX 中变得高效而直观。

本插件由 IDEA 版 [CC GUI（Claude or Codex）](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 移植而来：复用同一份 React 前端（webview）与 Node 版 `ai-bridge` 桥接层，用 Node.js 重写了原 Java/JCEF 胶水层以适配 HBuilderX。

---

## 推荐 / 赞助商

<div align="center">

<img src="https://mp-e95828c6-d51a-4218-b323-5a50121cc0eb.cdn.bspapp.com/cloudstorage/20260621222049_93_62.jpg" alt="宴席记情本小程序" width="300" />

**宴席记情本 · 小程序**

</div>

---

## 功能特性

### 双 AI 引擎
- **Claude Code** —— Anthropic 官方 AI 编程助手，支持 Opus 等多种模型
- **OpenAI Codex** —— OpenAI 强大的代码生成引擎

### 智能对话
- 流式输出（streaming chat），实时查看 AI 回复
- 上下文感知的编程助手
- `@文件` 引用，精准指定代码上下文
- 会话管理：新建 / 中断 / 按会话 ID 续聊

### 权限与安全
- 完善的权限管理，支持 Ask / Plan 审批流程
- 权限模式可配置：`askAlways` / `acceptEdits` / `bypassPermissions` / `plan`

### 会话与历史
- 历史会话浏览、搜索与收藏
- 历史消息重放

### 扩展能力
- **Provider 管理**：支持多家 API 供应商（含 DeepSeek 等）切换与管理
- **Slash 斜杠命令**
- **Skills 技能系统**
- **MCP 服务器支持**，扩展 AI 能力边界
- **Agent 智能体系统**

### IDE 集成体验
- 文件跳转与代码导航
- 跟随 HBuilderX 主题（深色 / 浅色）自动同步
- 状态栏图标入口快速唤起
- 快捷键：`Ctrl+Alt+C` 打开 CC GUI 助手，`Ctrl+Alt+A` 发送选中代码
- 右键菜单入口：编辑器内「发送选中代码到 CC GUI」、资源管理器内「添加文件到 CC GUI」

---

## 环境要求

- **HBuilderX**（建议 3.0+），并使用其内置的 **Node.js ≥ 18**
  - 本插件优先使用 HBuilderX 内置 Node（实测为 v18.20.0，满足 Claude/Codex SDK 的 `engines >=18` 且自带全局 `fetch`）。
  - Node 选择优先级：`ccgui.nodePath`（显式配置）→ HBuilderX 内置 Node（≥18 时采用）→ 系统 Node。仅当内置 Node < 18 的旧版 HBuilderX 才回退系统 Node。
- 已配置可用的 Claude / Codex 凭据（例如本机已登录 `claude`，或设置 `ANTHROPIC_API_KEY` 等环境变量），或在插件内的 Provider 管理中配置 API 供应商。

---

## 安装与使用

> 当前为开发 / 自构建方式运行，需先构建前端与安装桥接依赖。

### 1. 构建前端（生成 `hbuilderx-plugin/html/claude-chat.html`）

```bash
cd webview
npm install
npm run build
```

构建脚本会自动把单文件产物复制到 `hbuilderx-plugin/html/`。

### 2. 安装 ai-bridge 依赖（Claude / Codex SDK 在此）

```bash
cd ai-bridge
npm install
```

### 3. 在 HBuilderX 中运行

1. 用 HBuilderX 打开插件目录 `hbuilderx-plugin/`。
2. 菜单 **运行 → 运行插件**，启动调试子窗体。
3. 在子窗体中通过命令 **「打开 CC GUI 助手」** 或快捷键 **`Ctrl+Alt+C`** 打开右侧 CC GUI 面板。
4. 在面板中选择 AI 引擎与模型，即可开始对话。

更详细的开发与架构说明见 [hbuilderx-plugin/README.md](./hbuilderx-plugin/README.md)。

---

## 架构简述

```
webview（React 单文件 HTML）
        ⟷ extension.js（HBuilderX 插件进程）
        ⟷ ai-bridge（用户系统 Node 子进程）
        ⟷ Claude / Codex CLI / SDK
```

- **前端**：复用 IDEA 版同一份 React webview，构建为单文件 HTML 加载到 HBuilderX 的 WebView 中。
- **桥接**：前端与宿主之间通过 `hbuilderx.postMessage` / `webview.postMessage` 双向通信，桥接 shim 注入到 HTML，前端源码零改动。
- **ai-bridge**：以用户系统 Node（或满足版本要求的 HBuilderX 内置 Node）作为子进程运行，承载 Claude / Codex SDK，使用 NDJSON 协议与宿主通信。
- **状态持久化**：由于 HBuilderX 不支持 VSCode 的 `context.globalState`，model / mode / provider 等选择持久化到 `${hx.env.appData}/extensions/ccgui/pref.json`，重启后自动恢复；输入历史由 webview 的 localStorage 持久化。

---

## 配置 / Provider 说明

插件设置项（HBuilderX 插件配置）：

| 配置项 | 说明 |
| --- | --- |
| `ccgui.nodePath` | Node.js 可执行文件路径，留空则自动探测 |
| `ccgui.claudeCliPath` | 自定义 Claude CLI 路径，留空则使用 PATH 中的 `claude` |
| `ccgui.permissionMode` | 权限模式：`askAlways` / `acceptEdits` / `bypassPermissions` / `plan` |

**Provider 管理**：插件内支持多家 API 供应商的增删改查与切换（兼容 cc-switch 思路，支持 DeepSeek 等），切换后会将激活供应商的环境变量注入 ai-bridge 子进程。

---

## English Summary

**hbuilderx-cc-gui** is a HBuilderX plugin that brings a visual GUI for **Claude Code** and **OpenAI Codex** into the IDE. It is ported from the IDEA plugin and reuses the same React webview plus a Node `ai-bridge` that drives the Claude/Codex CLIs/SDKs.

Highlights: dual AI engine, streaming chat, context-aware assistant with `@file` references, permission management (Ask/Plan approval), session new/interrupt/resume, history browse/search/favorite, multi-provider management (incl. DeepSeek), slash commands, Skills, MCP servers, Agent system, file navigation, IDE theme sync, status-bar entry, and keybindings (`Ctrl+Alt+C` to open, `Ctrl+Alt+A` to send selection).

Requirements: HBuilderX with built-in Node ≥ 18. Build the webview (`cd webview && npm install && npm run build`), install bridge deps (`cd ai-bridge && npm install`), then open `hbuilderx-plugin/` in HBuilderX and run via 运行 → 运行插件.

Repository: <https://github.com/wcj343169893/hbuilderx-cc-gui>

---

## 致谢 (Acknowledgements)

本插件基于开源项目 **[jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)**（作者 [@zhukunpenglinyutong](https://github.com/zhukunpenglinyutong)）移植而来，复用了其前端与 ai-bridge 设计。在此向原作者及所有贡献者的辛勤工作致以诚挚的感谢！

This plugin is ported from the open-source project **[jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)**. Heartfelt thanks to the original author and all contributors for their excellent work.

原项目与本项目均采用 **MIT** 许可证开源。
