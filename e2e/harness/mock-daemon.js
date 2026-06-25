'use strict';

/**
 * Mock daemon —— 测试用「通讯仿真器」。
 *
 * 它仿真的是 HBuilderX 插件**宿主侧**（lib/message-router.js + lib/claude-session.js）：
 *   - 复用**真实**的 ClaudeSessionAssembler（装配 window.* 回调）
 *   - 复用**真实**的 stream-adapter.processOutputLine（解析 [TAG] 行）
 *   - 仿真 message-router.bootstrap() 的初始下发 + dispatch() 的出站事件应答子集
 *
 * 与真实宿主的唯一区别：daemon 的 stdout（[STREAM_START]/[CONTENT_DELTA]/...）
 * 由测试脚本化 feed，而非真实 Claude。心跳（onStreamingHeartbeat）由测试按
 * message-router.js 的 10s 节奏手动触发（emitHeartbeat），以便配合 page.clock 做确定性时间推进。
 *
 * 出站/入站传输由 fixtures.js 用 Playwright 的 exposeFunction/evaluate 接到页面。
 * 本类只关心「收到 (event, content) 做什么」「要 callJs 什么」。
 */

const path = require('path');
const { ClaudeSessionAssembler } = require('../../hbuilderx-plugin/lib/claude-session');
const { processOutputLine } = require('../../hbuilderx-plugin/lib/stream-adapter');

class MockDaemon {
  /**
   * @param {(fn: string, args: any[]) => Promise<void>} deliver 把一次 callJs 投递到页面（异步、需保序）
   * @param {object} [opts]
   * @param {string} [opts.model] 当前模型（决定上下文窗口）
   * @param {string} [opts.permissionMode]
   * @param {string} [opts.projectName]
   */
  constructor(deliver, opts) {
    const o = opts || {};
    this._deliver = deliver;
    this._chain = Promise.resolve(); // 保序投递链
    this.model = o.model || 'claude-opus-4-8';
    this.permissionMode = o.permissionMode || 'bypassPermissions';
    this.projectName = o.projectName || 'demo-project';
    this.projectPath = o.projectPath || 'D:/demo/demo-project';
    this.sessionId = '';

    // 出站事件日志（测试可断言「前端发了哪些事件」）
    this.outbound = [];
    // send_message 等待队列（测试 await daemon.waitForOutbound('send_message')）
    this._waiters = [];

    // jsTarget：真实装配器通过它 callJs → 我们投递到页面
    const jsTarget = { callJs: (fn, ...args) => this._callJs(fn, args) };
    this.assembler = new ClaudeSessionAssembler(jsTarget, { appendLine() {} });
    this.assembler.setModel(this.model);

    // stream-adapter 的可变状态容器
    this._streamState = {};
  }

  /** 入站到页面的一次回调（保序、异步）。 */
  _callJs(fn, args) {
    this._chain = this._chain.then(() => this._deliver(fn, args)).catch(() => {});
    return this._chain;
  }

  /** 等待此前所有 callJs 都已投递到页面（断言前调用）。 */
  flush() {
    return this._chain;
  }

  // ===================== 宿主 → 前端：初始下发 =====================

  /**
   * 仿真 message-router.init() 末尾 + bootstrap() 的初始下发，使聊天界面可用。
   * 最关键：updateDependencyStatus 必须报 claude-sdk=installed，否则输入框被门槛挡住
   * （useUsageTracking.isSdkInstalled / useMessageSender 发送门槛）。
   */
  async bootstrap() {
    // Node 环境就绪（init 中下发）
    this._callJs('nodeEnvironmentStatus', [JSON.stringify({ available: true, version: 20, path: 'node' })]);
    // SDK 安装状态：claude-sdk 已装（形态对齐 dependency-service.getStatus）
    this._callJs('updateDependencyStatus', [JSON.stringify(this._dependencyStatus())]);
    // 权限模式 / 模型
    this._callJs('onModeReceived', [this.permissionMode]);
    this._callJs('onModelChanged', [this.model]);
    this._callJs('onModelConfirmed', [this.model, 'claude']);
    // Provider 列表（含两张合成卡片）+ 激活项
    const providers = this._providerList();
    this._callJs('updateProviders', [JSON.stringify(providers)]);
    // 斜杠命令（内置）
    this._callJs('updateSlashCommands', [JSON.stringify(this._builtinSlashCommands())]);
    // 顶部项目名
    this._callJs('onProjectChanged', [JSON.stringify({ name: this.projectName, path: this.projectPath })]);
    await this.flush();
  }

