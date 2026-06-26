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

/**
 * 模型上下文窗口（tokens）。复刻 IDEA ModelProviderHandler.MODEL_CONTEXT_LIMITS，
 * 用于把每轮 usage 换算成「上下文用量百分比」。未列出的模型默认 200k。
 */
const MODEL_CONTEXT_LIMITS = {
  'claude-sonnet-4-6': 200000,
  'claude-fable-5': 200000,
  'claude-opus-4-8': 200000,
  'claude-opus-4-7': 200000,
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6[1m]': 1000000,
  'claude-fable-5[1m]': 1000000,
  'claude-opus-4-8[1m]': 1000000,
  'claude-opus-4-7[1m]': 1000000,
  'claude-opus-4-6[1m]': 1000000,
  'claude-haiku-4-5': 200000,
  'gpt-5.4': 1000000,
  'gpt-5.4-mini': 400000,
  'gpt-5.3-codex': 258000,
  'gpt-5.2-codex': 258000,
  'gpt-5.2': 258000,
  'gpt-5.1': 128000,
  'gpt-5.1-codex': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'o3': 200000,
  'o3-mini': 200000,
  'o1': 200000,
  'o1-mini': 128000,
  'o1-preview': 128000,
};

/**
 * 解析模型的上下文窗口大小（tokens）。复刻 IDEA ModelProviderHandler.getModelContextLimit：
 * 优先识别形如 `xxx[1m]` / `xxx[200k]` 的容量后缀，否则查表，默认 200000。
 * @param {string} model
 * @returns {number}
 */
