'use strict';

/**
 * 异步子代理生命周期（B3）的两个纯判定：
 * - hasSubagentCompleted：重载后从 sidechain JSONL 反推终态（task_notification 不落盘）
 * - resolveModelAlias：Codex [model_aliases]，受管供应商与本地配置必须分开
 */

const test = require('node:test');
const assert = require('node:assert');

const { hasSubagentCompleted } = require('./message-router');
const { resolveModelAlias } = require('./codex-runtime');

// ==================== hasSubagentCompleted ====================

const assistant = (stopReason) => ({ type: 'assistant', message: { stop_reason: stopReason } });

test('末条 assistant 是 end_turn → 已完成', () => {
  assert.strictEqual(hasSubagentCompleted([assistant('end_turn')]), true);
});

test('末条 assistant 是 tool_use → 还在等工具结果，未完成', () => {
  assert.strictEqual(hasSubagentCompleted([assistant('end_turn'), assistant('tool_use')]), false);
});

test('stop_reason 缺失/为 null → 流式还没收尾，未完成', () => {
  assert.strictEqual(hasSubagentCompleted([{ type: 'assistant', message: {} }]), false);
  assert.strictEqual(hasSubagentCompleted([{ type: 'assistant', message: { stop_reason: null } }]), false);
});

test('是「从尾往前的第一条 assistant 就返回」，不是「有任意一条终态就算完」', () => {
  // 中间轮次本来就会有 end_turn；若写成「任意一条」，正在跑的子代理会被误判成已完成
  const records = [assistant('end_turn'), assistant('end_turn'), assistant('tool_use')];
  assert.strictEqual(hasSubagentCompleted(records), false);
});

test('跳过非 assistant 记录后再判定', () => {
  const records = [assistant('tool_use'), { type: 'user', message: {} }, assistant('max_tokens'), { type: 'user' }];
  assert.strictEqual(hasSubagentCompleted(records), true);
});

test('其余终态（max_tokens / refusal / stop_sequence / pause_turn）都算完成', () => {
  for (const r of ['max_tokens', 'refusal', 'stop_sequence', 'pause_turn']) {
    assert.strictEqual(hasSubagentCompleted([assistant(r)]), true, r);
  }
});

test('空数组 / 非数组 / 全是非 assistant → 未完成', () => {
  assert.strictEqual(hasSubagentCompleted([]), false);
  assert.strictEqual(hasSubagentCompleted(null), false);
  assert.strictEqual(hasSubagentCompleted([{ type: 'user' }, null, 'x']), false);
});

// ==================== resolveModelAlias ====================

const neverRead = { readUserConfig: () => { throw new Error('受管供应商不该读用户 ~/.codex'); } };

test('受管供应商只查自己的 model_aliases，绝不读用户 ~/.codex', () => {
  const overrides = { model_aliases: { fast: 'gpt-5.6-sol' } };
  assert.strictEqual(resolveModelAlias('fast', overrides, neverRead), 'gpt-5.6-sol');
  // 受管供应商没有该别名时原样返回，而不是回落去读用户配置
  assert.strictEqual(resolveModelAlias('other', overrides, neverRead), 'other');
});

test('非受管（configOverrides 为 null）才读用户 config.toml', () => {
  const deps = { readUserConfig: () => '[model_aliases]\nfast = "gpt-5.5"\n' };
  assert.strictEqual(resolveModelAlias('fast', null, deps), 'gpt-5.5');
  assert.strictEqual(resolveModelAlias('unknown', null, deps), 'unknown');
});

test('config.toml 没有 [model_aliases] 表 → 原样返回', () => {
  assert.strictEqual(resolveModelAlias('m', null, { readUserConfig: () => '[other]\nx = 1\n' }), 'm');
});

test('别名值不是非空字符串 → 原样返回', () => {
  const overrides = { model_aliases: { a: '', b: 123, c: null } };
  for (const k of ['a', 'b', 'c']) {
    assert.strictEqual(resolveModelAlias(k, overrides, neverRead), k);
  }
});

test('config.toml 写坏了不该让发送失败，退回原模型名', () => {
  assert.strictEqual(resolveModelAlias('m', null, { readUserConfig: () => '[[[ broken' }), 'm');
  assert.strictEqual(resolveModelAlias('m', null, { readUserConfig: () => { throw new Error('EACCES'); } }), 'm');
});

test('空模型名原样返回', () => {
  assert.strictEqual(resolveModelAlias('', null, neverRead), '');
  assert.strictEqual(resolveModelAlias(undefined, null, neverRead), undefined);
});

test('模型名前后空白被 trim 后再查表', () => {
  assert.strictEqual(resolveModelAlias('  fast  ', { model_aliases: { fast: 'real' } }, neverRead), 'real');
});
