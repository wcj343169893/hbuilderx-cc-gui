# Codex Pet（陪伴宠物）HBuilderX 方案：不照搬 Swing，改为前端渲染

- 日期：2026-09-12
- 决策：**做**，但不按上游实现移植。上游的宠物是 IntelliJ Swing 浮窗（约 4150 行 Java），在 HBuilderX 无等价能力；改为「宿主只管资产与状态、渲染全在 webview」的重做方案。
- 关联：`docs/plans/2026-09-12-upstream-sync-port-plan.md`（批次 B11）

---

## 一、为什么不照搬

| 上游文件 | 行数 | HBuilderX 可用性 |
|---|---|---|
| `pet/CodexPetFloatingService.java` | 1857 | **不可用**：`JWindow` 覆盖在 IDE `JFrame` 上，跟随窗口移动/缩放/激活；HBuilderX 插件没有浮窗 API |
| `handler/CodexPetHandler.java` | 1205 | 逻辑可参考，需重写为 JS（资产读写、petdex 安装、配置持久化） |
| `pet/PetdexRepository.java` | 806 | 逻辑可参考，需重写为 JS（下载校验、落盘、预览图） |
| `pet/CodexPetImageSupport.java` | 281 | 逻辑可参考（精灵图校验、预览裁切） |
| `webview/src/components/codexPet/*`、`settings/PetSettingsSection` | ~1200（TS） | **直接 merge 复用**（`petBridge.ts`、`petState.ts`、`CodexPetStatusBridge.tsx`、设置页） |

结论：Java 侧 4150 行不移植；真正要写的是一个 **webview 内的精灵图渲染器** + 一套**宿主侧资产服务**。而且渲染改到前端其实更省事——宠物资产本身就是 web 原生格式（PNG/WebP/GIF 精灵图）。

## 二、可以直接借鉴的现成实现（用户提到的「陪伴机器人」）