  _dependencyStatus() {
    return {
      'claude-sdk': {
        id: 'claude-sdk', name: 'Claude Code SDK', status: 'installed',
        installedVersion: '0.2.88', installPath: '/mock/.codemoss/dependencies/claude-sdk', hasUpdate: false,
      },
      'codex-sdk': { id: 'codex-sdk', name: 'Codex SDK', status: 'not_installed', hasUpdate: false },
    };
  }

  _providerList() {
    return [
      { id: '__local_settings_json__', name: 'Local settings.json', isActive: true, isLocalProvider: true },
      { id: '__cli_login__', name: 'CLI Login', isActive: false, isCliLoginProvider: true },
    ];
  }

  _builtinSlashCommands() {
    const c = (name, description) => ({ name, description, source: 'builtin' });
    return [
      c('/init', '为代码库生成 CLAUDE.md'), c('/review', '审查代码改动'),
      c('/compact', '压缩当前对话上下文'), c('/clear', '清空当前会话'),
      c('/model', '切换模型'), c('/help', '查看帮助'),
    ];
  }

  // ===================== 前端 → 宿主：出站事件应答 =====================

  /**
   * 处理一次出站事件（payload 形如 "event:content"，已由 fixtures 切分）。
   * 仿真 message-router.dispatch 的「让 UI 不卡 + 测试需要」的子集。
   */
  handleOutbound(event, content) {
    this.outbound.push({ event, content });
    this._resolveWaiters(event, content);

    switch (event) {
      // —— 前端 settingsBootstrap / 启动时主动拉取，回稳态默认值 ——
      case 'get_dependency_status':
        this._callJs('updateDependencyStatus', [JSON.stringify(this._dependencyStatus())]);
        break;
      case 'check_node_environment':
        this._callJs('nodeEnvironmentStatus', [JSON.stringify({ available: true, version: 20, path: 'node' })]);
        break;
      case 'get_active_provider':
        this._callJs('updateProviders', [JSON.stringify(this._providerList())]);
        break;
      case 'get_providers':
        this._callJs('updateProviders', [JSON.stringify(this._providerList())]);
        break;
      case 'get_mode':
        this._callJs('onModeReceived', [this.permissionMode]);
        break;
      case 'request_project':
      case 'get_project_info':
        this._callJs('onProjectChanged', [JSON.stringify({ name: this.projectName, path: this.projectPath })]);
        this._callJs('updateProjectInfo', [JSON.stringify({ name: this.projectName, path: this.projectPath, available: true })]);
        break;
      case 'refresh_slash_commands':
        this._callJs('updateSlashCommands', [JSON.stringify(this._builtinSlashCommands())]);
        break;
      // get_streaming_enabled / get_send_shortcut / get_thinking_enabled 等：
      // 真实 message-router 也未处理（前端有默认值），无需应答。
      case 'send_message':
      case 'send_message_with_attachments':
        this._onSend(content);
        break;
      case 'set_model':
        this.model = content || this.model;
        this.assembler.setModel(this.model);
        this._callJs('onModelConfirmed', [this.model, 'claude']);
        break;
      case 'set_mode':
        this.permissionMode = content || this.permissionMode;
        this._callJs('onModeChanged', [this.permissionMode]);
        break;
      case 'interrupt_session':
        // 仿真中止：直接结束本轮
        this.assembler.onComplete();
        break;
      default:
        // 其余事件测试不关心
        break;
    }
  }

