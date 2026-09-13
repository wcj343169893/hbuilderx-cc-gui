'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

/**
 * SDK 依赖联网安装服务（移植自 src/.../dependency/DependencyManager.java 的 MVP 子集）。
 *
 * 背景：本插件**不打包** Claude/Codex SDK（体积太大、且含平台相关二进制）。SDK 运行时从
 * `~/.codemoss/dependencies/<sdkId>/node_modules/...` 动态加载（见 ai-bridge/utils/sdk-loader.js）。
 * 此前 HBuilderX 移植版只做只读状态检查、没有任何「安装」入口，导致用户装完插件无法使用。
 * 本服务复刻 IDEA 版的联网 npm 安装逻辑，让用户能在「设置 → 依赖」里一键安装/卸载/升级 SDK。
 *
 * 注意：仍依赖网络（npm install / npm view）。离线场景请预先手动安装到上述目录。
 */

// 镜像 SdkDefinition.java：包名、默认版本、附带依赖、离线 fallback 版本。
const SDK_DEFS = {
  'claude-sdk': {
    id: 'claude-sdk',
    name: 'Claude Code SDK',
    npmPackage: '@anthropic-ai/claude-agent-sdk',
    version: '^0.2.58',
    dependencies: ['@anthropic-ai/sdk', '@anthropic-ai/bedrock-sdk'],
    fallbackVersions: ['0.2.88', '0.2.81', '0.2.58'],
  },
  'codex-sdk': {
    id: 'codex-sdk',
    name: 'Codex SDK',
    npmPackage: '@openai/codex-sdk',
    version: 'latest',
    dependencies: [],
    fallbackVersions: ['0.117.0', '0.116.0', '0.115.0'],
    // 平台二进制包（@openai/codex-win32-x64 等）解压后近 200MB，国内网络 3 分钟常常下不完
    installTimeoutMs: 10 * 60 * 1000,
  },
};

const DEFAULT_INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

// Codex CLI 平台二进制包：与 @openai/codex-sdk 的 PLATFORM_PACKAGE_BY_TARGET / findCodexPath 对齐
const CODEX_PLATFORM_TARGETS = {
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
};

function codexPlatformTarget() {
  const platform = process.platform === 'android' ? 'linux' : process.platform;
  return CODEX_PLATFORM_TARGETS[`${platform}-${process.arch}`] || null;
}

/**
 * 校验 codex-sdk 能否找到 codex CLI 二进制（复刻 SDK findCodexPath 的解析方式）。
 * 背景：npm install 超时被杀时，平台包可能只解压出 vendor/ 而缺 package.json；随后 --force 重试
 * 会「成功」但保留这个残缺目录 → 依赖面板显示已安装，发送时 SDK 报
 * 「Unable to locate Codex CLI binaries」，Codex 完全不可用。
 * @returns {{ ok: boolean, reason?: string, platformDir?: string }}
 */
function verifyCodexBinary(sdkId = 'codex-sdk') {
  const target = codexPlatformTarget();
  if (!target) return { ok: true }; // 不支持的平台交给 SDK 自己报错
  const codexDir = path.join(sdkDir(sdkId), 'node_modules', '@openai', 'codex');
  if (!fs.existsSync(path.join(codexDir, 'package.json'))) return { ok: false, reason: '缺少 @openai/codex 包' };
  // 按 Node 模块查找顺序（@openai/codex 自身 node_modules → 顶层 node_modules）逐个用 fs 检查。
  // 不用 require.resolve：它缓存成功结果，宿主长驻进程里目录被删/重装后仍返回旧路径。
  const candidates = [
    path.join(codexDir, 'node_modules', ...target.pkg.split('/')),
    path.join(sdkDir(sdkId), 'node_modules', ...target.pkg.split('/')),
  ];
  const platformDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json')));
  if (!platformDir) {
    const partial = candidates.find((dir) => fs.existsSync(dir));
    return {
      ok: false,
      reason: partial ? `${target.pkg} 不完整（缺 package.json，疑似下载中断）` : `缺少平台包 ${target.pkg}`,
      platformDir: partial,
    };
  }
  const platformPkgJson = path.join(platformDir, 'package.json');
  const root = path.join(path.dirname(platformPkgJson), 'vendor', target.triple);
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const hasNew = fs.existsSync(path.join(root, 'bin', exe)) && fs.existsSync(path.join(root, 'codex-package.json'));
  const hasLegacy = fs.existsSync(path.join(root, 'codex', exe));
  if (!hasNew && !hasLegacy) {
    return { ok: false, reason: `${target.pkg} 中缺少 codex 可执行文件`, platformDir: path.dirname(platformPkgJson) };
  }
  return { ok: true };
}