| 项目 | 许可 | 对我们的价值 |
|---|---|---|
| [pet-viewer-for-codex](https://github.com/yutat23/pet-viewer-for-codex)（yutat23） | MIT | **最贴合**：VS Code 扩展，webview 面板里用精灵图动画渲染 Codex 宠物（PNG/WebP/GIF），Canvas 画像素背景，直接读 `~/.codex/pets` / `$CODEX_HOME/pets` 的 `pet.json` + 精灵图。和上游同一套资产约定，渲染思路可直接搬到 HBuilderX webview |
| [vscode-pets](https://github.com/tonybaloney/vscode-pets)（tonybaloney） | MIT | 另一条路线的参考：webview panel + explorer 侧边栏 webview view 两种宿主形态、球/激光笔互动、主题背景。适合参考「宠物放在哪个容器里」与互动玩法 |
| [openai/skills 的 hatch-pet](https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet) | 见仓库 | 上游「孵化宠物」就是调这个 curated skill（`prepare_hatch_pet_command`）：给一张参考图，由 Codex 生成宠物。HBuilderX 侧只需拼命令 + 走现有 Codex 发送链路 |
| [petdex.dev](https://petdex.dev) | 各宠物自带 | 宠物目录：`https://petdex.dev/api/manifest`，上游只允许 `petdex.dev` / `assets.petdex.dev` 两个 host，精灵图上限 4MB |

**许可合规**：若直接复制 pet-viewer-for-codex 的渲染代码，必须在仓库内保留其 MIT 许可与出处（建议新建 `THIRD-PARTY-NOTICES.md` 登记）；只参考思路自行实现时，在代码注释里注明参考来源即可。petdex 上的宠物各自有许可，**运行时下载、不入库、不随插件分发**（与上游一致）。

## 三、资产约定（与上游/VS Code 生态保持兼容，不要自创格式）

- 安装目录：`~/.codex/pets/<slug>/`，内含 `pet.json` + `spritesheet.<png|webp|gif>`
- petdex 精灵图网格：**8 列 × ≥9 行，单帧 192×208**（上游 `CodexPetImageSupport` 的校验口径）
- 预览图：从精灵图裁第一帧生成（上游已有 `createPreviewPng` / data URL 逻辑）

保持兼容的好处：用户在 VS Code / IDEA / HBuilderX 三边装的宠物是同一份，不需要重复下载。

## 四、HBuilderX 侧架构

### 宿主能力边界（关键约束）

`hbuilderx-plugin/lib/webview-host.js:92` 是 `webview.html = <字符串>`——**HBuilderX webview 吃的是 HTML 字符串，没有基准 URL**，因此：

- 精灵图**不能**用文件路径引用，必须由宿主读盘后以 **data URL** 经桥接传给前端（上游已有 data URL 预览逻辑可复用），单张按 4MB 上限收口并在内存缓存
- 同理，宠物资产不参与 webview 构建，不进单文件 HTML，**不增加主面板体积**

### 分层

```
webview（新增 pet 渲染器，纯前端）
  ├─ 精灵图动画：requestAnimationFrame 驱动，按 8×N 网格取帧
  ├─ 状态机：复用上游 petState.ts / petBridge.ts（idle / 工作中 / 完成 等）
  ├─ 宿主形态 v1：主面板内的角落浮层（absolute 定位，可拖动、可隐藏）
  └─ 宿主形态 v2（可选）：ccgui.container 下新增独立 view（参考 vscode-pets 的 petsView）
hbuilderx-plugin/lib/codex-pet-service.js（新增，宿主侧只做四件事）
  ├─ 列举/读取 ~/.codex/pets（pet.json + 精灵图 → data URL）
  ├─ petdex：拉 manifest、按 host 白名单下载、校验尺寸与大小、落盘、卸载、改别名
  ├─ 配置与位置持久化（走现有 prefs.js，不要新起存储）
  └─ 外链（petdex.dev / hatch-pet 页面）走 HBuilderX 打开浏览器 API
message-router.js：补对应 case（上游共 16 个 pet 事件，见移植方案 3.4 节同源清单）
```

### 活动状态从哪来

上游用 `updateActivity(sourceId, rawState)` 把「AI 在跑 / 空闲 / 出错」喂给宠物。HBuilderX 侧**不需要新链路**：webview 里已经有 `loading` / `streamingActive` / 工具调用状态，宠物渲染器直接订阅前端状态即可，连桥接都不用过——这是渲染搬到前端的附带好处。

## 五、分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 渲染器 + 本地宠物：读 `~/.codex/pets` 列表、选择、角落浮层渲染、随 AI 状态切动画、可拖动/隐藏、位置持久化 | 手动放一个 petdex 宠物到 `~/.codex/pets`，面板里能动、状态跟着对话变 |
| P2 | petdex 集成：目录浏览、下载安装（host 白名单 + 4MB + 网格校验）、卸载、别名、预览图 | 从 petdex 装/卸各一次；非白名单 URL 与超限文件被拒 |
| P3 | 孵化（hatch-pet）：拼 openai/skills 的 hatch-pet 命令走 Codex 发送链路，生成后自动落盘并刷新列表 | 给一张参考图能产出可用宠物 |
| P4（可选） | 独立 view 形态、互动玩法（投球/激光笔）、像素背景 | —— |

P1 是「有没有宠物」的分界线，P2/P3 是「生态」。若时间紧，P1+P2 即可发版，P3 依赖 Codex 链路稳定。

## 六、风险

- **性能**：webview 里常驻 rAF 动画会持续占 CPU。必须做到：面板不可见 / HBuilderX 失焦 / 宠物隐藏时暂停动画；帧率上限 12~15fps（像素宠物足够），并在设置里提供「关闭宠物」总开关（默认关闭，按需开启）。
- **与聊天区抢空间**：角落浮层必须可拖动 + 一键隐藏，且不遮挡输入框与工具按钮；默认位置选在消息区右下且带边距。
- **资产信任**：只允许 petdex 白名单 host；下载后先校验网格与大小再落盘；`pet.json` 字段按白名单解析，不要整体 eval/反射。
- **上游分叉**：本方案与上游实现不同源，后续 merge 上游 pet 相关改动时，webview 侧（`components/codexPet/*`）会冲突。对策：渲染器独立成新目录（如 `components/codexPetRenderer/`），只复用上游的状态机与 bridge 类型，尽量不改上游文件。
