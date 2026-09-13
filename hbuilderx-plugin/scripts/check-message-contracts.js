#!/usr/bin/env node
/**
 * 前后端消息契约校验（治本工具）。
 *
 * 背景：webview 从 JetBrains 版整体移植（契约面完整），后端 message-router.js 手工逐个补 case，
 * 极易漏 → 前端能触发、后端无 case → 走 default 静默 → 用户体验为「点了没反应 / 一直转圈」。
 * 这类 bug 已反复出现（send_message_with_attachments、Codex 供应商、show_editable_diff、open_diff…）。
 *
 * 契约有**两个方向**，两条都会静默失效，所以两条都查：
 *   出站（前端 → 宿主）：sendToJava / sendBridgeEvent 的事件名  vs  message-router.js 的 case
 *                        缺 case → 走 default 静默丢弃 → 「点了没反应」
 *   入站（宿主 → 前端）：hbuilderx-plugin/lib 里 callJs('name')  vs  前端 window.name = 的注册
 *                        前端没注册 → bridge 调了个不存在的函数 → 宿主以为通知过了，界面毫无动静
 *
 * 用法：node hbuilderx-plugin/scripts/check-message-contracts.js
 * 退出码 1 = 门禁失败。
 *
 * ── 2026-09-13 修正（B0d）─────────────────────────────────────────────────
 * 旧正则是 /send(?:ToJava|BridgeEvent)\(\s*['"`]([a-z_]+)['"`]/，要求事件名后**紧跟闭合引号**。
 * 但本仓库前端大量使用「冒号形式」把 payload 拼进同一个字符串：
 *
 *     sendToJava('get_streaming_enabled:')                       // 空 payload
 *     sendToJava(`set_ui_font_config:${JSON.stringify(cfg)}`)    // 模板字面量
 *
 * 这些调用旧正则一个都看不见，于是脚本长期报告「缺口=0」，而实际有 46 个前端事件宿主侧
 * 根本没有 case ——门禁在说谎，B0b 的「契约缺口清零」也只清了它看得见的那一半。
 * 现在正则接受「引号闭合」或「冒号」两种结尾，把冒号形式与模板形式一并纳入；同时补上了
 * 此前完全没查的入站方向。
 *
 * 欠账清单（KNOWN_GAPS / KNOWN_INBOUND_GAPS）：上面这两项修正**暴露出来的既有欠账**，
 * 不是新引入的回归。若直接让门禁红掉，B1~B11 每一批都会被一堆与本批无关的历史欠账挡住。所以：
 *   - 清单里的缺口 → 打印提醒，不失败
 *   - 任何**不在**清单里的新缺口 → 失败（这才是门禁真正要防的：本批次新漏的）
 *   - 清单里已经实现 / 已不再触发的条目 → 失败，要求删除该条目
 *     （欠账清单只能变短，不能变成又一个「填了就忘」的白名单）
 *
 * 结构：扫描与判定分开，judge() 是纯函数，便于 check-message-contracts.test.js 直接测判定逻辑
 * （门禁本身也要有测试——它错了会连累后面每一个批次）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WEBVIEW_SRC = path.join(ROOT, 'webview', 'src');
const ROUTER = path.join(ROOT, 'hbuilderx-plugin', 'lib', 'message-router.js');
const LIB_DIR = path.join(ROOT, 'hbuilderx-plugin', 'lib');

// 前端内部信号 / 无需后端处理的事件白名单（在此列出即视为「有意不实现」，不算缺口）。
// 新增此类事件时在这里登记，并写明理由，便于维护者区分「故意忽略」与「漏实现」。
const INTENTIONALLY_UNHANDLED = new Set([
  'heartbeat',            // 前端保活心跳，后端无需响应
  'frontend_ready',       // 前端就绪通知（若后端不依赖）
  'tab_status_changed',   // HBuilderX 单会话，tab 状态无需后端
  'tab_loading_changed',
  'tab_created',
  // HBuilderX 插件宿主为单例 webview，无 IntelliJ ToolWindow 多 tab 概念；前端"新建 tab"
  // 按钮已改为按 onNewTab 是否传入条件渲染（App.tsx 不传，见 ChatHeader.tsx）。
  'create_new_tab',
  // HBuilderX 是 HTML/JS/uni-app IDE，无 Java PSI，类导航能力恒为 false
  // （见 message-router.js 'get_linkify_capabilities' case）；前端据此在
  // webview/src/utils/linkify.ts 隐藏 @ClassName 跳转入口，正常使用中不会触发到。
  'open_class',
]);

/**
 * 欠账清单：修正正则后暴露的既有未实现事件。
 * 值 = 归属批次 / 说明。清掉一个就从这里删一个——**只减不增**。
 * 新批次若引入新缺口，应当在该批次内实现或登记进 INTENTIONALLY_UNHANDLED，而不是加到这里。
 */
