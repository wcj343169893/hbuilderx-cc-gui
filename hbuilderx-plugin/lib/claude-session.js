'use strict';

/**
 * 会话消息装配器：把 stream-adapter 解析出的语义事件，装配成前端可消费的消息列表，
 * 并驱动前端 window.* 回调。移植自：
 *   - src/.../session/ClaudeMessageHandler.java（状态机）
 *   - src/.../util/MessageJsonConverter.java（updateMessages 的 JSON 形态）
 *   - src/.../session/SessionCallbackAdapter.java（回调名映射）
 *
 * MVP 取舍：实现文本/思考流式、tool_use/tool_result 结构块、错误、session_id、usage；
 * 暂未移植 ReplayDeduplicator 的去重（[MESSAGE] 全量回放与增量并存时的边界），
 * 真机联调时若出现重复再补。
 */

class ClaudeSessionAssembler {
  /**
   * @param {{ callJs: (fn: string, ...args: any[]) => void }} jsTarget
   * @param {{ appendLine: (s: string) => void }} [output]
   */
  constructor(jsTarget, output) {
    this.js = jsTarget;
    this.output = output || { appendLine() {} };
    this.reset();
  }

  reset() {
    /** @type {Array<{type:string,content:string,timestamp:number,raw?:object}>} */
    this.messages = [];
    this.currentAssistant = null;
    this.assistantContent = '';
    this.isStreaming = false;
    this.isThinking = false;
    this.textSegmentActive = false;
    this.thinkingSegmentActive = false;
    this.sessionId = '';
    this._seq = 0;
  }

  /** 追加一条用户消息（本地回显，发送前调用）。 */
  addUserMessage(text) {
    this.messages.push({ type: 'user', content: text, timestamp: Date.now(), raw: null });
    this._pushMessages();
  }

  // ===== 入口：处理 stream-adapter 上报的事件 =====
  onEvent(type, payload) {
    switch (type) {
      case 'stream_start': return this._handleStreamStart();
      case 'stream_end': return this._handleStreamEnd();
      case 'block_reset': return this._handleBlockReset();
      case 'content_delta': return this._handleContentDelta(payload);
      case 'content': return this._handleContent(payload);
      case 'thinking_delta': return this._handleThinkingDelta(payload);
      case 'thinking': return this._handleThinking();
      case 'session_id': return this._handleSessionId(payload);
      case 'usage': return this._handleUsage(payload);
      case 'assistant': return this._handleAssistantMessage(payload);
      case 'user': return this._handleUserMessage(payload);
      case 'tool_result': return this._handleToolResult(payload);
      case 'system': return this._handleSystem(payload);
      case '__error': return this.onError(payload);
      // result / message_start / message_end / system 暂不需要前端动作
      default: return undefined;
    }
  }

  onError(error) {
    this.isStreaming = false;
    this.isThinking = false;
    this._resetSegments();
    this.messages.push({ type: 'error', content: error || 'Unknown error', timestamp: Date.now() });
    this._pushMessages();
    this.js.callJs('onStreamEnd', String(++this._seq));
    this.js.callJs('showLoading', 'false');
    this.js.callJs('addErrorMessage', error || 'Unknown error');
  }

  /** 一次请求完成后的兜底清理（对应 onComplete）。 */
  onComplete() {
    if (this.isStreaming) {
      this.isStreaming = false;
      this._resetSegments();
      this._pushMessages();
      this.js.callJs('onStreamEnd', String(++this._seq));
      this.js.callJs('showLoading', 'false');
    }
  }

  // ===== 各类型处理 =====
  _handleStreamStart() {
    this.isStreaming = true;
    this._resetSegments();
    this.js.callJs('showLoading', 'true');
    this.js.callJs('onStreamStart');
  }

  _handleStreamEnd() {
    this.isStreaming = false;
    this.isThinking = false;
    this._resetSegments();
    this._pushMessages();
    this.js.callJs('onStreamEnd', String(++this._seq));
    this.js.callJs('showLoading', 'false');
  }

