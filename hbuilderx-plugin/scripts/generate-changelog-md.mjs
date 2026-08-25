#!/usr/bin/env node
/**
 * 从 webview/src/version/changelog.ts（变更日志唯一数据源）的 zh 内容生成
 * hbuilderx-plugin/changelog.md（HBuilderX 插件市场的发布日志）。
 *
 * 由 `npm run bundle` 的 prebundle 钩子自动调用；也可单独运行：
 *   node hbuilderx-plugin/scripts/generate-changelog-md.mjs
 *
 * 生成规则（与仓库既有 changelog.md 风格一致）：
 *   - 每个条目输出 `## {version}（{date}）`
 *   - zh 内容中 emoji 开头的行视为分节标题，按标题关键词映射条目前缀：
 *     修复→「修复：」、优化→「优化：」、其他→「其他：」、新功能/新增→「新增：」；
 *     「本次更新」等混合小节不加前缀（条目文本本身已带 新增/修复 等动词）
 *   - 条目文本以与前缀相同的动词开头时剥掉该动词（避免「修复：修复…」）
 *
 * 解析依赖 changelog.ts 的固定结构（export const CHANGELOG_DATA: ChangelogEntry[] = [...]
 * 内容均为字面量、无 ${} 模板插值），结构变化导致解析失败时会直接报错并给出原因。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TS_PATH = path.resolve(__dirname, '..', '..', 'webview', 'src', 'version', 'changelog.ts');
const MD_PATH = path.resolve(__dirname, '..', 'changelog.md');

// 与 ChangelogDialog.tsx 的渲染器一致：emoji 开头的行为分节标题
const EMOJI_HEADING_RE = /^[✨🐛🛠️🔧🎉🚀💡⚡🔥📦]/u;

function fail(msg) {
  console.error(`[generate-changelog-md] ✗ ${msg}`);
  process.exit(1);
}

/** 按固定结构提取 CHANGELOG_DATA 数组字面量并求值（仅限仓库自有、受审查的 changelog.ts）。 */
function loadChangelogData() {
  const src = fs.readFileSync(TS_PATH, 'utf8');
  const markerIdx = src.indexOf('export const CHANGELOG_DATA');
  if (markerIdx < 0) fail(`未在 ${path.basename(TS_PATH)} 中找到 export const CHANGELOG_DATA`);

  const eqIdx = src.indexOf('=', markerIdx);
  const openIdx = src.indexOf('[', eqIdx);
  if (eqIdx < 0 || openIdx < 0) fail('CHANGELOG_DATA 赋值结构异常（应为 = [...] 数组字面量）');

  // 文件以 `];` 结尾，故最后一个 `];` 即数组闭合处，内容字符串里的 `];` 不会干扰
  const closeIdx = src.lastIndexOf('];');
  if (closeIdx < openIdx) fail('未找到 CHANGELOG_DATA 数组的闭合 `];`（请保持文件末尾结构不变）');

  const body = src.slice(openIdx, closeIdx + 1);
  if (body.includes('${')) {
    fail('条目内容含 ${} 模板插值，脚本无法安全求值；请改用纯字面量字符串');
  }

  let data;
  try {
    data = new Function(`return ${body}`)();
  } catch (e) {
    fail(`求值失败：${e.message}`);
  }
  if (!Array.isArray(data)) fail('求值结果不是数组');

  for (const entry of data) {
    const problems = [];
    if (!entry || typeof entry !== 'object') {
      problems.push('条目不是对象');
    } else {
      if (typeof entry.version !== 'string') problems.push('version 缺失');
      if (typeof entry.date !== 'string') problems.push('date 缺失');
      if (!entry.content || typeof entry.content.en !== 'string' || typeof entry.content.zh !== 'string') {
        problems.push('content.en / content.zh 缺失');
      }
    }
    if (problems.length) fail(`条目解析异常（version=${entry?.version}）：${problems.join('、')}`);
  }
  return data;
}

/** 把 zh 内容按 emoji 分节标题拆成小节；非条目、非标题的行直接报错，避免静默丢内容。 */
function parseZhSections(zh) {
  const sections = [];
  let current = null;
  for (const rawLine of zh.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('- ')) {
      if (!current) fail('条目文本出现在分节标题之前：' + line);
      current.bullets.push(line.slice(2).trim());
    } else if (EMOJI_HEADING_RE.test(line)) {
      current = { title: line, bullets: [] };
      sections.push(current);
    } else {
      fail(`无法识别的 changelog 行（既非 "- " 条目也非 emoji 分节）：${line}`);
    }
  }
  return sections;
}

/** 分节标题 → 条目前缀；「本次更新」等混合小节返回 null（不前缀）。 */
function sectionPrefix(title) {
  if (/本次更新|What's New|Changes/i.test(title)) return null;
  if (title.includes('修复') || /Fixes/i.test(title)) return '修复';
  if (title.includes('优化')) return '优化';
  if (title.includes('其他')) return '其他';
  if (/新功能|新增|Features|New/i.test(title)) return '新增';
  return null;
}

/** 剥掉与前缀重复的动词（「修复：修复…」→「修复：…」）。 */
function cleanBullet(text, prefix) {
  if (!prefix || !text.startsWith(prefix)) return text;
  return text.slice(prefix.length).replace(/^[：:、，,。.！!\s]+/, '');
}

function renderMarkdown(data) {
  const lines = [];
  for (const entry of data) {
    lines.push(`## ${entry.version}（${entry.date}）`);
    for (const section of parseZhSections(entry.content.zh)) {
      const prefix = sectionPrefix(section.title);
      // 无条目的分节（如 0.1.0「🎉 初始化」）把标题本身作为条目
      const items = section.bullets.length
        ? section.bullets.map((b) => cleanBullet(b, prefix))
        : [section.title.replace(EMOJI_HEADING_RE, '').trim()];
      for (const item of items) lines.push(prefix ? `* ${prefix}：${item}` : `* ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const data = loadChangelogData();
fs.writeFileSync(MD_PATH, renderMarkdown(data), 'utf8');
console.log(
  `[generate-changelog-md] 已生成 ${path.relative(process.cwd(), MD_PATH)}（${data.length} 个版本，来源: ${path.basename(TS_PATH)} 的 zh 内容）`
);
