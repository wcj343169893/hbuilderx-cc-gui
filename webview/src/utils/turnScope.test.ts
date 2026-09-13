import { describe, expect, it } from 'vitest';
import { finalizeSubagentsForSettledTurn } from './turnScope';
import type { SubagentInfo } from '../types';

const subagent = (overrides: Partial<SubagentInfo>): SubagentInfo => ({
  id: 'tu_1',
  type: 'research',
  description: 'task',
  status: 'running',
  messageIndex: 0,
  ...overrides,
});

describe('finalizeSubagentsForSettledTurn', () => {
  it('does not infer async completion from a settled main turn', () => {
    const result = finalizeSubagentsForSettledTurn([subagent({ isAsync: true })], false);
    expect(result[0].status).toBe('running');
  });

  it('preserves terminal status supplied by task_notification or sidechain history', () => {
    const result = finalizeSubagentsForSettledTurn(
      [
        subagent({ isAsync: true, status: 'completed' }),
        subagent({ isAsync: true, status: 'error' }),
      ],
      false,
    );
    expect(result.map((item) => item.status)).toEqual(['completed', 'error']);
  });

  it('does not mutate sync extraction results', () => {
    const running = subagent({ isAsync: false });
    const completed = subagent({ isAsync: false, status: 'completed' });
    const result = finalizeSubagentsForSettledTurn([running, completed], false);
    expect(result).toEqual([running, completed]);
  });

  it('returns the same states while streaming', () => {
    const result = finalizeSubagentsForSettledTurn(
      [subagent({ isAsync: false }), subagent({ isAsync: true })],
      true,
    );
    expect(result[0].status).toBe('running');
    expect(result[1].status).toBe('running');
  });
});
