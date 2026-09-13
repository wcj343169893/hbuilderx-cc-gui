'use strict';

/**
 * MCP Registry 条目 → 前端 entry 的映射（B2 / 上游 v0.4.7）。
 *
 * 对应上游 `mcp/marketplace/McpRegistryEntryMapper.java`。这里的两条安全规则是重点，
 * 前端直接拿 riskLevel 决定要不要显示醒目警告条：
 *
 * 1. **official 徽章只认 canonical registry 源的外层 `_meta`，且必须带结构化 metadata**。
 *    仅有 key 存在不算——否则任何人往自己的 registry 里塞一个空 `_meta` 就能伪造官方徽章。
 * 2. **危险 runtime 参数降级**：runtimeArguments 里出现 --privileged / -v / --network 这类
 *    能打穿容器隔离的参数时，riskLevel 一律降到 unverified-command。
 */

// 已知的、可信的启动器。不在这张表里的 command 一律 unverified-command。
const KNOWN_RUNNERS = new Set([
  'npx', 'uvx', 'uv', 'pnpm', 'pnpx', 'bunx', 'node', 'deno',
  'python', 'python3', 'docker', 'podman',
]);

// 能打穿隔离 / 挂载宿主资源的参数
const DANGEROUS_RUNNER_FLAGS = new Set([
  '--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns',
  '--network', '--net', '-v', '--volume', '--mount',
]);

// registryType → 默认启动器与默认参数前缀
const REGISTRY_TYPE_DEFAULTS = {
  docker: { runner: 'docker', args: ['run', '-i', '--rm'], label: 'Docker image', risk: 'container-command' },
  npm: { runner: 'npx', args: ['-y'], label: 'NPX package', risk: 'local-command' },
  pypi: { runner: 'uvx', args: [], label: 'UVX package', risk: 'local-command' },
};

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** registry v0.1 信封 `{ server: {...}, _meta: {...} }`；没有 server 时回落到信封本身（兼容旧的扁平格式）。 */
function unwrapEnvelope(raw) {
  const obj = asObject(raw);
  if (!obj) return { server: null, meta: null };
  const server = asObject(obj.server);
  return { server: server || obj, meta: asObject(obj._meta) };
}

/**
 * official 徽章判定。
 * @param {object|null} meta 信封外层 _meta
 * @param {boolean} isCanonicalRegistry 该源是否是官方 canonical registry
 */
function isOfficial(meta, isCanonicalRegistry) {
  if (!isCanonicalRegistry || !meta) return false;
  // 必须有结构化 metadata，光有 key 不算
  for (const v of Object.values(meta)) {
    if (asObject(v)) return true;
  }
  return false;
}

/** runtimeArguments 里是否含危险参数（只看参数本身，`--device=x` 这种带值写法也要认出来）。 */
function hasDangerousFlag(args) {
  for (const a of asArray(args)) {
    if (typeof a !== 'string') continue;
    const head = a.split('=')[0];
    if (DANGEROUS_RUNNER_FLAGS.has(head)) return true;
  }
  return false;
}

/**
 * 把一个 package 描述转成安装选项。
 * @returns {object|null} 无法确定启动器时返回 null（调用方跳过该 package）
 */