  _handleBlockReset() {
    this._resetSegments();
    this.js.callJs('onBlockReset');
  }

  _handleContentDelta(delta) {
    if (!delta) return;
    if (this.isThinking) {
      this.isThinking = false;
      this.js.callJs('showThinkingStatus', 'false');
    }
    this.thinkingSegmentActive = false;
    this.assistantContent += delta;
    this._ensureAssistant();
    this.currentAssistant.content = this.assistantContent;
    this._applyTextDeltaToRaw(delta);
    this.textSegmentActive = true;
    this.js.callJs('onContentDelta', delta);
    if (!this.isStreaming) this._pushMessages();
  }

  _handleContent(content) {
    if (this.isThinking) {
      this.isThinking = false;
      this.js.callJs('showThinkingStatus', 'false');
    }
    this.assistantContent += content;
    this._ensureAssistant();
    this.currentAssistant.content = this.assistantContent;
    this._applyTextDeltaToRaw(content);
    if (!this.isStreaming) this._pushMessages();
  }

  _handleThinking() {
    if (!this.isThinking) {
      this.isThinking = true;
      this.js.callJs('showThinkingStatus', 'true');
    }
  }

  _handleThinkingDelta(delta) {
    if (!delta) return;
    if (!this.isThinking) {
      this.isThinking = true;
      this.js.callJs('showThinkingStatus', 'true');
    }
    this._ensureAssistant();
    this._applyThinkingDeltaToRaw(delta);
    this.thinkingSegmentActive = true;
    this.js.callJs('onThinkingDelta', delta);
    this._pushMessages();
  }

  _handleSessionId(id) {
    this.sessionId = id;
    this.js.callJs('setSessionId', id);
  }

  _handleUsage(jsonStr) {
    try {
      const usage = JSON.parse(jsonStr);
      const used = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      // maxTokens 未知时给 0，前端按 0 处理百分比
      this.js.callJs('onUsageUpdate', JSON.stringify({ percentage: 0, usedTokens: used, maxTokens: 0 }));
    } catch (e) { /* ignore */ }
  }

  _handleAssistantMessage(jsonStr) {
    let msg;
    try { msg = JSON.parse(jsonStr); } catch (e) { return; }
    // 结构性更新：合并 tool_use 等块。MVP 策略：以增量累积的文本为准，
    // 但采纳 incoming raw 中的非文本块（tool_use / thinking 结构）。
    this._ensureAssistant();
    const incomingContent = msg && msg.message && Array.isArray(msg.message.content) ? msg.message.content : null;
    if (incomingContent) {
      const curContent = this._assistantContentArray();
      // 保留已累积的 text/thinking 块，追加 incoming 的 tool_use 块
      for (const block of incomingContent) {
        if (block && block.type === 'tool_use') {
          const exists = curContent.some((b) => b && b.type === 'tool_use' && b.id === block.id);
          if (!exists) {
            curContent.push(block);
            this.output.appendLine(`[tool_use] ${block.name}`);
          }
        }
      }
      this.textSegmentActive = false;
      this.thinkingSegmentActive = false;
    }
    this._pushMessages();
  }

