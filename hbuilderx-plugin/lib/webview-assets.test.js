'use strict';

/**
 * 资源通道（宿主侧）单测：重点是名字校验与越界防护 —— 这条通道会按前端传来的名字读盘，
 * 必须只能读到 html/chunks/ 里的 .js / .json，不能被路径穿越或类型绕过。
 *
 * 跑法：node --test hbuilderx-plugin/lib/webview-assets.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { readWebviewAsset, CHUNKS_DIR } = require('./webview-assets');

test('拒绝路径穿越与目录分隔符', () => {
  for (const bad of ['../claude-chat.html', '..\\claude-chat.html', 'a/b.js', '/etc/passwd', '.hidden.js', '']) {
    const result = readWebviewAsset(bad);
    assert.ok(result.error, `应拒绝: ${JSON.stringify(bad)}`);
    assert.equal(result.content, undefined);
  }
});

test('拒绝非 js/json 后缀', () => {
  assert.ok(readWebviewAsset('claude-chat.html').error);
  assert.ok(readWebviewAsset('evil.sh').error);
  assert.ok(readWebviewAsset('noext').error);
});

test('拒绝非字符串与超长名字', () => {
  assert.ok(readWebviewAsset(undefined).error);
  assert.ok(readWebviewAsset(null).error);
  assert.ok(readWebviewAsset(123).error);
  assert.ok(readWebviewAsset('a'.repeat(200) + '.js').error);
});

test('不存在的资源返回 error 而不是抛异常', () => {
  const result = readWebviewAsset('definitely-missing-asset.js');
  assert.equal(result.error, 'asset not found');
});

test('chunks 目录里的资源可以读到（需先构建 webview）', (t) => {
  const bundle = path.join(CHUNKS_DIR, 'mermaid-bundle.js');
  if (!fs.existsSync(bundle)) {
    t.skip('未构建 html/chunks/mermaid-bundle.js：先执行 cd webview && npm run build');
    return;
  }
  const result = readWebviewAsset('mermaid-bundle.js');
  assert.equal(result.error, undefined);
  assert.ok(result.content.length > 1000);

  const locale = path.join(CHUNKS_DIR, 'locale-ja.json');
  if (fs.existsSync(locale)) {
    const json = readWebviewAsset('locale-ja.json');
    assert.equal(json.error, undefined);
    assert.doesNotThrow(() => JSON.parse(json.content));
  }
});
