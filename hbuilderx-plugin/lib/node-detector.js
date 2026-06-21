'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * 探测用户系统 Node.js 可执行文件。
 * 移植自 src/.../bridge/NodeDetector.java 的核心策略（HBuilderX 内置 Node v16
 * 跑不动 Claude/Codex SDK，故 ai-bridge 必须用用户系统 Node 启动）。
 *
 * 优先级：
 *   1. 插件配置 ccgui.nodePath
 *   2. PATH 中的 node（which/where）
 *   3. 常见安装路径（nvm / Program Files / Homebrew / /usr/local 等）
 * 结果会缓存。
 */

let cachedNodePath = null;

function isExecutable(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** 通过运行 `node -v` 校验候选可执行，返回主版本号（失败返回 -1）。 */
function probeMajorVersion(nodePath) {
  try {
    const out = execFileSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 4000 }).trim();
    const m = /^v(\d+)\./.exec(out);
    return m ? parseInt(m[1], 10) : -1;
  } catch (e) {
    return -1;
  }
}

function fromPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['node'], { encoding: 'utf8', timeout: 4000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch (e) {
    return null;
  }
}

function commonInstallCandidates() {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const list = [];

  if (process.platform === 'win32') {
    list.push(
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs', exe),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', exe),
      path.join(process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming'), 'npm', exe),
    );
    // nvm-windows
    const nvmHome = process.env['NVM_HOME'];
    if (nvmHome && fs.existsSync(nvmHome)) {
      try {
        for (const d of fs.readdirSync(nvmHome)) {
          list.push(path.join(nvmHome, d, exe));
        }
      } catch (e) { /* ignore */ }
    }
  } else {
    list.push(
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/bin/node',
      path.join(home, '.local', 'bin', 'node'),
    );
    // nvm: ~/.nvm/versions/node/*/bin/node（取存在的）
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersions)) {
      try {
        for (const d of fs.readdirSync(nvmVersions)) {
          list.push(path.join(nvmVersions, d, 'bin', 'node'));
        }
      } catch (e) { /* ignore */ }
    }
  }
  return list;
}

// Claude/Codex SDK 要求 Node ≥18（@anthropic-ai/claude-agent-sdk 的 engines），
// 且 Node 16 缺少全局 fetch/structuredClone。低于此版本不能用于跑 ai-bridge。
const MIN_SDK_NODE_MAJOR = 18;

/**
 * 探测用于启动 ai-bridge 的 Node 路径。
 *
 * 优先级（按用户偏好，优先 HBuilderX 自带 Node）：
 *   1. 配置项 ccgui.nodePath（显式指定，直接采用，不做版本门槛——尊重用户强制选择）
 *   2. HBuilderX 内置 Node（execPath），当其 ≥18 时采用（让插件开箱即用）
 *   3. 系统 Node（PATH / 常见路径），取首个 ≥18
 *   4. 都不满足时：返回能找到的最高版本，并标记 belowMin=true 供调用方提示
 *
 * @param {{ get: (key: string) => any }} [config] HBuilderX 配置对象
 * @param {{ execPath?: string, force?: boolean }} [opts] execPath 通常传 process.execPath（HBuilderX 内置 Node）
 * @returns {{ path: string, major: number, source: string, belowMin?: boolean } | null}
 */
function detectNode(config, opts) {
  const options = opts || {};
  if (cachedNodePath && !options.force) {
    return cachedNodePath;
  }

  // 1) 配置项：用户显式指定则无条件采用
  try {
    const configured = config && config.get ? config.get('ccgui.nodePath') : '';
    if (configured && typeof configured === 'string' && isExecutable(configured)) {
      cachedNodePath = { path: configured, major: probeMajorVersion(configured), source: 'config' };
      return cachedNodePath;
    }
  } catch (e) { /* ignore */ }

  /** @type {Array<{ path: string, source: string }>} */
  const candidates = [];
  // 2) HBuilderX 内置 Node（execPath）—— 用户偏好，优先尝试
  if (options.execPath && isExecutable(options.execPath)) {
    candidates.push({ path: options.execPath, source: 'builtin' });
  }
  // 3) 系统 Node
  const onPath = fromPath();
  if (onPath) candidates.push({ path: onPath, source: 'path' });
  for (const p of commonInstallCandidates()) {
    if (isExecutable(p)) candidates.push({ path: p, source: 'common' });
  }

  let fallback = null;
  for (const c of candidates) {
    const major = probeMajorVersion(c.path);
    if (major >= MIN_SDK_NODE_MAJOR) {
      cachedNodePath = { path: c.path, major, source: c.source };
      return cachedNodePath;
    }
    if (major > 0 && !fallback) {
      fallback = { path: c.path, major, source: c.source, belowMin: true };
    }
  }

  // 没有 ≥18 的：返回最高可用（含内置 16），调用方据 belowMin 决定是否提示升级/换 Node
  if (fallback) {
    cachedNodePath = fallback;
    return cachedNodePath;
  }
  return null;
}

function resetCache() {
  cachedNodePath = null;
}

module.exports = { detectNode, resetCache, probeMajorVersion };
