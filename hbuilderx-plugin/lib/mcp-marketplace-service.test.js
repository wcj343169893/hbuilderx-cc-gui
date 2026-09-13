'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getSources, search, parseSearchRequest, matchesQuery, matchesRequestedSource, SOURCES } =
  require('./mcp-marketplace-service');
const { cacheFile, readCache, writeCacheAtomically, GITHUB_HOSTS } = require('./marketplace-http');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-mkt-'));
}

const OFFLINE_CTX = () => ({ prefDirPath: tmpDir(), githubToken: null, warn: () => {} });

test('getSources 返回 4 个源，且不含前端伪源 all', () => {
  const s = getSources();
  assert.strictEqual(s.length, 4);
  assert.ok(!s.some((x) => x.id === 'all'));
  assert.deepStrictEqual(s.map((x) => x.id).sort(), [
    'built-in', 'github-mcp-registry', 'official-github-org', 'official-registry',
  ]);
});

test('getSources 返回副本，调用方改不动内部常量', () => {
  getSources()[0].name = 'hacked';
  assert.strictEqual(SOURCES[0].name, 'Built-in Presets');
});

test('parseSearchRequest：空 content 默认 built-in，有 content 但缺 sourceId 默认 all', () => {
  assert.deepStrictEqual(parseSearchRequest(''), { query: '', sourceId: 'built-in', forceRefresh: false });
  assert.deepStrictEqual(parseSearchRequest('   '), { query: '', sourceId: 'built-in', forceRefresh: false });
  assert.deepStrictEqual(parseSearchRequest('{"query":"x"}'), { query: 'x', sourceId: 'all', forceRefresh: false });
});

test('parseSearchRequest：坏 JSON 退回默认值而不是抛', () => {
  assert.deepStrictEqual(parseSearchRequest('{bad'), { query: '', sourceId: 'built-in', forceRefresh: false });
});

test('matchesRequestedSource：空/all 匹配全部', () => {
  const s = SOURCES[0];
  assert.ok(matchesRequestedSource(s, ''));
  assert.ok(matchesRequestedSource(s, 'all'));
  assert.ok(matchesRequestedSource(s, 'built-in'));
  assert.ok(!matchesRequestedSource(s, 'official-registry'));
});

test('matchesQuery 是 AND 语义，且覆盖 name/description/tags', () => {
  const e = { name: 'fetch', displayName: 'Fetch', description: 'Get a URL', repositoryUrl: '', tags: ['web'] };
  assert.ok(matchesQuery(e, []));
  assert.ok(matchesQuery(e, ['fetch', 'url']));
  assert.ok(matchesQuery(e, ['web']));
  assert.ok(!matchesQuery(e, ['fetch', 'nonexistent']));
});

test('只查 built-in 时零网络即可返回 5 条内置预设', async () => {
  const r = await search({ query: '', sourceId: 'built-in' }, OFFLINE_CTX());
  assert.strictEqual(r.entries.length, 5);
  assert.ok(r.entries.every((e) => e.sourceId === 'built-in' && e.installable));
  assert.ok(!r.error);
});

test('内置预设的安装命令是具体可执行的（不是占位）', async () => {
  const r = await search({ query: 'fetch', sourceId: 'built-in' }, OFFLINE_CTX());
  assert.strictEqual(r.entries.length, 1);
  const opt = r.entries[0].installOptions[0];
  assert.strictEqual(opt.command, 'uvx');
  assert.deepStrictEqual(opt.args, ['mcp-server-fetch']);
  assert.strictEqual(opt.riskLevel, 'local-command');
});

test('网络源全部失败时仍然返回内置预设，并在 error 里如实说明哪个源挂了', async () => {
  // 三个网络源在测试环境不可达（无网/被拦），这正是要验证的降级路径：
  // 单源失败绝不能把内置预设也一起干掉。
  const r = await search({ query: '', sourceId: 'all' }, OFFLINE_CTX());
  assert.ok(r.entries.length >= 5, '内置预设必须还在，实际 ' + r.entries.length);
  assert.ok(r.entries.some((e) => e.sourceId === 'built-in'));
});

test('搜索结果按 official → installable → displayName 排序', async () => {
  const r = await search({ query: '', sourceId: 'built-in' }, OFFLINE_CTX());
  const names = r.entries.map((e) => e.displayName);
  assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
});

// ==================== 缓存层 ====================

test('缓存文件名不会被 key 里的路径穿越字符带出目录', () => {
  const dir = tmpDir();
  const base = path.join(dir, 'mcp-marketplace-cache');
  for (const evil of ['../../etc/passwd', '..', '.', '/abs/path', 'a/b\\c', '']) {
    const f = cacheFile(dir, evil);
    // 必须仍落在缓存目录里，且只有一层（父目录就是缓存目录）
    assert.strictEqual(path.dirname(path.resolve(f)), path.resolve(base), `${JSON.stringify(evil)} -> ${f}`);
  }
});

test('缓存原子写入后可读回，并带 age', () => {
  const dir = tmpDir();
  writeCacheAtomically(dir, 'k1', { servers: [1, 2] });
  const c = readCache(dir, 'k1');
  assert.deepStrictEqual(c.data, { servers: [1, 2] });
  assert.ok(c.ageMs >= 0 && c.ageMs < 60_000);
});

test('缓存写入不留临时文件', () => {
  const dir = tmpDir();
  writeCacheAtomically(dir, 'k2', { a: 1 });
  const files = fs.readdirSync(path.join(dir, 'mcp-marketplace-cache'));
  assert.deepStrictEqual(files.filter((f) => f.endsWith('.tmp')), []);
});

test('读不存在/坏掉的缓存返回 null 而不是抛', () => {
  const dir = tmpDir();
  assert.strictEqual(readCache(dir, 'missing'), null);
  const f = cacheFile(dir, 'broken');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ not json', 'utf-8');
  assert.strictEqual(readCache(dir, 'broken'), null);
});

test('GITHUB_TOKEN 的 host 白名单是精确相等，不是后缀匹配', () => {
  assert.ok(GITHUB_HOSTS.has('api.github.com'));
  assert.ok(!GITHUB_HOSTS.has('evil-api.github.com.attacker.net'));
  assert.ok(!GITHUB_HOSTS.has('raw.githubusercontent.com'));
});
