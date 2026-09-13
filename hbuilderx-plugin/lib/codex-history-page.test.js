'use strict';

/**
 * Codex 历史分页（B3）。用真实的 rollout JSONL 夹具跑通 loadSessionPage，
 * 因为分页最容易错的地方是「轮次边界」——工具结果在转换后同样是 type:'user'，
 * 按 type 数轮次会把一轮里的每次工具往返都算成一轮，边界整体错位。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// getCodexHome 是调用时读 env 的，所以可以在测试里指到临时目录
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-codex-'));
process.env.CODEX_HOME = CODEX_HOME;

const svc = require('./codex-history-service');

/** 造一个 N 轮的 rollout：每轮 = 用户提问 + 一次工具调用 + 工具结果 + 助手回复。 */
function writeRollout(sessionId, turns) {
  const dir = path.join(CODEX_HOME, 'sessions', '2026', '09', '13');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-' + sessionId, cwd: '/proj' } }),
  ];
  for (let i = 0; i < turns; i++) {
    const ts = `2026-09-13T00:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: `问题 ${i}` } }));
    lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: '{"command":"ls"}' } }));
    lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: `c${i}`, output: 'ok' } }));
    lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `回答 ${i}` }] } }));
  }
  fs.writeFileSync(path.join(dir, `rollout-2026-09-13T00-00-00-${sessionId}.jsonl`), lines.join('\n'), 'utf-8');
}

// ==================== 轮次边界 ====================

test('工具结果不算新一轮（转换后同样是 type:user，按 type 数会整体错位）', () => {
  const msgs = [
    { type: 'user', content: '问题' },
    { type: 'user', content: '[tool_result]' },
    { type: 'assistant', content: '回答' },
    { type: 'user', content: '追问' },
  ];
  assert.deepStrictEqual(svc.turnStartIndexes(msgs), [0, 3]);
  assert.strictEqual(svc.isHumanUserMessage(msgs[1]), false);
  assert.strictEqual(svc.isHumanUserMessage(msgs[0]), true);
});

// ==================== 分页 ====================

test('会话不存在时返回 found:false 而不是抛', () => {
  const r = svc.loadSessionPage('nope-nope-nope', null);
  assert.strictEqual(r.found, false);
  assert.deepStrictEqual(r.messages, []);
});

test('首屏（beforeTurn=null）只取最近一页，并报告还有更早的', () => {
  writeRollout('aaaa1111', 70);
  const r = svc.loadSessionPage('aaaa1111', null);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.totalTurns, 70);
  assert.strictEqual(r.toTurn, 70);
  assert.strictEqual(r.fromTurn, 40);        // 70 - 30
  assert.ok(r.fromTurn > 0, 'hasMore 的依据');
  assert.strictEqual(r.threadId, 'thread-aaaa1111');
  assert.strictEqual(r.cwd, '/proj');
});

test('翻页取 [beforeTurn-30, beforeTurn)，且首尾衔接不丢不重', () => {
  writeRollout('bbbb2222', 70);
  const first = svc.loadSessionPage('bbbb2222', null);
  const second = svc.loadSessionPage('bbbb2222', first.fromTurn);
  assert.strictEqual(second.toTurn, 40);
  assert.strictEqual(second.fromTurn, 10);
  // 第二页的最后一条应紧邻第一页的第一条
  const firstHead = first.messages[0];
  const secondTail = second.messages[second.messages.length - 1];
  assert.strictEqual(firstHead.content, '问题 40');
  assert.strictEqual(secondTail.content, '回答 39');
});

test('翻到头时 fromTurn=0，hasMore 依据为假', () => {
  writeRollout('cccc3333', 20);
  const r = svc.loadSessionPage('cccc3333', 20);
  assert.strictEqual(r.fromTurn, 0);
  assert.strictEqual(r.toTurn, 20);
  assert.strictEqual(r.totalTurns, 20);
});

test('总轮次不足一页时一次取完', () => {
  writeRollout('dddd4444', 5);
  const r = svc.loadSessionPage('dddd4444', null);
  assert.strictEqual(r.fromTurn, 0);
  assert.strictEqual(r.toTurn, 5);
  assert.strictEqual(r.cursorReset, false);
});

test('光标比磁盘上的轮次大（会话被改短）→ cursorReset，退化为最近一页', () => {
  writeRollout('eeee5555', 10);
  const r = svc.loadSessionPage('eeee5555', 999);
  assert.strictEqual(r.cursorReset, true);
  assert.strictEqual(r.toTurn, 10);
  assert.strictEqual(r.fromTurn, 0);
});

test('取第 0 轮时会带上首个用户消息之前的内容（否则那段永远加载不到）', () => {
  const dir = path.join(CODEX_HOME, 'sessions', '2026', '09', '13');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-13T00-00-00-ffff6666.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 't', cwd: '/p' } }),
    // 开场就是一条助手消息（没有对应的人类轮次）
    JSON.stringify({ type: 'response_item', timestamp: 'T0', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '开场白' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: 'T1', payload: { type: 'user_message', message: '问题 0' } }),
  ].join('\n'), 'utf-8');
  const r = svc.loadSessionPage('ffff6666', null);
  assert.strictEqual(r.fromTurn, 0);
  assert.strictEqual(r.messages[0].content, '开场白');
});

test('pageSize 可覆盖', () => {
  writeRollout('gggg7777', 10);
  const r = svc.loadSessionPage('gggg7777', null, 3);
  assert.strictEqual(r.fromTurn, 7);
  assert.strictEqual(r.toTurn, 10);
});
