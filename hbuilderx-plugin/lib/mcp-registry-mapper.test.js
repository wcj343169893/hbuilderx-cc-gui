'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  mapEntry, buildInstallOption, isOfficial, hasDangerousFlag, normalizeTransport, unwrapEnvelope,
} = require('./mcp-registry-mapper');

const SRC = { sourceId: 'official-registry', sourceName: 'Official', isCanonicalRegistry: true };

// ==================== official 徽章（安全规则 1）====================

test('official 徽章：只有 canonical registry 才可能为 true', () => {
  assert.strictEqual(isOfficial({ 'io.modelcontextprotocol.registry/official': { x: 1 } }, false), false);
  assert.strictEqual(isOfficial({ 'io.modelcontextprotocol.registry/official': { x: 1 } }, true), true);
});

test('official 徽章：光有 key、值不是对象不算（防伪造）', () => {
  assert.strictEqual(isOfficial({ 'io.modelcontextprotocol.registry/official': true }, true), false);
  assert.strictEqual(isOfficial({ someKey: 'string' }, true), false);
  assert.strictEqual(isOfficial({}, true), false);
  assert.strictEqual(isOfficial(null, true), false);
});

// ==================== 危险参数降级（安全规则 2）====================

test('危险参数识别：裸参数与 --flag=value 两种写法都要认出来', () => {
  assert.strictEqual(hasDangerousFlag(['run', '-i']), false);
  assert.strictEqual(hasDangerousFlag(['--privileged']), true);
  assert.strictEqual(hasDangerousFlag(['-v', '/:/host']), true);
  assert.strictEqual(hasDangerousFlag(['--device=/dev/sda']), true);
  assert.strictEqual(hasDangerousFlag(['--network=host']), true);
});

test('docker 条目带危险参数时 riskLevel 从 container-command 降到 unverified-command', () => {
  const safe = buildInstallOption({ registryType: 'docker', name: 'img', runtimeArguments: ['run', '-i', '--rm'] });
  assert.strictEqual(safe.riskLevel, 'container-command');
  const risky = buildInstallOption({ registryType: 'docker', name: 'img', runtimeArguments: ['run', '--privileged'] });
  assert.strictEqual(risky.riskLevel, 'unverified-command');
});

// ==================== 启动器选择 ====================

test('npm 默认用 npx -y，pypi 默认 uvx，docker 默认 docker run -i --rm', () => {
  assert.deepStrictEqual(
    buildInstallOption({ registryType: 'npm', name: '@scope/pkg' }),
    { label: 'NPX package', command: 'npx', args: ['-y', '@scope/pkg'], env: {}, riskLevel: 'local-command', transport: 'stdio' }
  );
  assert.strictEqual(buildInstallOption({ registryType: 'pypi', name: 'p' }).command, 'uvx');
  assert.deepStrictEqual(
    buildInstallOption({ registryType: 'docker', name: 'img' }).args,
    ['run', '-i', '--rm', 'img']
  );
});

test('runtimeHint 只有在白名单内才允许覆盖预设启动器', () => {
  assert.strictEqual(buildInstallOption({ registryType: 'npm', name: 'p', runtimeHint: 'bunx' }).command, 'bunx');
  // 不在白名单 → 忽略 hint，回到预设的 npx
  assert.strictEqual(buildInstallOption({ registryType: 'npm', name: 'p', runtimeHint: 'evil-runner' }).command, 'npx');
});

test('未知 registryType + 白名单外的 runtimeHint → unverified-command', () => {
  const o = buildInstallOption({ registryType: 'weird', name: 'p', runtimeHint: 'my-runner' });
  assert.strictEqual(o.command, 'my-runner');
  assert.strictEqual(o.riskLevel, 'unverified-command');
});

test('未知 registryType 且无 runtimeHint → 返回 null（该 package 被跳过）', () => {
  assert.strictEqual(buildInstallOption({ registryType: 'weird', name: 'p' }), null);
  assert.strictEqual(buildInstallOption(null), null);
});

test('args 顺序 = 前缀 + 包名 + packageArguments', () => {
  const o = buildInstallOption({
    registryType: 'npm', name: 'pkg', runtimeArguments: ['-y', '--silent'], packageArguments: ['--port', '3000'],
  });
  assert.deepStrictEqual(o.args, ['-y', '--silent', 'pkg', '--port', '3000']);
});

// ==================== transport 与信封 ====================

test('transport 归一', () => {
  assert.strictEqual(normalizeTransport({ type: 'SSE' }), 'sse');
  assert.strictEqual(normalizeTransport('http'), 'http');
  assert.strictEqual(normalizeTransport(undefined), 'stdio');
  assert.strictEqual(normalizeTransport('garbage'), 'stdio');
});

test('v0.1 信封解包；扁平旧格式回落到信封本身', () => {
  assert.deepStrictEqual(unwrapEnvelope({ server: { name: 'a' }, _meta: { m: {} } }),
    { server: { name: 'a' }, meta: { m: {} } });
  assert.deepStrictEqual(unwrapEnvelope({ name: 'a' }).server, { name: 'a' });
});

// ==================== 整条映射 ====================

test('无 name 的条目返回 null（没有稳定标识没法去重）', () => {
  assert.strictEqual(mapEntry({ server: { description: 'x' } }, SRC), null);
  assert.strictEqual(mapEntry(null, SRC), null);
});

test('没有可用 package 时 installable=false', () => {
  const e = mapEntry({ server: { name: 'a', packages: [] } }, SRC);
  assert.strictEqual(e.installable, false);
  assert.deepStrictEqual(e.installOptions, []);
});

test('服务端级 variables 作为 env 打底，package 自己的同名值优先', () => {
  const e = mapEntry({
    server: {
      name: 'a',
      variables: [{ name: 'TOKEN' }, { name: 'ONLY_SERVER' }],
      packages: [{ registryType: 'npm', name: 'p', environmentVariables: [{ name: 'TOKEN', value: '{your-token}' }] }],
    },
  }, SRC);
  assert.deepStrictEqual(e.installOptions[0].env, { ONLY_SERVER: '', TOKEN: '{your-token}' });
});

test('displayName 缺失时回落到 name；repositoryUrl 支持对象与字符串两种写法', () => {
  const a = mapEntry({ server: { name: 'n', repository: { url: 'u1' } } }, SRC);
  assert.strictEqual(a.displayName, 'n');
  assert.strictEqual(a.repositoryUrl, 'u1');
  const b = mapEntry({ server: { name: 'n', repository: 'u2' } }, SRC);
  assert.strictEqual(b.repositoryUrl, 'u2');
});
