'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { setCustomModelPricing, getPricing, normalizeModels, PREF_KEY } = require('./model-pricing-service');

/** 造一个假的 hx：prefs 只用 hx.env.appData 定位 pref.json。 */
function fakeHx() {
  return { env: { appData: fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-pricing-')) } };
}

const P = (o) => ({ inputCostPer1M: null, outputCostPer1M: null, cacheWriteCostPer1M: null, cacheReadCostPer1M: null, ...o });

test('未知 provider 被静默丢弃（返回 false，不写盘）', () => {
  const hx = fakeHx();
  assert.strictEqual(setCustomModelPricing(hx, 'gemini', [{ id: 'a', pricing: { inputCostPer1M: 1 } }]), false);
  assert.strictEqual(getPricing(hx, 'claude', 'a'), null);
});

test('写入后能读回，四个维度齐全', () => {
  const hx = fakeHx();
  setCustomModelPricing(hx, 'claude', [{
    id: 'my-model',
    pricing: { inputCostPer1M: 3, outputCostPer1M: 15, cacheWriteCostPer1M: 3.75, cacheReadCostPer1M: 0.3 },
  }]);
  assert.deepStrictEqual(getPricing(hx, 'claude', 'my-model'),
    P({ inputCostPer1M: 3, outputCostPer1M: 15, cacheWriteCostPer1M: 3.75, cacheReadCostPer1M: 0.3 }));
});

test('是全量替换而不是合并——删掉的模型必须真的消失', () => {
  const hx = fakeHx();
  setCustomModelPricing(hx, 'claude', [
    { id: 'a', pricing: { inputCostPer1M: 1 } },
    { id: 'b', pricing: { inputCostPer1M: 2 } },
  ]);
  assert.ok(getPricing(hx, 'claude', 'b'));
  setCustomModelPricing(hx, 'claude', [{ id: 'a', pricing: { inputCostPer1M: 1 } }]);
  assert.strictEqual(getPricing(hx, 'claude', 'b'), null, 'b 应已被替换掉');
  assert.ok(getPricing(hx, 'claude', 'a'));
});

test('两个 provider 互不影响', () => {
  const hx = fakeHx();
  setCustomModelPricing(hx, 'claude', [{ id: 'c1', pricing: { inputCostPer1M: 1 } }]);
  setCustomModelPricing(hx, 'codex', [{ id: 'x1', pricing: { inputCostPer1M: 9 } }]);
  assert.ok(getPricing(hx, 'claude', 'c1'));
  assert.ok(getPricing(hx, 'codex', 'x1'));
  setCustomModelPricing(hx, 'codex', []);
  assert.ok(getPricing(hx, 'claude', 'c1'), 'claude 不该被 codex 的清空影响');
});

test('清空某 provider 时删掉整个节点而不是留空壳', () => {
  const hx = fakeHx();
  setCustomModelPricing(hx, 'claude', [{ id: 'a', pricing: { inputCostPer1M: 1 } }]);
  setCustomModelPricing(hx, 'claude', []);
  const prefFile = path.join(hx.env.appData, 'extensions', 'ccgui', 'pref.json');
  const saved = JSON.parse(fs.readFileSync(prefFile, 'utf-8'));
  assert.deepStrictEqual(saved[PREF_KEY], {});
});

test('normalizeModels 跳过：空 id / 无 pricing / 四维全空', () => {
  assert.deepStrictEqual(normalizeModels([
    { id: '  ', pricing: { inputCostPer1M: 1 } },
    { id: 'no-pricing' },
    { id: 'all-null', pricing: {} },
    { id: 'ok', pricing: { inputCostPer1M: 1 } },
  ]), { ok: P({ inputCostPer1M: 1 }) });
});

test('normalizeModels 把非法数值当作未设置（负数 / NaN / 字符串 / Infinity）', () => {
  const r = normalizeModels([{
    id: 'm',
    pricing: { inputCostPer1M: -1, outputCostPer1M: NaN, cacheWriteCostPer1M: '3', cacheReadCostPer1M: Infinity },
  }]);
  // 四个维度全部非法 → 整条跳过
  assert.deepStrictEqual(r, {});
});

test('normalizeModels 对 id 做 trim', () => {
  assert.deepStrictEqual(Object.keys(normalizeModels([{ id: '  m  ', pricing: { inputCostPer1M: 1 } }])), ['m']);
});

test('normalizeModels 容忍非数组入参', () => {
  assert.deepStrictEqual(normalizeModels(null), {});
  assert.deepStrictEqual(normalizeModels('x'), {});
});

test('getPricing 对未知模型/未知 provider 返回 null', () => {
  const hx = fakeHx();
  setCustomModelPricing(hx, 'claude', [{ id: 'a', pricing: { inputCostPer1M: 1 } }]);
  assert.strictEqual(getPricing(hx, 'claude', 'nope'), null);
  assert.strictEqual(getPricing(hx, 'gemini', 'a'), null);
  assert.strictEqual(getPricing(hx, 'claude', ''), null);
});
