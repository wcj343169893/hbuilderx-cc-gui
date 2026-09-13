'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCopilotConfig, inferType, collectHeaders } = require('./mcp-import-service');

test('缺少 servers 根对象时报错', () => {
  assert.throws(() => parseCopilotConfig('{"mcpServers":{}}', false), /servers/);
  assert.throws(() => parseCopilotConfig('{}', false), /servers/);
});

test('非法 JSON 报错而不是抛 SyntaxError', () => {
  assert.throws(() => parseCopilotConfig('not json', false), /不是合法 JSON/);
});

test('一个 server 都没有时报错', () => {
  assert.throws(() => parseCopilotConfig('{"servers":{}}', false), /No servers found/);
});

test('stdio server 透传 command/args/env 并推断 type', () => {
  const r = parseCopilotConfig(
    JSON.stringify({ servers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'], env: { A: '1' } } } }),
    false
  );
  assert.strictEqual(r.servers.length, 1);
  const s = r.servers[0];
  assert.strictEqual(s.id, 'fetch');
  assert.strictEqual(s.name, 'fetch');
  assert.deepStrictEqual(s.server.args, ['mcp-server-fetch']);
  assert.strictEqual(s.server.type, 'stdio');
  assert.deepStrictEqual(s.apps, { claude: true, codex: false, gemini: false });
});

test('isCodexMode 决定 apps 标记', () => {
  const r = parseCopilotConfig(JSON.stringify({ servers: { a: { command: 'x' } } }), true);
  assert.deepStrictEqual(r.servers[0].apps, { claude: false, codex: true, gemini: false });
});

test('type 推断：/sse → sse，其他 url → http，都没有 → stdio', () => {
  assert.strictEqual(inferType({ url: 'https://x/sse' }), 'sse');
  assert.strictEqual(inferType({ url: 'https://x/mcp' }), 'http');
  assert.strictEqual(inferType({}), 'stdio');
  // command 优先于 url
  assert.strictEqual(inferType({ command: 'npx', url: 'https://x/sse' }), 'stdio');
});

test('源里已有 type 时不覆盖', () => {
  const r = parseCopilotConfig(
    JSON.stringify({ servers: { a: { url: 'https://x/sse', type: 'http' } } }),
    false
  );
  assert.strictEqual(r.servers[0].server.type, 'http');
});

test('headers 合并：requestInit 打底、顶层覆盖、丢弃 null', () => {
  const h = collectHeaders({
    requestInit: { headers: { A: '1', B: '2' } },
    headers: { B: '22', C: null },
  });
  assert.deepStrictEqual(h, { A: '1', B: '22' });
});

test('完全没有 header 时不产出空对象', () => {
  assert.strictEqual(collectHeaders({}), null);
  const r = parseCopilotConfig(JSON.stringify({ servers: { a: { command: 'x' } } }), false);
  assert.ok(!('headers' in r.servers[0].server));
});

test('null 字段不被透传（避免把 null 写进最终配置）', () => {
  const r = parseCopilotConfig(
    JSON.stringify({ servers: { a: { command: 'x', args: null, env: null } } }),
    false
  );
  assert.ok(!('args' in r.servers[0].server));
  assert.ok(!('env' in r.servers[0].server));
});

test('坏条目被跳过而不是让整次导入失败', () => {
  const r = parseCopilotConfig(
    JSON.stringify({ servers: { bad: 'oops', good: { command: 'x' } } }),
    false
  );
  assert.deepStrictEqual(r.servers.map((s) => s.id), ['good']);
});

test('name 字段优先于 key 作为显示名', () => {
  const r = parseCopilotConfig(
    JSON.stringify({ servers: { a: { command: 'x', name: 'Nice Name' } } }),
    false
  );
  assert.strictEqual(r.servers[0].id, 'a');
  assert.strictEqual(r.servers[0].name, 'Nice Name');
});

test('Codex 模式不产出 type / x-metadata（Codex 的 config.toml 不认识这两个键）', () => {
  // 回归点：mcp-service.serializeCodexServers 会把 spec 的每个 key 原样写成一行 TOML，
  // 所以多余的键会直接污染用户的 ~/.codex/config.toml。
  const cfg = JSON.stringify({
    servers: { a: { command: 'npx', args: ['x'], type: 'stdio', 'x-metadata': { k: 1 } } },
  });
  const codex = parseCopilotConfig(cfg, true).servers[0].server;
  assert.ok(!('type' in codex), 'codex 模式不应有 type');
  assert.ok(!('x-metadata' in codex), 'codex 模式不应有 x-metadata');
  assert.strictEqual(codex.command, 'npx');
  assert.deepStrictEqual(codex.args, ['x']);

  // Claude 侧不受影响，两者都要在
  const claude = parseCopilotConfig(cfg, false).servers[0].server;
  assert.strictEqual(claude.type, 'stdio');
  assert.deepStrictEqual(claude['x-metadata'], { k: 1 });
});
