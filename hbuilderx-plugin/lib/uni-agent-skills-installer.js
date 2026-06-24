'use strict';

/**
 * HBuilderX 官方 uni-agent 技能的「转换 + 预置」器。
 *
 * 背景：官方 skill（uni-agent-skills/ 已收纳）是为 HBuilderX 自带的 uni-agent 运行时设计的，
 * SKILL.md 里含两个由运行时注入的模板变量，Claude SDK 不会注入，必须在安装时替换为具体路径：
 *   - {knowledges_base_dir} -> 用户机器上已装 HBuilderX 的 .../uni-agent/knowledges（33MB 知识库不随插件分发）
 *   - {hbuilderx_cli_path}  -> 已装 HBuilderX 的 cli 可执行文件
 * 其余 {project_path}/{platform}/{name} 等是**调用期参数**，由模型按用户请求填，绝不替换。
 *
 * 另外 skill 内的 .js（checkEnv.js / getLogcat.js 等）通过 require("../../common/scripts/X.js")
 * 依赖 uni-agent 的共享脚本；skill 在「启用(~/.claude/skills)」与「停用(~/.codemoss/skills/global)」
 * 目录间移动且两者层级不同，相对路径会断链，故改造为**自包含**：把所需共享脚本平铺进 skill 目录，
 * 把 require 改写为 "./X.js"（含 logcat.js -> ./hbuilderx.js 的传递依赖）。
 *
 * 预置策略：转换后写入「停用」管理目录（~/.codemoss/skills/global/<skill>），用户在 Skills 面板
 * 一键启用即移动到 ~/.claude/skills 被 SDK 读取。幂等且不覆盖用户选择：
 *   - 仅当 skill 在「启用」与「停用」目录均不存在时才写入（不复活用户删除的、不覆盖已启用的）；
 *   - 用 prefs.uniAgentSkillsVersion 做版本闸：同版本只跑一次安装扫描。
 */

const fs = require('fs');
const path = require('path');
const skillsService = require('./skills-service');

/** 收纳进仓库的共享脚本名（uni-agent-skills/common/scripts 下）。 */
const COMMON_SCRIPT_NAMES = new Set(['hbuilderx.js', 'logcat.js', 'plugins.js']);

/** 仅这两个是「安装期环境变量」，需替换为具体路径；其余占位符是调用期参数，保持原样。 */
const VAR_KNOWLEDGES = '{knowledges_base_dir}';
const VAR_CLI = '{hbuilderx_cli_path}';

/**
 * 预置版本闸。改动收纳内容/转换逻辑时 +1，使已装用户在下次启动重新跑一遍安装扫描
 * （仍只补缺失项，不复活已删除/不覆盖已启用的）。
 */
const BUNDLE_VERSION = 1;

/** 统一用正斜杠（Windows 下经 Bash 工具调用 exe、或被模型当路径 Read 都更稳）。 */
function toSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * 解析已装 HBuilderX 的 uni-agent 目录（含 knowledges）。
 * 优先级：环境变量覆盖 > 由本插件安装位置上溯 HBuilderX 根 > 常见安装路径。
 * @returns {string|null} uni-agent 绝对路径
 */
function resolveInstalledUniAgentDir() {
  const candidatesRoots = [];

  // 1) 显式覆盖：CCGUI_UNI_AGENT_DIR 直接指向 uni-agent
  const explicit = (process.env.CCGUI_UNI_AGENT_DIR || '').trim();
  if (explicit && fs.existsSync(path.join(explicit, 'knowledges'))) return explicit;

  // 2) HBUILDERX_CLI_PATH 的所在目录即 HBuilderX 根
  const cliEnv = (process.env.HBUILDERX_CLI_PATH || '').trim();
  if (cliEnv) candidatesRoots.push(path.dirname(cliEnv));

  // 3) 本插件安装在 <HBX根>/plugins/<本插件>/lib/ -> 上溯 3 级得 <HBX根>
  candidatesRoots.push(path.resolve(__dirname, '..', '..', '..'));

  // 4) 常见安装路径兜底
  if (process.platform === 'win32') {
    candidatesRoots.push('C:\\Program Files\\HBuilderX', 'D:\\HBuilderX', 'C:\\HBuilderX');
  } else if (process.platform === 'darwin') {
    candidatesRoots.push('/Applications/HBuilderX.app/Contents/HBuilderX');
  }

  for (const root of candidatesRoots) {
    const pluginsDir = path.join(root, 'plugins');
    if (!safeIsDir(pluginsDir)) continue;
    let entries;
    try { entries = fs.readdirSync(pluginsDir); } catch (e) { continue; }
    // 插件目录名可能带版本后缀，匹配 hbuilderx-ai-chat*
    for (const name of entries) {
      if (!name.startsWith('hbuilderx-ai-chat')) continue;
      const uniAgent = path.join(pluginsDir, name, 'uni-agent');
      if (safeIsDir(path.join(uniAgent, 'knowledges'))) return uniAgent;
    }
  }
  return null;
}