/** 安装后/状态检查时的完整性校验（目前只有 codex-sdk 需要，claude-sdk 恒为 ok）。 */
function verifyInstall(sdkId) {
  return sdkId === 'codex-sdk' ? verifyCodexBinary(sdkId) : { ok: true };
}

function dependenciesDir() {
  return path.join(os.homedir(), '.codemoss', 'dependencies');
}

function sdkDir(sdkId) {
  return path.join(dependenciesDir(), sdkId);
}

function packageDir(sdkId, npmPackage) {
  // 与 sdk-loader.js getPackageDirFromRoot 对齐：node_modules/@scope/name
  return path.join(sdkDir(sdkId), 'node_modules', ...npmPackage.split('/'));
}

function readInstalledVersion(sdkId) {
  const def = SDK_DEFS[sdkId];
  if (!def) return undefined;
  try {
    const pj = path.join(packageDir(sdkId, def.npmPackage), 'package.json');
    return JSON.parse(fs.readFileSync(pj, 'utf-8')).version;
  } catch (e) {
    return undefined;
  }
}

/**
 * SDK 安装状态，形态对齐前端 updateDependencyStatus 期望：
 * { 'claude-sdk': {id,name,status,installedVersion?,installPath?,hasUpdate}, 'codex-sdk': {...} }
 */
function getStatus() {
  const out = {};
  for (const id of Object.keys(SDK_DEFS)) {
    const def = SDK_DEFS[id];
    const dir = packageDir(id, def.npmPackage);
    const entry = { id, name: def.name, status: 'not_installed', hasUpdate: false };
    try {
      if (fs.existsSync(dir)) {
        // 残缺安装（如 codex 平台二进制缺失）按未安装上报，让用户看到「安装」按钮重装，
        // 而不是显示已安装、发送时才报 Unable to locate Codex CLI binaries
        const verified = verifyInstall(id);
        if (verified.ok) {
          entry.status = 'installed';
          entry.installedVersion = readInstalledVersion(id);
          entry.installPath = dir;
        } else {
          entry.errorMessage = verified.reason;
        }
      }
    } catch (e) { /* ignore */ }
    out[id] = entry;
  }
  return out;
}

// 仅允许 major.minor.patch[-prerelease]，拒绝任何可用于 npm 参数注入的字符（复刻 SEMVER_PATTERN）。
const SEMVER = /^\d+\.\d+\.\d+([-.][a-zA-Z0-9.]+)*$/;

function normalizeVersion(v) {
  if (!v || typeof v !== 'string') return null;
  let t = v.trim();
  if (!t) return null;
  if (t[0] === 'v' || t[0] === 'V') t = t.slice(1);
  return SEMVER.test(t) ? t : null;
}

function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const a = String(v1).replace(/^v/i, '').split('.');
  const b = String(v2).replace(/^v/i, '').split('.');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(a[i], 10) || 0;
    const y = parseInt(b[i], 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function buildPackageSpecs(def, requestedVersion) {
  const norm = normalizeVersion(requestedVersion);
  const target = norm || def.version;
  return [`${def.npmPackage}@${target}`, ...def.dependencies];
}

function npmCliCandidatesFor(nodeExe) {
  const dir = path.dirname(nodeExe);
  return [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),                  // Windows 安装布局
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),     // *nix 安装布局
  ];
}

