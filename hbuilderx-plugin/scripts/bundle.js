'use strict';

/**
 * 打包前置：把插件做成「自包含」目录，供 HBuilderX 发行/安装到 `plugins/<id>/` 后直接可用。
 *
 * 安装到其他电脑时，插件目录里**必须**已包含：
 *   1. html/claude-chat.html —— webview 构建产物（gitignored，需先 `cd ../webview && npm run build`）
 *   2. ai-bridge/            —— Node 桥接（含其 node_modules 里的 sql.js；SDK 不在此，运行时装到 ~/.codemoss）
 * 否则启动会报「读取 HTML 失败 ENOENT」「未找到 ai-bridge 目录（daemon.js）」。
 *
 * 本脚本把仓库根的 ai-bridge/ 复制进 hbuilderx-plugin/ai-bridge/（lib/ai-bridge-client.js 的
 * resolveAiBridgeDir 会优先用这份内置副本），并校验 html 是否就位。
 *
 * 用法：cd hbuilderx-plugin && node scripts/bundle.js   （或 npm run bundle）
 */

const fs = require('fs');
const path = require('path');

const pluginRoot = path.join(__dirname, '..');
const repoRoot = path.join(pluginRoot, '..');
const srcAiBridge = path.join(repoRoot, 'ai-bridge');
const destAiBridge = path.join(pluginRoot, 'ai-bridge');
const htmlFile = path.join(pluginRoot, 'html', 'claude-chat.html');

function fail(msg) {
  console.error(`[bundle] ✗ ${msg}`);
  process.exit(1);
}

function humanSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch (e) { /* ignore */ } }
  }
  return total;
}

// 1) 校验 webview 产物
if (!fs.existsSync(htmlFile)) {
  fail(`缺少 ${path.relative(repoRoot, htmlFile)}。请先构建前端：cd ../webview && npm install && npm run build`);
}
console.log(`[bundle] ✓ html 就位: ${path.relative(repoRoot, htmlFile)} (${humanSize(fs.statSync(htmlFile).size)})`);

// 2) 校验 ai-bridge 源与其依赖
if (!fs.existsSync(path.join(srcAiBridge, 'daemon.js'))) {
  fail(`未找到仓库根的 ai-bridge/daemon.js: ${srcAiBridge}`);
}
if (!fs.existsSync(path.join(srcAiBridge, 'node_modules', 'sql.js'))) {
  fail('ai-bridge/node_modules/sql.js 缺失。请先安装：cd ../ai-bridge && npm install');
}

// 3) 复制 ai-bridge -> hbuilderx-plugin/ai-bridge（排除 .git/.gitignore 与测试文件，保留 node_modules）
const EXCLUDE_BASENAMES = new Set(['.git', '.gitignore', '.npmrc', '.DS_Store']);
function filter(src) {
  const base = path.basename(src);
  if (EXCLUDE_BASENAMES.has(base)) return false;
  // 排除 ai-bridge 自身的测试文件（node_modules 内的保留，避免破坏依赖包结构）
  const rel = path.relative(srcAiBridge, src);
  const inNodeModules = rel.split(path.sep).includes('node_modules');
  if (!inNodeModules && /\.test\.(js|mjs|cjs)$/.test(base)) return false;
  return true;
}

console.log(`[bundle] 复制 ai-bridge -> ${path.relative(repoRoot, destAiBridge)} ...`);
fs.rmSync(destAiBridge, { recursive: true, force: true });
fs.cpSync(srcAiBridge, destAiBridge, { recursive: true, filter });

// 4) 验证产物
if (!fs.existsSync(path.join(destAiBridge, 'daemon.js'))) {
  fail('复制后未发现 ai-bridge/daemon.js，复制失败');
}
if (!fs.existsSync(path.join(destAiBridge, 'node_modules', 'sql.js'))) {
  fail('复制后未发现 ai-bridge/node_modules/sql.js，复制失败');
}
console.log(`[bundle] ✓ ai-bridge 已内置 (${humanSize(dirSize(destAiBridge))})`);
console.log('[bundle] ✅ 插件目录已自包含，可发行/上传。');
console.log('[bundle] 提示：Claude/Codex SDK 仍需用户首次在「设置 → 依赖」联网安装到 ~/.codemoss（按设计不随包分发）。');
