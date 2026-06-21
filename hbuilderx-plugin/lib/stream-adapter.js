'use strict';

/**
 * 将 ai-bridge 输出的带标记行（[CONTENT_DELTA] 等）解析为语义事件。
 * 直接移植自 src/.../provider/claude/ClaudeStreamAdapter.java。
 *
 * 解析结果通过回调 onEvent(type, payload) 上报，type 与 IDEA 版
 * ClaudeMessageHandler.onMessage 的 type 一一对应。
 */

/** 解码 [CONTENT_DELTA]/[THINKING_DELTA] 的 JSON 字符串载荷（形如 ` "abc"`）。 */
function decodeJsonStringPayload(rawPayload) {
  const jsonStr = rawPayload.startsWith(' ') ? rawPayload.slice(1) : rawPayload;
  try {
    const parsed = JSON.parse(jsonStr);
    return typeof parsed === 'string' ? parsed : jsonStr;
  } catch (e) {
    return jsonStr;
  }
}

const ERROR_PREFIXES = ['[STDIN_ERROR]', '[STDIN_PARSE_ERROR]', '[GET_SESSION_ERROR]', '[PERSIST_ERROR]'];

/**
 * 处理一行输出。
 * @param {string} line
 * @param {(type: string, payload: string) => void} onEvent
 * @param {{ lastNodeError?: string, hadSendError?: boolean }} state 可变状态容器
 */
function processOutputLine(line, onEvent, state) {
  for (const p of ERROR_PREFIXES) {
    if (line.startsWith(p)) {
      state.lastNodeError = line;
      break;
    }
  }

  if (line.startsWith('[MESSAGE]')) {
    const jsonStr = line.slice('[MESSAGE]'.length).trim();
    try {
      const msg = JSON.parse(jsonStr);
      const type = msg && msg.type ? msg.type : 'unknown';
      onEvent(type, jsonStr);
    } catch (e) {
      /* 忽略非法 JSON */
    }
    return;
  }

  if (line.startsWith('[SEND_ERROR]')) {
    const jsonStr = line.slice('[SEND_ERROR]'.length).trim();
    let errorMessage = jsonStr;
    try {
      const obj = JSON.parse(jsonStr);
      if (obj && obj.error) errorMessage = obj.error;
    } catch (e) {
      /* 用原文 */
    }
    state.hadSendError = true;
    onEvent('__error', errorMessage);
    return;
  }

  if (line.startsWith('[CONTENT_DELTA]')) {
    onEvent('content_delta', decodeJsonStringPayload(line.slice('[CONTENT_DELTA]'.length)));
    return;
  }
  if (line.startsWith('[CONTENT]')) {
    onEvent('content', line.slice('[CONTENT]'.length).trim());
    return;
  }
  if (line.startsWith('[THINKING_DELTA]')) {
    onEvent('thinking_delta', decodeJsonStringPayload(line.slice('[THINKING_DELTA]'.length)));
    return;
  }
  if (line.startsWith('[THINKING]')) {
    onEvent('thinking', line.slice('[THINKING]'.length).trim());
    return;
  }
  if (line.startsWith('[STREAM_START]')) {
    onEvent('stream_start', '');
    return;
  }
  if (line.startsWith('[STREAM_END]')) {
    onEvent('stream_end', '');
    return;
  }
  if (line.startsWith('[SESSION_ID]')) {
    onEvent('session_id', line.slice('[SESSION_ID]'.length).trim());
    return;
  }
  if (line.startsWith('[TOOL_RESULT]')) {
    onEvent('tool_result', line.slice('[TOOL_RESULT]'.length).trim());
    return;
  }
  if (line.startsWith('[USAGE]')) {
    onEvent('usage', line.slice('[USAGE]'.length).trim());
    return;
  }
  if (line.startsWith('[MESSAGE_START]')) {
    onEvent('message_start', '');
    return;
  }
  if (line.startsWith('[BLOCK_RESET]')) {
    onEvent('block_reset', '');
    return;
  }
  if (line.startsWith('[MESSAGE_END]')) {
    onEvent('message_end', '');
  }
}

module.exports = { processOutputLine, decodeJsonStringPayload };