const KNOWN_GAPS = new Map([
  // ── 设置持久化组：前端有开关 UI，宿主从未落盘，重启即回默认值 ──────────────
  ['get_streaming_enabled', '设置组：流式开关'],
  ['get_send_shortcut', '设置组：发送快捷键'],
  ['get_auto_open_file_enabled', '设置组：自动打开文件'],
  ['get_permission_dialog_timeout', '设置组：授权弹窗超时'],
  ['set_permission_dialog_timeout', '设置组：授权弹窗超时'],
  ['get_ai_title_generation_enabled', '设置组：AI 生成会话标题'],
  ['set_ai_title_generation_enabled', '设置组：AI 生成会话标题'],
  ['get_status_bar_widget_enabled', '设置组：状态栏挂件（HBuilderX 无对应 API，待评估改为白名单）'],
  ['set_status_bar_widget_enabled', '设置组：状态栏挂件（同上）'],
  ['get_codex_sandbox_mode', '设置组：Codex sandbox 档位'],
  ['set_codex_sandbox_mode', '设置组：Codex sandbox 档位'],
  ['set_user_language', '设置组：界面语言'],
  ['clear_user_language', '设置组：界面语言'],
  // ── 字体配置组 ────────────────────────────────────────────────────────────
  ['get_ui_font_config', '字体组：界面字体'],
  ['set_ui_font_config', '字体组：界面字体'],
  ['get_code_font_config', '字体组：代码字体'],
  ['set_code_font_config', '字体组：代码字体'],
  ['get_editor_font_config', '字体组：跟随编辑器字体'],
  ['browse_ui_font_file', '字体组：选择字体文件'],
  ['browse_code_font_file', '字体组：选择字体文件'],
  // ── 通知与声音组：B2 的 AskUserQuestion 通知开关就并排挂在这里 ────────────
  ['get_task_completion_notification_enabled', '通知组：任务完成通知'],
  ['set_task_completion_notification_enabled', '通知组：任务完成通知'],
  ['get_sound_notification_config', '声音组：提示音配置'],
  ['set_sound_notification_enabled', '声音组：提示音开关'],
  ['set_sound_only_when_unfocused', '声音组：仅失焦时提示（B5 上游也会改这条）'],
  ['set_selected_sound', '声音组：选择内置提示音'],
  ['set_custom_sound_path', '声音组：自定义提示音'],
  ['browse_sound_file', '声音组：选择声音文件'],
  ['test_sound', '声音组：试听'],
  // ── Prompt（原 Agent）管理组：整组未实现 ──────────────────────────────────
  ['add_prompt', 'Prompt 组：新增'],
  ['update_prompt', 'Prompt 组：修改'],
  ['delete_prompt', 'Prompt 组：删除'],
  ['export_prompts', 'Prompt 组：导出'],
  ['import_prompts_file', 'Prompt 组：导入（选文件）'],
  ['save_imported_prompts', 'Prompt 组：导入（落盘）'],
  // ── Commit AI 组：方案第六节列为 B5 的 spike 项（HBuilderX 有无可写提交信息 API）──
  ['get_commit_ai_config', 'Commit AI：B5 spike'],
  ['set_commit_ai_config', 'Commit AI：B5 spike'],
  ['get_commit_generation_enabled', 'Commit AI：B5 spike'],
  ['set_commit_generation_enabled', 'Commit AI：B5 spike'],
  ['get_commit_prompt', 'Commit AI：B5 spike'],
  ['set_commit_prompt', 'Commit AI：B5 spike'],
  ['set_project_commit_prompt', 'Commit AI：B5 spike'],
  // ── Prompt Enhancer 组：方案 3.3 注明 B6 重新对齐契约 ─────────────────────
  ['enhance_prompt', 'Prompt Enhancer：B6'],
  ['get_prompt_enhancer_config', 'Prompt Enhancer：B6'],
  ['set_prompt_enhancer_config', 'Prompt Enhancer：B6'],
  // ── 其它 ──────────────────────────────────────────────────────────────────
  ['save_json', '导出：会话另存为 JSON'],
]);

