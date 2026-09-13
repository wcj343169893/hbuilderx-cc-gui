import type { ClaudeMessage, TodoItem, SubagentInfo } from '../types';

export function isToolResultOnlyUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if ((message.content ?? '').trim() === '[tool_result]') return true;

  const raw = message.raw;
  if (!raw || typeof raw === 'string') return false;

  const content = raw.content ?? raw.message?.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) =>
    block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result',
  );
}

export function findLatestConversationTurnStart(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (isToolResultOnlyUserMessage(message)) continue;
    return i;
  }
  return -1;
}

export function sliceLatestConversationTurn(messages: ClaudeMessage[]): ClaudeMessage[] {
  const start = findLatestConversationTurnStart(messages);
  return start >= 0 ? messages.slice(start) : [];
}

export function finalizeTodosForSettledTurn(todos: TodoItem[], isStreaming: boolean): TodoItem[] {
  if (isStreaming) return todos;
  return todos.map((todo) => (
    todo.status === 'in_progress'
      ? { ...todo, status: 'completed' }
      : todo
  ));
}

export function finalizeSubagentsForSettledTurn(subagents: SubagentInfo[], _isStreaming: boolean): SubagentInfo[] {
  // A settled main turn is not evidence that a run_in_background agent ended:
  // the launch turn completes while the sidechain may still be running. Async
  // agents are finalized only by task_notification or by a sidechain transcript
  // ending in assistant/end_turn (resolved in useSubagents). Sync agents already
  // derive their terminal state from the Agent tool_result.
  return subagents;
}