/** 由 uni-agent 目录推导 HBuilderX 的 cli 可执行文件（找不到返回 null）。 */
function resolveCliPath(uniAgentDir) {
  // uni-agent -> hbuilderx-ai-chat[*] -> plugins -> <HBX根>
  const root = path.resolve(uniAgentDir, '..', '..', '..');
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'cli.exe')]
    : [path.join(root, 'cli'), path.join(root, '..', 'MacOS', 'cli')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* ignore */ }
  }
  const cliEnv = (process.env.HBUILDERX_CLI_PATH || '').trim();
  if (cliEnv && fs.existsSync(cliEnv)) return cliEnv;
  return null;
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/** 递归列出目录下全部 .js 文件绝对路径。 */
function listJsFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 递归复制目录（保留占位符，转换在后续步骤做）。 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 把 skill 目录里的脚本改造成自包含：
 *   - 把 require("../../common/scripts/X.js") 改写为 require("./X.js")，并把 X.js 平铺到该文件同目录；
 *   - 传递处理被复制脚本自身的依赖（logcat.js -> ./hbuilderx.js）。
 * @param {string} skillDir 目标 skill 目录
 * @param {string} vendoredCommonDir 收纳的 common/scripts 目录
 */
function selfContainScripts(skillDir, vendoredCommonDir) {
  // (目录 -> 需要平铺到该目录的共享脚本名集合)
  const needByDir = new Map();
  const addNeed = (dir, name) => {
    if (!COMMON_SCRIPT_NAMES.has(name)) return;
    if (!needByDir.has(dir)) needByDir.set(dir, new Set());
    needByDir.get(dir).add(name);
  };

  const COMMON_REQUIRE_RE = /(['"])\.\.\/\.\.\/common\/scripts\/([\w.-]+\.js)\1/g;
  const REL_REQUIRE_RE = /(['"])\.\/([\w.-]+\.js)\1/g;

  // 1) 改写 skill 自带 .js 的 require，记录每个目录需要哪些共享脚本
  for (const jsFile of listJsFiles(skillDir)) {
    const dir = path.dirname(jsFile);
    let code = fs.readFileSync(jsFile, 'utf-8');
    let changed = false;
    code = code.replace(COMMON_REQUIRE_RE, (m, q, name) => {
      addNeed(dir, name);
      changed = true;
      return q + './' + name + q;
    });
    // 已是 ./X.js 且 X 是共享脚本（如某些脚本本就同目录引用）也要确保平铺
    let mm;
    REL_REQUIRE_RE.lastIndex = 0;
    while ((mm = REL_REQUIRE_RE.exec(code))) addNeed(dir, mm[2]);
    if (changed) fs.writeFileSync(jsFile, code, 'utf-8');
  }

  // 2) 把需要的共享脚本平铺进对应目录，并传递处理其自身依赖
  for (const [dir, names] of needByDir.entries()) {
    const queue = [...names];
    const done = new Set();
    while (queue.length) {
      const name = queue.shift();
      if (done.has(name) || !COMMON_SCRIPT_NAMES.has(name)) continue;
      done.add(name);
      const src = path.join(vendoredCommonDir, name);
      const dst = path.join(dir, name);
      if (!fs.existsSync(src)) continue;
      let code = fs.readFileSync(src, 'utf-8');
      code = code.replace(COMMON_REQUIRE_RE, (m, q, n) => { queue.push(n); return q + './' + n + q; });
      let mm;
      REL_REQUIRE_RE.lastIndex = 0;
      while ((mm = REL_REQUIRE_RE.exec(code))) queue.push(mm[2]);
      fs.writeFileSync(dst, code, 'utf-8');
    }
  }
}

/** 替换 .md 里的两个安装期环境变量（其余占位符保持原样）。 */
function substituteEnvVars(skillDir, knowledgesBaseDir, cliPath) {
  const knowSlash = knowledgesBaseDir ? toSlash(knowledgesBaseDir) : null;
  const cliSlash = cliPath ? toSlash(cliPath) : null;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      let text = fs.readFileSync(p, 'utf-8');
      let changed = false;
      if (knowSlash && text.includes(VAR_KNOWLEDGES)) {
        text = text.split(VAR_KNOWLEDGES).join(knowSlash);
        changed = true;
      }
      // CLI 路径解析不到时保留 {hbuilderx_cli_path} 占位符 —— skill 自带 checkEnv.js 兜底探测
      if (cliSlash && text.includes(VAR_CLI)) {
        text = text.split(VAR_CLI).join(cliSlash);
        changed = true;
      }
      if (changed) fs.writeFileSync(p, text, 'utf-8');
    }
  };
  walk(skillDir);
}

/**
 * 转换并预置官方 skill（幂等、不覆盖用户选择）。
 * @param {object} opts
 * @param {string} opts.pluginRoot 插件根目录（hbuilderx-plugin/）
 * @param {{appendLine:(s:string)=>void}} [opts.output]
 * @param {object} [opts.prefs] 当前 prefs 快照（含 uniAgentSkillsVersion）
 * @param {(partial:object)=>void} [opts.persist] 持久化 prefs 的回调
 * @returns {{installed:number, skipped:number, reason?:string}}
 */
function ensureOfficialSkillsInstalled(opts) {
  const { pluginRoot, output, prefs, persist } = opts || {};
  const log = (s) => { if (output && output.appendLine) output.appendLine(`[skills-installer] ${s}`); };

  // 版本闸：同版本只跑一次（避免每次启动扫描，也避免反复尝试）
  if (prefs && prefs.uniAgentSkillsVersion === BUNDLE_VERSION) {
    return { installed: 0, skipped: 0, reason: 'already-processed' };
  }

  const vendoredRoot = path.join(pluginRoot, 'uni-agent-skills');
  const vendoredSkills = path.join(vendoredRoot, 'skills');
  const vendoredCommon = path.join(vendoredRoot, 'common', 'scripts');
  if (!safeIsDir(vendoredSkills)) {
    log(`未找到收纳的 skills 目录: ${vendoredSkills}`);
    return { installed: 0, skipped: 0, reason: 'no-vendored-skills' };
  }

  const uniAgentDir = resolveInstalledUniAgentDir();
  const knowledgesBaseDir = uniAgentDir ? path.join(uniAgentDir, 'knowledges') : null;
  const cliPath = uniAgentDir ? resolveCliPath(uniAgentDir) : null;
  log(`uni-agent=${uniAgentDir || '(未找到)'} knowledges=${knowledgesBaseDir || '-'} cli=${cliPath || '-'}`);

  // 启用目录（~/.claude/skills）与停用目录（~/.codemoss/skills/global）——任一存在则跳过
  const enabledDir = skillsService.getGlobalSkillsDir();
  const disabledDir = skillsService.getGlobalManagementDir();
  fs.mkdirSync(disabledDir, { recursive: true });

  let installed = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(vendoredSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const existsEnabled = safeIsDir(path.join(enabledDir, skillName));
    const existsDisabled = safeIsDir(path.join(disabledDir, skillName));
    if (existsEnabled || existsDisabled) { skipped++; continue; }

    const src = path.join(vendoredSkills, skillName);
    const dest = path.join(disabledDir, skillName);
    const tmp = dest + '.tmp-install';
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      copyDir(src, tmp);
      substituteEnvVars(tmp, knowledgesBaseDir, cliPath);
      selfContainScripts(tmp, vendoredCommon);
      fs.renameSync(tmp, dest); // 原子落地：避免中途失败留下半成品
      installed++;
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      log(`预置失败 ${skillName}: ${e && e.message}`);
    }
  }

  log(`完成：预置 ${installed} 个，跳过 ${skipped} 个（已存在）`);
  if (persist) {
    try { persist({ uniAgentSkillsVersion: BUNDLE_VERSION }); } catch (e) { /* ignore */ }
  }
  return { installed, skipped };
}

module.exports = {
  ensureOfficialSkillsInstalled,
  // 导出内部函数便于测试/复用
  resolveInstalledUniAgentDir,
  resolveCliPath,
  selfContainScripts,
  substituteEnvVars,
  BUNDLE_VERSION,
};
