import { emitAccumulatedUsage, mergeUsage } from '../../utils/usage-utils.js';
import { truncateErrorContent, truncateToolResultBlock } from './message-output-filter.js';
import { getBlockMap, normalizeStreamDelta, rememberStreamSnapshot } from './stream-delta-normalizer.js';

export function emitUsageTag(msg) {
  if (msg.type === 'assistant' && msg.message?.usage) {
    const {
      input_tokens = 0,
      output_tokens = 0,
      cache_creation_input_tokens = 0,
      cache_read_input_tokens = 0
    } = msg.message.usage;
    console.log('[USAGE]', JSON.stringify({
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    }));
  }
}

export function createTurnState(requestContext, runtime) {
  return {
    streamingEnabled: requestContext.streamingEnabled,
    streamStarted: false,
    streamEnded: false,
    hasStreamEvents: false,
    lastAssistantContent: '',
    lastThinkingContent: '',
    textBlockContentByIndex: new Map(),
    thinkingBlockContentByIndex: new Map(),
    finalSessionId: requestContext.requestedSessionId || runtime?.sessionId || '',
    accumulatedUsage: null
  };
}

export function processStreamEvent(msg, turnState) {
  const event = msg.event;
  if (!event) return;

  if (event.type === 'message_start' && event.message?.usage) {
    turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.message.usage);
  }

  if (event.type === 'message_delta' && event.usage) {
    turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.usage);
    emitAccumulatedUsage(turnState.accumulatedUsage);
  }

  if (event.type === 'content_block_delta' && event.delta) {
    if (event.delta.type === 'text_delta' && event.delta.text) {
      const delta = normalizeStreamDelta(turnState, 'text', event.index, event.delta.text);
      if (delta) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
        turnState.lastAssistantContent += delta;
      }
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      const delta = normalizeStreamDelta(turnState, 'thinking', event.index, event.delta.thinking);
      if (delta) {
        process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
        turnState.lastThinkingContent += delta;
      }
    }
  }
}

export function processMessageContent(msg, turnState) {
  if (msg.type !== 'assistant') return;
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (block.type === 'text') {
        const currentText = block.text || '';
        const textBlockMap = getBlockMap(turnState, 'textBlockContentByIndex');
        const previousBlock = textBlockMap.get(i) || '';
        rememberStreamSnapshot(turnState, 'text', i, currentText);
        // Compare against per-block content rather than lastAssistantContent.
        // After a silent snapshot-mode correction (absorbed by computeNovelDelta)
        // the blockMap is updated but lastAssistantContent is stale.
        //
        // When streaming events have started but this block is still empty the
        // stream will deliver the content shortly — emitting the full block text
        // here would duplicate every token.  Only emit when either no stream
        // events have fired at all (pre-stream fallback) or the block already
        // has partial content (genuine tail-fill / snapshot correction).
        if (turnState.streamingEnabled && currentText.length > previousBlock.length) {
          const delta = currentText.substring(previousBlock.length);
          if (delta && (!turnState.hasStreamEvents || previousBlock.length > 0)) {
            process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastAssistantContent = currentText;
        } else if (!turnState.streamingEnabled) {
          console.log('[CONTENT]', truncateErrorContent(currentText));
        }
      } else if (block.type === 'thinking') {
        const thinkingText = block.thinking || block.text || '';
        const thinkingBlockMap = getBlockMap(turnState, 'thinkingBlockContentByIndex');
        const previousThinkingBlock = thinkingBlockMap.get(i) || '';
        rememberStreamSnapshot(turnState, 'thinking', i, thinkingText);
        if (turnState.streamingEnabled && thinkingText.length > previousThinkingBlock.length) {
          const delta = thinkingText.substring(previousThinkingBlock.length);
          if (delta && (!turnState.hasStreamEvents || previousThinkingBlock.length > 0)) {
            process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastThinkingContent = thinkingText;
        } else if (!turnState.streamingEnabled) {
          console.log('[THINKING]', thinkingText);
        }
      }
    }
  } else if (typeof content === 'string') {
    const textBlockMap = getBlockMap(turnState, 'textBlockContentByIndex');
    const previousBlock = textBlockMap.get(0) || '';
    rememberStreamSnapshot(turnState, 'text', 0, content);
    if (turnState.streamingEnabled && content.length > previousBlock.length) {
      const delta = content.substring(previousBlock.length);
      if (delta && (!turnState.hasStreamEvents || previousBlock.length > 0)) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
      }
      turnState.lastAssistantContent = content;
    } else if (!turnState.streamingEnabled) {
      console.log('[CONTENT]', truncateErrorContent(content));
    }
  }
}

export function processToolResultMessages(msg) {
  if (msg.type !== 'user') return;
  const content = msg.message?.content ?? msg.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      console.log('[TOOL_RESULT]', JSON.stringify(truncateToolResultBlock(block)));
    }
  }
}

export function shouldOutputMessage(msg, turnState) {
  // Always output non-assistant messages
  if (msg.type !== 'assistant') {
    return true;
  }

  // Non-streaming mode: always output
  if (!turnState.streamingEnabled) {
    return true;
  }

  // Streaming mode: only emit [MESSAGE] when the snapshot carries tool_use blocks.
  // Pure text/thinking content is delivered via [CONTENT_DELTA] / [THINKING_DELTA]
  // (processStreamEvent for live deltas, processMessageContent for tail-fill).
  // Mirrors the legacy message-sender.js shouldOutput rule. Emitting redundant
  // [MESSAGE] for text-only assistants forces the Java ReplayDeduplicator to
  // reconcile the same content twice and was the upstream cause of duplicated
  // markdown blocks reported on v0.4.x streaming.
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'tool_use');
}