  _handleUserMessage(jsonStr) {
    let userMsg;
    try { userMsg = JSON.parse(jsonStr); } catch (e) { return; }
    const content = userMsg && userMsg.message ? userMsg.message.content : null;
    const hasToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
    if (hasToolResult) {
      this.messages.push({ type: 'user', content: '[tool_result]', timestamp: Date.now(), raw: userMsg });
      this._pushMessages();
      return;
    }
    // uuid 回填（用于 rewind）：找到最近一条同文本、且未带 uuid 的用户消息
    const uuid = userMsg && userMsg.uuid;
    if (!uuid) return;
    const text = this._extractText(userMsg);
    if (!text) return;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.type !== 'user' || m.content !== text) continue;
      if (!m.raw) m.raw = {};
      if (m.raw.uuid) continue;
      m.raw.uuid = uuid;
      this.js.callJs('patchMessageUuid', m.content || '', uuid);
      break;
    }
  }

  /** SDK 的 system(init) 消息携带 slash_commands（含 .claude/skills 生成的命令）→ 下发前端。 */
  _handleSystem(jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      const cmds = obj && (obj.slash_commands || (obj.message && obj.message.slash_commands));
      if (Array.isArray(cmds) && cmds.length) {
        this.js.callJs('updateSlashCommands', JSON.stringify(cmds));
      }
    } catch (e) { /* ignore */ }
  }

  _handleToolResult(jsonStr) {
    let block;
    try { block = JSON.parse(jsonStr); } catch (e) { return; }
    if (!block || !block.tool_use_id) return;
    const raw = { type: 'user', message: { content: [block] } };
    this.messages.push({ type: 'user', content: '[tool_result]', timestamp: Date.now(), raw });
    this._pushMessages();
  }

  // ===== raw 装配辅助 =====
  _ensureAssistant() {
    if (!this.currentAssistant) {
      this.currentAssistant = {
        type: 'assistant',
        content: '',
        timestamp: Date.now(),
        raw: { type: 'assistant', message: { content: [] } },
      };
      this.messages.push(this.currentAssistant);
    }
    if (!this.currentAssistant.raw) {
      this.currentAssistant.raw = { type: 'assistant', message: { content: [] } };
    }
  }

  _assistantContentArray() {
    this._ensureAssistant();
    const raw = this.currentAssistant.raw;
    if (!raw.message || typeof raw.message !== 'object') raw.message = { content: [] };
    if (!Array.isArray(raw.message.content)) raw.message.content = [];
    return raw.message.content;
  }

  _applyTextDeltaToRaw(delta) {
    const arr = this._assistantContentArray();
    let target = null;
    if (this.textSegmentActive) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i].type === 'text') { target = arr[i]; break; }
      }
    }
    if (!target) {
      target = { type: 'text', text: '' };
      arr.push(target);
    }
    target.text = (target.text || '') + delta;
  }

  _applyThinkingDeltaToRaw(delta) {
    const arr = this._assistantContentArray();
    let target = null;
    if (this.thinkingSegmentActive) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i].type === 'thinking') { target = arr[i]; break; }
      }
    }
    if (!target) {
      target = { type: 'thinking', thinking: '' };
      arr.push(target);
    }
    target.thinking = (target.thinking || '') + delta;
  }

  _resetSegments() {
    this.textSegmentActive = false;
    this.thinkingSegmentActive = false;
  }

  _extractText(msg) {
    const content = msg && msg.message ? msg.message.content : null;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
    }
    return '';
  }

  /** 构建并下发 updateMessages（形态对齐 MessageJsonConverter.convertMessagesToJson）。 */
  _pushMessages() {
    const arr = this.messages.map((m) => {
      const o = { type: String(m.type).toLowerCase(), timestamp: m.timestamp, content: m.content || '' };
      if (m.raw) o.raw = this._trimRaw(m.raw);
      return o;
    });
    this.js.callJs('updateMessages', JSON.stringify(arr), String(++this._seq));
  }

  /** 对应 MessageJsonConverter.buildTransportRaw：仅保留前端需要的字段。 */
  _trimRaw(raw) {
    const t = {};
    for (const k of ['uuid', 'type', 'isMeta', 'text', 'origin', 'turnUsage']) {
      if (raw[k] !== undefined) t[k] = raw[k];
    }
    if (raw.content !== undefined) t.content = raw.content;
    if (raw.message && typeof raw.message === 'object' && raw.message.content !== undefined) {
      t.message = { content: raw.message.content };
    }
    return t;
  }
}

module.exports = { ClaudeSessionAssembler };