/**
 * 解析 npm-cli.js（优先，spawn(node, [npm-cli.js, ...]) 无需 shell，规避 Windows 下
 * `.cmd` + `^`（caret）在 cmd.exe 被当作转义符的坑）。
 *
 * 关键场景：HBuilderX 内置 Node（被优先选用跑 ai-bridge）目录下**没有 npm**，故除了在所选
 * nodePath 同目录找，还会探测 PATH 上系统 Node 的 npm-cli.js —— 用所选 node 去跑它即可（纯 JS，
 * 版本无关），从而即便内置 Node 无 npm 也能走无 shell 的干净路径。找不到返回 null 由调用方回退。
 */
function resolveNpmCli(nodePath) {
  const seen = new Set();
  const tryList = (exe) => {
    if (!exe || seen.has(exe)) return null;
    seen.add(exe);
    for (const c of npmCliCandidatesFor(exe)) {
      try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
    }
    return null;
  };

  // 1) 所选 node 同目录
  let cli = tryList(nodePath);
  if (cli) return cli;

  // 2) PATH 上的系统 node 同目录（内置 Node 无 npm 时的关键回退）
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['node'], { encoding: 'utf8', timeout: 4000 });
    for (const p of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      cli = tryList(p);
      if (cli) return cli;
    }
  } catch (e) { /* ignore */ }

  return null;
}

/** 回退：node 同目录的 npm/npm.cmd → PATH 中的 npm → 裸 'npm'。 */
function resolveNpmExe(nodePath) {
  const isWin = process.platform === 'win32';
  const npmName = isWin ? 'npm.cmd' : 'npm';
  if (nodePath) {
    try {
      const co = path.join(path.dirname(nodePath), npmName);
      if (fs.existsSync(co)) return co;
    } catch (e) { /* ignore */ }
  }
  try {
    const finder = isWin ? 'where' : 'which';
    const out = execFileSync(finder, [npmName], { encoding: 'utf8', timeout: 4000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch (e) { /* ignore */ }
  return npmName;
}

/**
 * 运行 npm 命令，实时回灌输出行。resolve {code, out}；不 reject。
 * 优先 spawn(node, [npm-cli.js, ...args])（无 shell）；否则回退 npm 可执行（Windows 用 shell+引号）。
 */
function runNpm(nodePath, args, opts) {
  const { cwd, onLine, timeoutMs } = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(r); } };

    let child;
    let usedCmd = '';
    const env = Object.assign({}, process.env);
    const npmCli = resolveNpmCli(nodePath);
    try {
      if (npmCli && nodePath) {
        usedCmd = `${nodePath} ${npmCli}`;
        child = spawn(nodePath, [npmCli, ...args], { cwd, env });
      } else {
        const npmExe = resolveNpmExe(nodePath);
        usedCmd = npmExe;
        if (process.platform === 'win32') {
          // .cmd 必须经 shell；含空格/caret/@ 等的参数加双引号（cmd 双引号内 ^ 视为字面量）
          const quoted = args.map((a) => (/[\s^&()@"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a));
          child = spawn(`"${npmExe}"`, quoted, { cwd, env, shell: true });
        } else {
          child = spawn(npmExe, args, { cwd, env });
        }
      }
    } catch (e) {
      done({ code: -1, out: `spawn 失败: ${e && e.message}` });
      return;
    }

    if (onLine) onLine(`[npm] 使用: ${usedCmd}`);

    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      if (onLine) s.split(/\r?\n/).forEach((l) => { if (l) onLine(l); });
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);

    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* ignore */ }
        done({ code: -2, out: `${out}\n[timeout after ${timeoutMs}ms]` });
      }, timeoutMs);
    }

    child.on('error', (err) => done({ code: -1, out: `${out}\n${err && err.message}` }));
    child.on('close', (code) => done({ code, out }));
  });
}

/**
 * 安装/升级 SDK。返回 InstallResult { success, sdkId, installedVersion?, requestedVersion?, error?, logs }。
 * @param {{ sdkId: string, version?: string, nodePath?: string, onLog?: (line:string)=>void }} p
 */