function getModelContextLimit(model) {
  if (!model) return 200000;
  const m = /\s*\[([0-9.]+)([kKmM])\]\s*$/.exec(model);
  if (m) {
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (!isNaN(value)) {
      if (unit === 'm') return Math.round(value * 1000000);
      if (unit === 'k') return Math.round(value * 1000);
    }
  }
  return MODEL_CONTEXT_LIMITS[model] != null ? MODEL_CONTEXT_LIMITS[model] : 200000;
}

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
    // 序列号必须**全生命周期单调递增、绝不归零**：前端 __minAcceptedUpdateSequence 只增不减，
    // 归零会让新会话的 updateMessages 因 seq 落后被整批丢弃（切 provider/model、/clear 都走 reset）。
    // 对齐 IDEA StreamMessageCoalescer.resetStreamState 的 `++updateSequence`（不是置 0）。
    this._seq = (this._seq | 0) + 1;
    // resume 全量回放去重：记录已 push 过的 tool_result 的 tool_use_id，避免历史 tool_result 被重复 push。
    this._seenToolResultIds = new Set();
    // 上下文用量：当前模型（决定上下文窗口）+ 最近一次累计 tokens（用于模型切换时按新窗口重算）
    this.currentModel = '';
    this.lastUsedTokens = 0;
    this._onAutoCompact = null;
  }

  /** 追加一条用户消息（本地回显，发送前调用）。 */
  addUserMessage(text) {
    // 新一轮对话开始：先复位上一轮的单轮累积态，否则本轮回复会并入上一条助手气泡
    // （气泡位于新问题之前）。对齐 IDEA SessionSendService 每轮 new ClaudeMessageHandler 的语义。
    this._beginTurn();
    this.messages.push({ type: 'user', content: text, timestamp: Date.now(), raw: null });
    this._pushMessages();
  }

  /**
   * 复位「单轮级」状态：当前助手气泡引用、累积文本、思考态、段落标志。
   * 不动「会话级」状态（messages 列表 / sessionId / 用量 / 模型），故历史消息与上下文保留。
   * 移植说明：IDEA 版每次 sendToClaude 都 new 一个 ClaudeMessageHandler，currentAssistantMessage
   * 天生每轮从 null 开始；本装配器是跨轮复用的单例，必须在轮次边界显式复位。
   */
  _beginTurn() {
    this.currentAssistant = null;
    this.assistantContent = '';
    this.isThinking = false;
    this._resetSegments();
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
    // daemon 每轮只发一次 STREAM_END（整轮工具循环跑完、收到 result 后），此时工具结果
    // 均已返回，停掉倒计时即正确时机。工具执行/等待授权期间的「倒计时保活」由
    // message-router 的 onStreamingHeartbeat 心跳负责，不在此处延后停倒计时。
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

  /** 设置当前模型（决定上下文窗口）。发送前由 router 调用，使 usage 百分比按正确窗口换算。 */
  setModel(model) {
    this.currentModel = model || '';
  }

  /**
   * 模型切换后按新上下文窗口重算并推送一次用量（对齐 IDEA pushUsageUpdateAfterModelChange）：
   * 切到 `[1m]` 等大窗口模型时，已用 tokens 不变但百分比应随之下降，无需等下一条消息。
   */
  pushUsageForModel(model) {
    this.currentModel = model || '';
    this._emitUsage(this.lastUsedTokens);
  }

  /**
   * 设置自动 compact 回调：当上下文用量超过 80% 阈值时调用。
   * @param {function(usedTokens:number, maxTokens:number, percentage:number):void} fn
   */
  setAutoCompactCallback(fn) {
    this._onAutoCompact = typeof fn === 'function' ? fn : null;
  }

  _handleUsage(jsonStr) {
    try {
      const usage = JSON.parse(jsonStr);
      // Claude 口径：input + output + cache_read + cache_creation（对齐 IDEA TokenUsageUtils.extractUsedTokens）
      const used = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      this._emitUsage(used);
    } catch (e) { /* ignore */ }
  }

  /** 按当前模型上下文窗口换算百分比并下发 onUsageUpdate（百分比由宿主计算，前端直接显示）。 */
  _emitUsage(usedTokens) {
    this.lastUsedTokens = usedTokens || 0;
    const maxTokens = getModelContextLimit(this.currentModel);
    const percentage = maxTokens > 0 ? Math.min(100, Math.round((this.lastUsedTokens * 100) / maxTokens)) : 0;
    this.js.callJs('onUsageUpdate', JSON.stringify({
      percentage,
      usedTokens: this.lastUsedTokens,
      totalTokens: this.lastUsedTokens,
      maxTokens,
      limit: maxTokens,
    }));
    // 自动 compact 检测：用量超过 80% 阈值时通知外部
    const AUTO_COMPACT_THRESHOLD = 0.8;
    if (this._onAutoCompact && this.lastUsedTokens > 0 && maxTokens > 0
        && (this.lastUsedTokens / maxTokens) >= AUTO_COMPACT_THRESHOLD) {
      this._onAutoCompact(this.lastUsedTokens, maxTokens, percentage);
    }
  }

  _handleAssistantMessage(jsonStr) {
    let msg;
    try { msg = JSON.parse(jsonStr); } catch (e) { return; }
    const incomingContent = msg && msg.message && Array.isArray(msg.message.content) ? msg.message.content : null;
    // resume 全量回放去重（移植 IDEA ReplayDeduplicator 的目的，简化判据）：
    // SDK 在 runtime 中途重建后会 `resume` 重放整段历史，daemon 对「含 tool_use 的历史 assistant」
    // 也会重发 [MESSAGE]。若此时当前轮尚未产出任何增量（currentAssistant 为 null）且本条携带的
    // tool_use 全是「历史已存在的 id」，说明这是历史重放 —— 跳过，否则 _ensureAssistant() 会新建
    // 一个幽灵气泡并把后续新内容并进去，导致对话气泡错乱/合并。（纯文本历史 assistant 不会重发
    // [MESSAGE]，见 daemon shouldOutputMessage，故无需处理。）
    if (!this.currentAssistant && incomingContent) {
      const toolUses = incomingContent.filter((b) => b && b.type === 'tool_use' && b.id);
      if (toolUses.length > 0 && toolUses.every((b) => this._toolUseIdExists(b.id))) {
        this.output.appendLine('[replay] 跳过历史 assistant 重放（tool_use id 已存在）');
        return;
      }
    }
    // 结构性更新：合并 tool_use 等块。MVP 策略：以增量累积的文本为准，
    // 但采纳 incoming raw 中的非文本块（tool_use / thinking 结构）。
    this._ensureAssistant();
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
      // resume 回放去重：按 tool_use_id 判定。历史重放的 tool_result 与 [TOOL_RESULT] 实时结果
      // 共用 _seenToolResultIds；本条全部 id 都已 push 过则跳过，避免重复 tool_result 卡片。
      const ids = this._toolResultIdsOf(content);
      if (ids.length > 0 && ids.every((id) => this._seenToolResultIds.has(id))) return;
      for (const id of ids) this._seenToolResultIds.add(id);
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
    // resume 回放去重：同一 tool_use_id 的结果只 push 一次（实时 [TOOL_RESULT] 与历史重放共用判据）。
    if (this._seenToolResultIds.has(block.tool_use_id)) return;
    this._seenToolResultIds.add(block.tool_use_id);
    const raw = { type: 'user', message: { content: [block] } };
    this.messages.push({ type: 'user', content: '[tool_result]', timestamp: Date.now(), raw });
    this._pushMessages();
  }

  /** 提取一条消息 content 数组里所有 tool_result 的 tool_use_id。 */
  _toolResultIdsOf(content) {
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b && b.type === 'tool_result' && b.tool_use_id).map((b) => b.tool_use_id);
  }

  /** 历史消息里是否已存在某个 tool_use id（用于识别 resume 重放的历史 assistant）。 */
  _toolUseIdExists(id) {
    for (const m of this.messages) {
      if (m.type !== 'assistant' || !m.raw || !m.raw.message) continue;
      const c = m.raw.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_use' && b.id === id)) return true;
    }
    return false;
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