  /** 收到 send_message：仿真 router 的 addUserMessage（本地回显），随后由测试脚本化 feed 流。 */
  _onSend(content) {
    let payload = {};
    try { payload = JSON.parse(content); } catch (e) { payload = { text: content }; }
    const text = payload.text || '';
    if (payload.permissionMode) this.permissionMode = payload.permissionMode;
    this.assembler.addUserMessage(text);
    this._lastSendText = text;
  }

  // ===================== 脚本化回放 daemon stdout =====================

  /**
   * 把若干行原始 daemon 输出喂进真实 stream-adapter → assembler。
   * 行格式见 stream-adapter.js（[STREAM_START] / [CONTENT_DELTA] "x" / [MESSAGE] {...} / [STREAM_END] 等）。
   * @param {string[]} lines
   */
  async feedLines(lines) {
    for (const line of lines) {
      processOutputLine(line, (type, p) => {
        if (type === 'session_id') this.sessionId = p;
        this.assembler.onEvent(type, p);
      }, this._streamState);
    }
    await this.flush();
  }

  /** 心跳（仿真 message-router 的 10s 周期）：刷新前端 __lastStreamActivityAt，阻止 stall 看门狗误判。 */
  async emitHeartbeat() {
    this._callJs('onStreamingHeartbeat', []);
    await this.flush();
  }

  /** 本轮兜底完成（对应 router 的 onComplete）。 */
  async complete() {
    this.assembler.onComplete();
    await this.flush();
  }

  // ===================== 测试辅助：等待出站事件 =====================

  /** 等待某出站事件出现（返回其 content）。已发生过则立即 resolve。 */
  waitForOutbound(event, timeoutMs) {
    const existing = this.outbound.find((o) => o.event === event);
    if (existing) return Promise.resolve(existing.content);
    return new Promise((resolve, reject) => {
      const w = { event, resolve };
      this._waiters.push(w);
      if (timeoutMs) {
        setTimeout(() => {
          const i = this._waiters.indexOf(w);
          if (i >= 0) { this._waiters.splice(i, 1); reject(new Error(`等待出站事件 ${event} 超时(${timeoutMs}ms)`)); }
        }, timeoutMs);
      }
    });
  }

  _resolveWaiters(event, content) {
    for (let i = this._waiters.length - 1; i >= 0; i--) {
      if (this._waiters[i].event === event) {
        const w = this._waiters.splice(i, 1)[0];
        w.resolve(content);
      }
    }
  }
}

// ===================== 常用场景的脚本化构造器 =====================

/** content_delta 行需要 JSON 字符串载荷（带前导空格），见 stream-adapter.decodeJsonStringPayload。 */
function contentDelta(text) { return `[CONTENT_DELTA] ${JSON.stringify(text)}`; }
function thinkingDelta(text) { return `[THINKING_DELTA] ${JSON.stringify(text)}`; }
function sessionId(id) { return `[SESSION_ID] ${id}`; }
function usage(obj) { return `[USAGE] ${JSON.stringify(obj)}`; }
function toolUseMessage(id, name, input) {
  return `[MESSAGE] ${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: input || {} }] } })}`;
}
function toolResult(toolUseId, contentText) {
  return `[TOOL_RESULT] ${JSON.stringify({ type: 'tool_result', tool_use_id: toolUseId, content: contentText || '' })}`;
}

const Lines = {
  STREAM_START: '[STREAM_START]',
  STREAM_END: '[STREAM_END]',
  BLOCK_RESET: '[BLOCK_RESET]',
  contentDelta, thinkingDelta, sessionId, usage, toolUseMessage, toolResult,
};

module.exports = { MockDaemon, Lines };