function buildInstallOption(pkg) {
  const p = asObject(pkg);
  if (!p) return null;
  const registryType = typeof p.registryType === 'string' ? p.registryType.toLowerCase() : '';
  const runtimeHint = typeof p.runtimeHint === 'string' ? p.runtimeHint.trim() : '';
  const runtimeArgs = asArray(p.runtimeArguments);
  const packageArgs = asArray(p.packageArguments);
  const name = typeof p.name === 'string' ? p.name : (typeof p.identifier === 'string' ? p.identifier : '');

  const preset = REGISTRY_TYPE_DEFAULTS[registryType];
  let command;
  let prefix;
  let label;
  let riskLevel;

  if (preset) {
    // runtimeHint 只有在白名单内才允许覆盖预设启动器
    command = KNOWN_RUNNERS.has(runtimeHint) ? runtimeHint : preset.runner;
    prefix = runtimeArgs.length ? runtimeArgs : preset.args;
    label = preset.label;
    riskLevel = preset.risk;
  } else if (runtimeHint) {
    command = runtimeHint;
    prefix = runtimeArgs;
    label = `${runtimeHint} package`;
    riskLevel = KNOWN_RUNNERS.has(runtimeHint) ? 'local-command' : 'unverified-command';
  } else {
    return null;
  }

  if (hasDangerousFlag(runtimeArgs)) riskLevel = 'unverified-command';

  const args = [...prefix];
  if (name) args.push(name);
  args.push(...packageArgs);

  const env = {};
  for (const v of asArray(p.environmentVariables)) {
    const ev = asObject(v);
    if (!ev || typeof ev.name !== 'string' || !ev.name) continue;
    // `{placeholder}` 原样保留，由用户在 UI 里填
    env[ev.name] = typeof ev.value === 'string' ? ev.value : (typeof ev.default === 'string' ? ev.default : '');
  }

  return {
    label,
    command,
    args,
    env,
    riskLevel,
    transport: normalizeTransport(p.transport),
  };
}

/** transport 归一：对象形式取 .type，字符串直接用，都没有则 stdio。 */
function normalizeTransport(transport) {
  const t = asObject(transport);
  const raw = t ? t.type : transport;
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (s === 'sse' || s === 'http' || s === 'streamable-http' || s === 'stdio') return s;
  return 'stdio';
}

/**
 * 把 registry 返回的一条记录映射成前端 entry。
 * @param {any} raw registry 条目（可能是 v0.1 信封）
 * @param {{ sourceId: string, sourceName: string, isCanonicalRegistry?: boolean }} source
 * @returns {object|null} 无 name 时返回 null（没有稳定标识的条目没法去重，直接丢）
 */
function mapEntry(raw, source) {
  const { server, meta } = unwrapEnvelope(raw);
  if (!server) return null;
  const name = typeof server.name === 'string' ? server.name.trim() : '';
  if (!name) return null;

  const installOptions = [];
  for (const pkg of asArray(server.packages)) {
    const opt = buildInstallOption(pkg);
    if (opt) installOptions.push(opt);
  }

  // 服务端级 variables 里的占位符，合并进每个安装选项的 env 打底
  const serverEnv = {};
  for (const v of asArray(server.variables)) {
    const ev = asObject(v);
    if (ev && typeof ev.name === 'string' && ev.name) serverEnv[ev.name] = '';
  }
  if (Object.keys(serverEnv).length) {
    for (const opt of installOptions) opt.env = { ...serverEnv, ...opt.env };
  }

  return {
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    name,
    displayName: typeof server.displayName === 'string' && server.displayName ? server.displayName : name,
    description: typeof server.description === 'string' ? server.description : '',
    repositoryUrl: readRepositoryUrl(server),
    version: typeof server.version === 'string' ? server.version : '',
    tags: asArray(server.tags).filter((t) => typeof t === 'string'),
    official: isOfficial(meta, !!source.isCanonicalRegistry),
    installable: installOptions.length > 0,
    installOptions,
  };
}

function readRepositoryUrl(server) {
  const repo = asObject(server.repository);
  if (repo && typeof repo.url === 'string') return repo.url;
  if (typeof server.repository === 'string') return server.repository;
  if (typeof server.repositoryUrl === 'string') return server.repositoryUrl;
  return '';
}

module.exports = {
  mapEntry,
  buildInstallOption,
  isOfficial,
  hasDangerousFlag,
  normalizeTransport,
  unwrapEnvelope,
  KNOWN_RUNNERS,
  DANGEROUS_RUNNER_FLAGS,
};
