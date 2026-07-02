#!/usr/bin/env node
/**
 * 前后端消息契约校验（治本工具）。
 *
 * 背景：webview 从 JetBrains 版整体移植（契约面完整），后端 message-router.js 手工逐个补 case，
 * 极易漏 → 前端能触发、后端无 case → 走 default 静默 → 用户体验为「点了没反应 / 一直转圈」。
 * 这类 bug 已反复出现（send_message_with_attachments、Codex 供应商、show_editable_diff、open_diff…）。
 *
 * 本脚本把「逐个手工补、容易漏」变成「清单驱动、缺了就报」：
 *   - 扫描 webview/src 所有 sendToJava('x') / sendBridgeEvent('x') 的事件名（前端契约面）
 *   - 扫描 message-router.js 所有 case 'x'（后端实现面）
 *   - 报出「前端会发、后端没实现」的缺口
 *
 * 用法：node hbuilderx-plugin/scripts/check-message-contracts.js
 * 缺口非空时以退出码 1 结束 —— 可挂到 CI / pre-commit / npm scripts 做门禁，防止再漏。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WEBVIEW_SRC = path.join(ROOT, 'webview', 'src');
const ROUTER = path.join(ROOT, 'hbuilderx-plugin', 'lib', 'message-router.js');

// 前端内部信号 / 无需后端处理的事件白名单（在此列出即视为「有意不实现」，不算缺口）。
// 新增此类事件时在这里登记，并写明理由，便于维护者区分「故意忽略」与「漏实现」。
const INTENTIONALLY_UNHANDLED = new Set([
  'heartbeat',            // 前端保活心跳，后端无需响应
  'frontend_ready',       // 前端就绪通知（若后端不依赖）
  'tab_status_changed',   // HBuilderX 单会话，tab 状态无需后端
  'tab_loading_changed',
  'tab_created',
]);

function walk(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

// 前端：所有 sendToJava('x') / sendBridgeEvent('x') 的事件名
const frontendEvents = new Set();
for (const file of walk(WEBVIEW_SRC, [])) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/send(?:ToJava|BridgeEvent)\(\s*['"`]([a-z_]+)['"`]/g)) {
    frontendEvents.add(m[1]);
  }
}

// 后端：dispatch 里所有 case 'x'
const backendCases = new Set();
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
for (const m of routerSrc.matchAll(/case\s+['"`]([a-z_]+)['"`]/g)) {
  backendCases.add(m[1]);
}

const missing = [...frontendEvents]
  .filter((e) => !backendCases.has(e) && !INTENTIONALLY_UNHANDLED.has(e))
  .sort();

console.log(`[契约校验] 前端事件=${frontendEvents.size} 后端case=${backendCases.size} 白名单=${INTENTIONALLY_UNHANDLED.size} 缺口=${missing.length}`);
if (missing.length) {
  console.log('\n以下事件前端会发送、但后端 message-router.js 没有对应 case（→ 点击静默无反应）：');
  for (const e of missing) console.log('  - ' + e);
  console.log('\n请在 dispatch() 中补 case，或（若确实无需后端处理）加入 INTENTIONALLY_UNHANDLED 白名单。');
  process.exit(1);
}
console.log('契约完整，无缺口。');
