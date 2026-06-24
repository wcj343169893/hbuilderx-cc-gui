---
name: submit-issue-report
description: 当用户明确要求提交 issue、上报 bug、反馈问题、生成 issue 草稿、整理可复现问题、或把当前问题提交到 HBuilderX 问题反馈系统时优先使用。本技能适用于“帮我提个 issue”“帮我反馈这个 bug”“把这个问题提交到 issues”“生成 bug 上报配置”“调用 report-bug 提交问题”等表达。优先通过 HBuilderX CLI `report-bug` 直接触发问题提交流程，并在参数不完整时生成带 TODO 注释说明的草稿配置。
experimental: true
---

### 参数说明

原始命令如下，不要额外发明参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | Bug 标题，简要描述问题。 |
| `product` | number | 是 | 产品类型，只支持固定值：`4 = HBuilderX`、`6 = uni-app x`。 |
| `step` | string | 是 | 问题复现步骤，越详细越有助于定位问题；提交前应整理为 Markdown 结构。 |
| `wantResult` | string | 否 | 期望的正确结果描述。 |
| `module` | string | 是 | 问题所属模块，填写模块 id，可通过 `--modulelist` 获取可用值。 |
| `attachmentPath` | string | 否 | 附件路径；当 `product=4` 时可用，填写一个文件即可。 |
| `runLog` | string | 否 | 运行日志文件路径，必须指向一个文件。 |
| `phoneOsPlatform` | number[] | 否 | 运行平台；仅当 `product=6` 时可用：`1 = Android`，`2 = iOS`，`3 = Web`，`4 = 微信`，`5 = 鸿蒙`。 |
| `phoneOsVersion` | string | 否 | 手机系统版本；仅当 `product=6` 时可用。 |
| `phoneBrand` | string | 否 | 手机品牌；仅当 `product=6` 时可用。 |
| `phoneModel` | string | 否 | 手机型号；仅当 `product=6` 时可用。 |
| `isVaporMode` | boolean | 否 | 是否启用蒸汽模式；仅当 `product=6` 时可用。 |
| `sampleProjectGit` | string | 否 | 示例项目 Git 地址；仅当 `product=6` 时可用。 |
| `sampleProject` | string | 否 | 本地示例项目路径；仅当 `product=6` 时可用。 |
| `projectPublic` | boolean | 否 | 本地项目是否公开；仅当 `product=6` 时可用。 |
| `picPath` | string[] | 否 | 截图路径数组；仅当 `product=6` 时可用。 |

### 执行逻辑

#### Step 1. 获取 bug 模块列表

- 直接调用 HBuilderX CLI 获取模块列表；如果上下文里已有 `hbuilderx_cli_path`，直接使用该路径：

```shell
"{hbuilderx_cli_path}" report-bug --modulelist
```

- 这个步骤的 Bash `description` 必须是：`获取 bug 模块列表`

#### Step 2. 汇总 bug 信息

- 使用脚本, 整理草稿信息，并返回配置文件路径：

```shell
node {SKILL_BASE}/prepareBugReport.js --title "{title}" --product "{product}" --step "{step}" --wantResult "{wantResult}" --module "{module}" --attachmentPath "{attachmentPath}" --runLog "{runLog}" --phoneOsPlatform "{phoneOsPlatform}" --phoneOsVersion "{phoneOsVersion}" --phoneBrand "{phoneBrand}" --phoneModel "{phoneModel}" --isVaporMode "{isVaporMode}" --sampleProjectGit "{sampleProjectGit}" --sampleProject "{sampleProject}" --projectPublic "{projectPublic}" --picPath "{picPath}"
```

- 这个步骤的 Bash `description` 必须是：`汇总 bug 信息`
- 该步骤输出中会返回 `config_path=...`；后续Step 3直接使用这个路径，不要再额外读取目录或扫描文件。

#### Step 3. 提交 bug

- 直接调用 HBuilderX CLI 提交Step 2生成的配置文件：

```shell
"{hbuilderx_cli_path}" report-bug --config "{config_path}"
```

- 这个步骤的 Bash `description` 必须是：`提交 bug`
- 如果Step 2输出了缺失字段，Step 3也必须仍然保持为固定外显步骤；此时应直接基于已有缺失信息返回“提交失败 + 缺失字段说明”，而不是额外再创建新的探测命令。


### Response Handling (For Agent)

- **If Success**：只告诉用户“提交成功”，并附上 ISSUES 详情网址。不要额外输出退出码、配置文件路径、草稿路径等内部细节。网址必须使用完整 URL 原样输出，并单独占一行，确保在聊天界面中可直接点击。
- **If Missing Fields**：告诉用户哪些配置字段仍待补充，必要时只补充最少字段说明，不要默认回显内部文件路径。
- **If Failure**：告诉用户“提交失败”，并给出失败原因；若 CLI 有有效报错，优先提炼成一句用户能看懂的失败原因。可以说明已整理了相关附件和运行日志，但不要把内部配置文件路径当作主结果返回。

- 成功返回模板

```text
提交成功。
ISSUES 详情：
https://xxx
```

- 失败返回模板

```text
提交失败。
失败原因：CLI 未返回 ISSUES 详情链接
```
