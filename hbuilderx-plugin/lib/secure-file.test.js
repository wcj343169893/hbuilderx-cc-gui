'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJsonSecure, ensureSecureDir } = require('./secure-file');

const isPosix = process.platform !== 'win32';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-secure-'));
}

test('writeJsonSecure 写出可解析的 JSON', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  writeJsonSecure(file, { claude: { providers: { a: 1 } } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
    claude: { providers: { a: 1 } },
  });
});

test('writeJsonSecure 把新建文件收紧到 0600', { skip: !isPosix }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  writeJsonSecure(file, { k: 'v' });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeJsonSecure 把已存在的宽权限文件也收紧到 0600', { skip: !isPosix }, () => {
  // 关键回归：fs.writeFileSync 的 mode 对已存在的文件不生效，所以必须写完再 chmod 一次。
  // 老版本写出的 0644 配置在升级后第一次回写就该被收紧。
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}', { encoding: 'utf-8', mode: 0o644 });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o644);
  writeJsonSecure(file, { k: 'v' });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeJsonSecure 会创建缺失的父目录并收紧到 0700', { skip: !isPosix }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'deep', 'config.json');
  writeJsonSecure(file, { k: 'v' });
  assert.ok(fs.existsSync(file));
  assert.strictEqual(fs.statSync(path.join(dir, 'nested', 'deep')).mode & 0o777, 0o700);
});

test('ensureSecureDir 对已存在的宽权限目录也收紧', { skip: !isPosix }, () => {
  const dir = tmpDir();
  const sub = path.join(dir, 'open');
  fs.mkdirSync(sub, { mode: 0o755 });
  fs.chmodSync(sub, 0o755);
  ensureSecureDir(sub);
  assert.strictEqual(fs.statSync(sub).mode & 0o777, 0o700);
});

test('pretty:false 写紧凑 JSON', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'c.json');
  writeJsonSecure(file, { a: 1, b: 2 }, { pretty: false });
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), '{"a":1,"b":2}');
});