async function install(p) {
  const { sdkId, version, nodePath } = p || {};
  const onLog = (p && p.onLog) || (() => {});
  const log = (m) => { try { onLog(m); } catch (e) { /* ignore */ } };

  const def = SDK_DEFS[sdkId];
  if (!def) return { success: false, sdkId, error: `Unknown SDK: ${sdkId}` };
  if (!nodePath) return { success: false, sdkId, error: 'node_not_configured' };

  try {
    const dir = sdkDir(sdkId);
    // 路径穿越防护：sdkDir 必须在 dependencies 目录内
    const normDir = path.resolve(dir);
    const normDeps = path.resolve(dependenciesDir());
    if (normDir !== normDeps && !normDir.startsWith(normDeps + path.sep)) {
      return { success: false, sdkId, error: 'Security error: SDK directory is outside dependencies directory' };
    }

    fs.mkdirSync(dir, { recursive: true });
    log(`开始安装 ${def.name} ...`);
    log(`Node.js: ${nodePath}`);

    // 容器 package.json（与 DependencyManager.createPackageJson 一致）
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `${sdkId}-container`, version: '1.0.0', private: true }, null, 2),
      'utf-8',
    );
    log('已创建 package.json');

    const specs = buildPackageSpecs(def, version);
    const maxRetries = 2;
    const timeoutMs = def.installTimeoutMs || DEFAULT_INSTALL_TIMEOUT_MS;
    let lastErr = '';
    let lastLogs = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) log(`\n🔄 重试 ${attempt}/${maxRetries} ...`);
      // 残缺的平台包目录（上次超时中断留下）npm 不会修复，必须先删掉才能重新完整解压；
      // 删掉后 lock 仍记着该包已装，不带 --force 的 npm install 直接跳过它，故清理过就同时加 --force
      const cleaned = removeBrokenPlatformPackage(sdkId, log);
      // 安全加固（上游 v0.4.6）：禁用包生命周期脚本（pre/post/install）——这是经典的
      // npm postinstall 供应链 RCE 面。已核对 Claude/Codex SDK 及其依赖树都不声明安装脚本，
      // 因此功能行为不变，只是把这条路堵死。
      const args = ['install', '--include=optional', '--ignore-scripts', '--prefix', dir];
      if (attempt > 0 || cleaned) args.push('--force'); // 重试用 --force 覆盖
      args.push(...specs);
      log(`npm ${args.join(' ')}`);

      const { code, out } = await runNpm(nodePath, args, { cwd: dir, onLine: log, timeoutMs });
      lastLogs = out;
      if (code === 0) {
        const verified = verifyInstall(sdkId);
        if (!verified.ok) {
          lastErr = `安装不完整：${verified.reason}`;
          log(`⚠️ ${lastErr}`);
          if (attempt === maxRetries) break;
          continue;
        }
        const installedVersion = readInstalledVersion(sdkId);
        log('✅ 安装完成');
        log(`已安装版本: ${installedVersion || '(未知)'}`);
        return {
          success: true,
          sdkId,
          installedVersion,
          requestedVersion: normalizeVersion(version) || def.version,
          logs: out,
        };
      }
      lastErr = code === -2 ? `npm install 超时（${Math.round(timeoutMs / 60000)} 分钟）` : `npm install 失败，退出码: ${code}`;
    }
    // 超时/残缺时清掉半截平台包，避免状态检查误判；提示可配置 npm 镜像加速
    removeBrokenPlatformPackage(sdkId, log);
    if (sdkId === 'codex-sdk') {
      lastErr += '。Codex CLI 二进制较大，网络较慢时可先执行 npm config set registry https://registry.npmmirror.com 再重试';
    }
    return { success: false, sdkId, error: lastErr, logs: lastLogs };
  } catch (e) {
    log(`ERROR: ${e && e.message}`);
    return { success: false, sdkId, error: e && e.message };
  }
}

/**
 * 删除残缺的 codex 平台包目录（有目录但解析不到 package.json / 可执行文件）。
 * @returns {boolean} 是否删除了目录
 */
function removeBrokenPlatformPackage(sdkId, log) {
  if (sdkId !== 'codex-sdk') return false;
  const verified = verifyCodexBinary(sdkId);
  if (verified.ok || !verified.platformDir) return false;
  // 路径穿越防护：只删 dependencies 目录内的路径
  const target = path.resolve(verified.platformDir);
  if (!target.startsWith(path.resolve(sdkDir(sdkId)) + path.sep)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    log(`已清理残缺的平台包: ${target}（${verified.reason}）`);
    return true;
  } catch (e) {
    log(`清理残缺平台包失败: ${e && e.message}`);
    return false;
  }
}