/**
 * 入站方向的欠账：宿主 callJs 了、但前端没有注册对应 window 回调的名字。
 * 与 KNOWN_GAPS 同样的规则：只减不增，过期条目要删。
 */
const KNOWN_INBOUND_GAPS = new Map([
  // 宿主在 _checkStalledTasks 里推送停滞任务健康度，前端从未注册该回调 —— 纯空转。
  // 归 B3（异步子代理生命周期跟踪）：那一批会重做整个任务状态上报链路（onTaskEvent），
  // 届时要么把它接上，要么连同宿主这一侧的调用一起删掉。
  ['taskHealthUpdate', 'B3：子代理/任务状态上报链路重做时收口'],
]);

// ==================== 扫描 ====================

/** 事件名后允许两种结尾：闭合引号（纯事件名）或冒号（payload 拼在同一字符串里）。
 *  用反向引用 \1 要求闭合引号与开引号同种，避免 'a` 这类跨引号误匹配。 */
const EVENT_RE = /send(?:ToJava|BridgeEvent)\(\s*(['"`])([a-z][a-z0-9_]*)(?:\1|:)/g;
const CASE_RE = /case\s+['"`]([a-z][a-z0-9_]*)['"`]/g;
const CALLJS_RE = /callJs\(\s*['"`]([a-zA-Z_][a-zA-Z0-9_]*)['"`]/g;
const CALLBACK_RES = [
  /\bwindow\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g,
  /\(window as [^)]*\)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/g,
];

function walk(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

function collect(src, re, group) {
  const out = [];
  for (const m of src.matchAll(re)) out.push(m[group]);
  return out;
}

function scan() {
  const frontendEvents = new Set();
  const frontendCallbacks = new Set();
  for (const file of walk(WEBVIEW_SRC, [])) {
    const src = fs.readFileSync(file, 'utf8');
    for (const e of collect(src, EVENT_RE, 2)) frontendEvents.add(e);
    for (const re of CALLBACK_RES) {
      for (const c of collect(src, re, 1)) frontendCallbacks.add(c);
    }
  }

  const backendCases = new Set(collect(fs.readFileSync(ROUTER, 'utf8'), CASE_RE, 1));

  // 入站调用散落在整个 lib 目录，不只 message-router
  const hostCallbacks = new Set();
  for (const name of fs.readdirSync(LIB_DIR)) {
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    const src = fs.readFileSync(path.join(LIB_DIR, name), 'utf8');
    for (const c of collect(src, CALLJS_RE, 1)) hostCallbacks.add(c);
  }

  return { frontendEvents, frontendCallbacks, backendCases, hostCallbacks };
}

// ==================== 判定（纯函数）====================

/**
 * 对一个方向做判定。
 * @param {Iterable<string>} produced 会被触发的一侧（前端发的事件 / 宿主调的回调）
 * @param {Set<string>} consumed 应当接住它的一侧（后端 case / 前端注册的 window 回调）
 * @param {Set<string>} whitelist 有意不实现（可为空集）
 * @param {Map<string,string>} backlog 已知欠账 → 说明
 * @returns {{ missing: string[], newGaps: string[], outstanding: string[], staleBacklog: string[] }}
 */
function judge(produced, consumed, whitelist, backlog) {
  const missing = [...produced].filter((e) => !consumed.has(e)).sort();
  const missingSet = new Set(missing);
  return {
    missing,
    newGaps: missing.filter((e) => !whitelist.has(e) && !backlog.has(e)),
    outstanding: missing.filter((e) => backlog.has(e)),
    // 欠账清单里已经不成立的条目：要么被实现了，要么触发方已不再触发。
    staleBacklog: [...backlog.keys()].filter((e) => !missingSet.has(e)).sort(),
  };
}

// ==================== 报告 ====================

function main() {
  const { frontendEvents, frontendCallbacks, backendCases, hostCallbacks } = scan();

  const out = judge(frontendEvents, backendCases, INTENTIONALLY_UNHANDLED, KNOWN_GAPS);
  const inb = judge(hostCallbacks, frontendCallbacks, new Set(), KNOWN_INBOUND_GAPS);

  console.log(
    `[契约校验·出站] 前端事件=${frontendEvents.size} 后端case=${backendCases.size} ` +
    `白名单=${INTENTIONALLY_UNHANDLED.size} 欠账=${out.outstanding.length}/${KNOWN_GAPS.size} ` +
    `新增缺口=${out.newGaps.length}`
  );
  console.log(
    `[契约校验·入站] 宿主callJs=${hostCallbacks.size} 前端注册=${frontendCallbacks.size} ` +
    `欠账=${inb.outstanding.length}/${KNOWN_INBOUND_GAPS.size} ` +
    `新增缺口=${inb.newGaps.length}`
  );

  const staleWhitelist = [...INTENTIONALLY_UNHANDLED].filter((e) => !frontendEvents.has(e)).sort();
  if (staleWhitelist.length) {
    console.log('\n提示：以下事件在 INTENTIONALLY_UNHANDLED 白名单里，但前端已不再发送（可考虑清理）：');
    for (const e of staleWhitelist) console.log('  - ' + e);
  }

  if (out.outstanding.length) {
    console.log(`\n出站既有欠账（KNOWN_GAPS，${out.outstanding.length} 个，不阻断门禁，按批次逐步清零）：`);
    const byGroup = new Map();
    for (const e of out.outstanding) {
      const note = KNOWN_GAPS.get(e);
      if (!byGroup.has(note)) byGroup.set(note, []);
      byGroup.get(note).push(e);
    }
    for (const [note, events] of byGroup) console.log(`  [${note}] ${events.join(', ')}`);
  }

  if (inb.outstanding.length) {
    console.log(`\n入站既有欠账（KNOWN_INBOUND_GAPS，${inb.outstanding.length} 个，不阻断门禁）：`);
    for (const c of inb.outstanding) console.log(`  - ${c}  [${KNOWN_INBOUND_GAPS.get(c)}]`);
  }

  let failed = false;

  if (out.staleBacklog.length) {
    failed = true;
    console.log('\n❌ 以下出站条目已不再是缺口（后端已补 case，或前端已不再发送），请从 KNOWN_GAPS 中删除：');
    for (const e of out.staleBacklog) console.log('  - ' + e);
    console.log('  （欠账清单只能变短。留着过期条目会让「还欠多少」这个数字失真。）');
  }
  if (inb.staleBacklog.length) {
    failed = true;
    console.log('\n❌ 以下入站条目已不再是缺口（前端已注册，或宿主已不再调用），请从 KNOWN_INBOUND_GAPS 中删除：');
    for (const c of inb.staleBacklog) console.log('  - ' + c);
  }
  if (out.newGaps.length) {
    failed = true;
    console.log('\n❌ 以下事件前端会发送、但后端 message-router.js 没有对应 case（→ 点击静默无反应）：');
    for (const e of out.newGaps) console.log('  - ' + e);
    console.log('\n请在 dispatch() 中补 case；若确实无需后端处理，加入 INTENTIONALLY_UNHANDLED 并写明理由。');
    console.log('不要为了让门禁变绿而把它加进 KNOWN_GAPS —— 那张表只登记 B0d 当时既有的欠账。');
  }
  if (inb.newGaps.length) {
    failed = true;
    console.log('\n❌ 以下回调宿主会调用、但前端没有注册 window 回调（→ 宿主以为通知过了，界面毫无动静）：');
    for (const c of inb.newGaps) console.log('  - ' + c);
    console.log('\n请在 webview/src/hooks/windowCallbacks/ 注册该回调，或删掉宿主侧这次多余的 callJs。');
  }

  if (failed) process.exitCode = 1;
  else console.log('\n契约门禁通过：无新增缺口。');
}

module.exports = { judge, scan, EVENT_RE, CASE_RE, CALLJS_RE, CALLBACK_RES, INTENTIONALLY_UNHANDLED, KNOWN_GAPS, KNOWN_INBOUND_GAPS };

if (require.main === module) main();
