'use strict';

/**
 * 门禁自身的测试。
 *
 * 为什么值得测：这个脚本是 B1~B11 每一批的验收依据。它一旦判错，代价不是「这个脚本有 bug」，
 * 而是「连续十个批次都在一个说谎的门禁下验收」——B0b 的「缺口清零」就是这么来的
 * （正则看不见冒号形式，于是报 0 缺口，实际欠着 46 个）。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  judge,
  EVENT_RE,
  CALLBACK_RES,
  KNOWN_GAPS,
  KNOWN_INBOUND_GAPS,
  INTENTIONALLY_UNHANDLED,
} = require('./check-message-contracts');

function matchAll(src, re, group) {
  return [...src.matchAll(new RegExp(re.source, re.flags))].map((m) => m[group]);
}

// ==================== 正则：出站事件名提取 ====================

test('事件正则识别纯事件名形式', () => {
  assert.deepStrictEqual(matchAll(`sendToJava('get_mode')`, EVENT_RE, 2), ['get_mode']);
  assert.deepStrictEqual(matchAll(`sendBridgeEvent("open_diff")`, EVENT_RE, 2), ['open_diff']);
});

test('事件正则识别冒号形式（旧正则的盲区，B0d 的根因）', () => {
  assert.deepStrictEqual(matchAll(`sendToJava('get_streaming_enabled:')`, EVENT_RE, 2), [
    'get_streaming_enabled',
  ]);
  assert.deepStrictEqual(
    matchAll('sendToJava(`set_ui_font_config:${JSON.stringify(cfg)}`)', EVENT_RE, 2),
    ['set_ui_font_config']
  );
  assert.deepStrictEqual(matchAll(`sendToJava('save_json:' + payload)`, EVENT_RE, 2), ['save_json']);
});

test('事件正则容忍 ( 之后的空白与换行', () => {
  assert.deepStrictEqual(matchAll("sendToJava(\n  'set_mode'\n)", EVENT_RE, 2), ['set_mode']);
});

test('事件正则不匹配变量参数（无法静态解析的调用不该被当成事件名）', () => {
  assert.deepStrictEqual(matchAll('sendToJava(eventName)', EVENT_RE, 2), []);
});

test('事件正则要求开闭引号同种', () => {
  assert.deepStrictEqual(matchAll("sendToJava('get_mode\")", EVENT_RE, 2), []);
});

// ==================== 正则：入站回调注册提取 ====================

test('回调正则识别 window.x = 与 (window as any).x = 两种注册写法', () => {
  assert.deepStrictEqual(matchAll('window.onStreamEnd = handler;', CALLBACK_RES[0], 1), [
    'onStreamEnd',
  ]);
  assert.deepStrictEqual(
    matchAll('(window as unknown as W).onUsageUpdate = handler;', CALLBACK_RES[1], 1),
    ['onUsageUpdate']
  );
});

test('回调正则不把比较当成赋值', () => {
  assert.deepStrictEqual(matchAll('if (window.foo === bar) {}', CALLBACK_RES[0], 1), []);
  assert.deepStrictEqual(matchAll('if (window.foo == bar) {}', CALLBACK_RES[0], 1), []);
});

// ==================== 判定逻辑 ====================

const EMPTY = new Set();

test('已实现的事件不算缺口', () => {
  const r = judge(['a', 'b'], new Set(['a', 'b']), EMPTY, new Map());
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.newGaps, []);
});

test('未实现且不在任何清单里 → 新增缺口（门禁要拦的就是这个）', () => {
  const r = judge(['a', 'newly_missed'], new Set(['a']), EMPTY, new Map());
  assert.deepStrictEqual(r.newGaps, ['newly_missed']);
});

test('白名单里的事件不算缺口', () => {
  const r = judge(['heartbeat'], EMPTY, new Set(['heartbeat']), new Map());
  assert.deepStrictEqual(r.newGaps, []);
  assert.deepStrictEqual(r.outstanding, []);
});

test('欠账清单里的事件记为 outstanding 而非新增缺口', () => {
  const r = judge(['known'], EMPTY, EMPTY, new Map([['known', 'B5']]));
  assert.deepStrictEqual(r.outstanding, ['known']);
  assert.deepStrictEqual(r.newGaps, []);
});

test('欠账被实现后变成 staleBacklog（强制清单变短）', () => {
  const r = judge(['known'], new Set(['known']), EMPTY, new Map([['known', 'B5']]));
  assert.deepStrictEqual(r.staleBacklog, ['known']);
  assert.deepStrictEqual(r.outstanding, []);
});

test('欠账对应的触发点被删掉后也算 staleBacklog', () => {
  // 前端不再发送该事件 → produced 里没有它 → 清单条目过期
  const r = judge([], EMPTY, EMPTY, new Map([['gone', 'B5']]));
  assert.deepStrictEqual(r.staleBacklog, ['gone']);
});

test('missing 按字典序排序，输出稳定（便于 diff 审阅）', () => {
  const r = judge(['z_evt', 'a_evt', 'm_evt'], EMPTY, EMPTY, new Map());
  assert.deepStrictEqual(r.missing, ['a_evt', 'm_evt', 'z_evt']);
});

// ==================== 清单自身的卫生 ====================

test('两张欠账清单与白名单互不重叠（同一事件只能有一个归属）', () => {
  for (const e of KNOWN_GAPS.keys()) {
    assert.ok(!INTENTIONALLY_UNHANDLED.has(e), `${e} 同时在 KNOWN_GAPS 和白名单里`);
  }
  for (const c of KNOWN_INBOUND_GAPS.keys()) {
    assert.ok(!KNOWN_GAPS.has(c), `${c} 同时在出站与入站欠账清单里`);
  }
});

test('每条欠账都写了归属说明（没有说明的欠账等于没人认领）', () => {
  for (const [e, note] of KNOWN_GAPS) {
    assert.ok(typeof note === 'string' && note.trim().length > 0, `${e} 缺少说明`);
  }
  for (const [c, note] of KNOWN_INBOUND_GAPS) {
    assert.ok(typeof note === 'string' && note.trim().length > 0, `${c} 缺少说明`);
  }
});

// ==================== 注释行过滤 ====================

test('整行注释里的调用不算真实调用（否则「解释为什么删掉它」会被当成没删）', () => {
  const { stripCommentLines } = require('./check-message-contracts');
  const src = [
    "      // 注意：这里原先还会 callJs('taskHealthUpdate', ...)",
    "       * 见 sendToJava('get_mode')",
    "      this.bridge.callJs('onTaskEvent', json);",
  ].join('\n');
  const stripped = stripCommentLines(src);
  assert.ok(!stripped.includes('taskHealthUpdate'));
  assert.ok(!stripped.includes('get_mode'));
  assert.ok(stripped.includes("callJs('onTaskEvent'"));
});

test('注释行过滤不影响正常代码行', () => {
  const { stripCommentLines } = require('./check-message-contracts');
  const src = "const a = 1;\nsendToJava('x');";
  assert.strictEqual(stripCommentLines(src), src);
});