/** 卸载 SDK：删除 ~/.codemoss/dependencies/<sdkId>。返回 { success, sdkId, error? }。 */
function uninstall(sdkId) {
  if (!SDK_DEFS[sdkId]) return { success: false, sdkId, error: `Unknown SDK: ${sdkId}` };
  try {
    const dir = sdkDir(sdkId);
    if (!fs.existsSync(dir)) return { success: true, sdkId };
    fs.rmSync(dir, { recursive: true, force: true });
    return { success: true, sdkId };
  } catch (e) {
    return { success: false, sdkId, error: e && e.message };
  }
}

/**
 * 拉取可选版本列表（npm view <pkg> versions --json）。失败/离线回退到 fallbackVersions。
 * 返回 DependencyVersionResult：{ '<sdkId>': {sdkId, versions, fallbackVersions, source, latestVersion, error?} }。
 */
async function getVersions(p) {
  const { sdkId, nodePath } = p || {};
  const ids = sdkId && SDK_DEFS[sdkId] ? [sdkId] : Object.keys(SDK_DEFS);
  const result = {};
  for (const id of ids) {
    const def = SDK_DEFS[id];
    const info = {
      sdkId: id,
      versions: [],
      fallbackVersions: def.fallbackVersions.slice(),
      source: 'fallback',
      latestVersion: undefined,
    };
    if (nodePath) {
      const { code, out } = await runNpm(nodePath, ['view', def.npmPackage, 'versions', '--json'], { timeoutMs: 20000 });
      if (code === 0) {
        try {
          let arr = JSON.parse(out.trim());
          if (typeof arr === 'string') arr = [arr];
          if (Array.isArray(arr) && arr.length) {
            // npm 升序返回；倒序取最新若干，避免下拉框过长
            const desc = arr.slice().reverse();
            info.versions = desc.slice(0, 40);
            info.source = 'remote';
            const stable = arr.filter((v) => !/-/.test(v));
            const pool = stable.length ? stable : arr;
            info.latestVersion = pool[pool.length - 1];
          }
        } catch (e) { info.error = '解析版本列表失败'; }
      } else {
        info.error = code === -2 ? '获取版本超时' : '获取版本失败';
      }
    }
    if (info.source === 'fallback') {
      info.versions = def.fallbackVersions.slice();
      info.latestVersion = def.fallbackVersions[0];
    }
    result[id] = info;
  }
  return result;
}

/**
 * 检查已安装 SDK 是否有更新（npm view <pkg> version → 比对已安装版本）。
 * 返回 UpdateCheckResult：{ '<sdkId>': {sdkId, sdkName, hasUpdate, currentVersion, latestVersion, error?} }。
 */
async function checkUpdates(p) {
  const { sdkId, nodePath } = p || {};
  const ids = sdkId && SDK_DEFS[sdkId] ? [sdkId] : Object.keys(SDK_DEFS);
  const result = {};
  for (const id of ids) {
    const def = SDK_DEFS[id];
    const installedVersion = readInstalledVersion(id);
    const entry = {
      sdkId: id,
      sdkName: def.name,
      hasUpdate: false,
      currentVersion: installedVersion,
      latestVersion: undefined,
    };
    if (installedVersion && nodePath) {
      const { code, out } = await runNpm(nodePath, ['view', def.npmPackage, 'version'], { timeoutMs: 15000 });
      if (code === 0) {
        const latest = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
        if (latest) {
          entry.latestVersion = latest;
          entry.hasUpdate = compareVersions(latest, installedVersion) > 0;
        }
      } else {
        entry.error = code === -2 ? '检查更新超时' : '检查更新失败';
      }
    }
    result[id] = entry;
  }
  return result;
}

module.exports = {
  SDK_DEFS,
  dependenciesDir,
  sdkDir,
  getStatus,
  verifyInstall,
  install,
  uninstall,
  getVersions,
  checkUpdates,
};
