'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectNode } = require('./node-detector');
const { AiBridgeClient } = require('./ai-bridge-client');
const { processOutputLine } = require('./stream-adapter');
const { ClaudeSessionAssembler } = require('./claude-session');
const { PermissionBridge } = require('./permission-bridge');
const prefs = require('./prefs');

/**
 * 事件路由：把 webview 出站事件映射到 ai-bridge 调用，并把流式结果回灌前端。
 * 移植自 src/.../handler/core/MessageDispatcher + 各 handler + SessionLifecycleManager 的 MVP 子集。
 */
class MessageRouter {
  /**
   * @param {object} hx require('hbuilderx')
   * @param {{ callJs: (fn: string, ...args: any[]) => void }} bridge
   * @param {{ appendLine: (s: string) => void }} output
   */
  constructor(hx, bridge, output) {
    this.hx = hx;
    this.bridge = bridge;
    this.output = output || { appendLine() {} };

    this.assembler = new ClaudeSessionAssembler(bridge, output);
    this.permission = new PermissionBridge(bridge, output);
    this.aiBridge = null;
    this.nodeInfo = null;

    // 持久化偏好恢复（重启后保留上次选择），优先级：pref.json > 配置/默认
    this._prefs = prefs.load(hx);
    this.sessionId = '';
    this.provider = this._prefs.provider || 'claude';
    this.model = this._prefs.model || '';
    this.permissionMode = this._prefs.permissionMode || this._readPermissionMode();
    this.cwd = ''; // getWorkspaceFolders() 是异步的，构造里拿不到，改在 init()/发送前 await 解析
    this._busy = false;

    // Provider 管理（cc-switch 兼容）：列表 + 当前激活 id，持久化在 pref.json
    this.providers = Array.isArray(this._prefs.providers) ? this._prefs.providers : [];
    this.activeProviderId = this._prefs.activeProviderId || '';
  }

  /** 当前激活的 provider 配置（无则 null）。 */
  _activeProvider() {
    return this.providers.find((p) => p.id === this.activeProviderId) || null;
  }

  /**
   * 激活 provider 要发送的具体模型 id。
   * 因 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 时 CLI 用宿主下发的 model，而非 settings 里的别名映射，
   * 故这里取 provider env 里的具体模型（优先 ANTHROPIC_MODEL，否则 sonnet/opus/haiku 映射），
   * 使 DeepSeek 等第三方端点收到它认识的模型 id（如 deepseek-v4-pro[1m]）。
   */
  _activeProviderModel() {
    const p = this._activeProvider();
    const env = (p && p.settingsConfig && p.settingsConfig.env) || {};
    if (typeof env !== 'object') return '';
    return String(
      env.ANTHROPIC_MODEL
      || env.ANTHROPIC_DEFAULT_SONNET_MODEL
      || env.ANTHROPIC_DEFAULT_OPUS_MODEL
      || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      || ''
    );
  }

  /**
   * 把 provider 列表与激活项写入 ~/.codemoss/config.json（claude.providers + claude.current）。
   * 这是 ai-bridge setupApiKey()/getClaudeRuntimeState() 读取 key/baseURL 的真正来源，
   * 从而完全不依赖、不改写用户的 ~/.claude/settings.json。
   */
  _syncCodemossConfig() {
    try {
      const file = path.join(os.homedir(), '.codemoss', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let config = {};
      try { config = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch (e) { config = {}; }
      const providersMap = {};
      for (const p of this.providers) providersMap[p.id] = p;
      config.claude = Object.assign({}, config.claude, {
        providers: providersMap,
        current: this.activeProviderId || null,
      });
      fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
      this.output.appendLine(`[router] 写入 ~/.codemoss/config.json 失败: ${e && e.message}`);
    }
  }

  /** 带 isActive 标记的列表（前端 updateProviders 依赖 isActive 判定当前项）。 */
  _providerListForUi() {
    return this.providers.map((p) => ({ ...p, isActive: p.id === this.activeProviderId }));
  }

  _emitProviders() {
    this.bridge.callJs('updateProviders', JSON.stringify(this._providerListForUi()));
    const active = this._activeProvider();
    if (active) {
      this.bridge.callJs('updateActiveProvider', JSON.stringify({ ...active, isActive: true }));
    }
  }

  _persistProviders() {
    this._persist({ providers: this.providers, activeProviderId: this.activeProviderId });
    // 同步到 ai-bridge 读取的 ~/.codemoss/config.json（setupApiKey 每次发送都会重新读取，故无需重启 daemon）
    this._syncCodemossConfig();
  }

  _persist(partial) {
    Object.assign(this._prefs, partial);
    prefs.save(this.hx, partial);
  }

  /**
   * 计算 SDK 安装状态（文件系统检查 ~/.codemoss/dependencies）。
   * 形态对齐前端 updateDependencyStatus 期望：{ 'claude-sdk': {id,name,status,installedVersion?,hasUpdate}, 'codex-sdk': {...} }
   */
  _dependencyStatusPayload() {
    const base = path.join(os.homedir(), '.codemoss', 'dependencies');
    const check = (sdkId, pkg, name) => {
      const dir = path.join(base, sdkId, 'node_modules', ...pkg.split('/'));
      const entry = { id: sdkId, name, status: 'not_installed', hasUpdate: false };
      try {
        if (fs.existsSync(dir)) {
          entry.status = 'installed';
          try {
            entry.installedVersion = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version;
          } catch (e) { /* 版本读不到不影响 installed 判定 */ }
        }
      } catch (e) { /* ignore */ }
      return entry;
    };
    return {
      'claude-sdk': check('claude-sdk', '@anthropic-ai/claude-agent-sdk', 'Claude Code SDK'),
      'codex-sdk': check('codex-sdk', '@openai/codex-sdk', 'Codex SDK'),
    };
  }

  /** 内置 Claude Code 斜杠命令（即时填充 `/` 菜单；真实/技能命令在首次发送的 system 消息里刷新）。 */
  _builtinSlashCommands() {
    const c = (name, description) => ({ name, description, source: 'builtin' });
    return [
      c('/init', '为代码库生成 CLAUDE.md'),
      c('/review', '审查代码改动'),
      c('/compact', '压缩当前对话上下文'),
      c('/clear', '清空当前会话'),
      c('/context', '查看上下文占用'),
      c('/model', '切换模型'),
      c('/agents', '管理 Agent'),
      c('/memory', '编辑记忆文件'),
      c('/cost', '查看本次用量与花费'),
      c('/help', '查看帮助'),
    ];
  }

  _readPermissionMode() {
    try {
      const v = this.hx.workspace.getConfiguration().get('ccgui.permissionMode');
      return typeof v === 'string' && v ? v : 'askAlways';
    } catch (e) { return 'askAlways'; }
  }

  /**
   * 解析当前项目根目录作为发送时的 cwd。
   * 注意：hx.workspace.getWorkspaceFolders() 返回 Promise（见 HBuilderX 文档），必须 await；
   * WorkspaceFolder.uri 可能是字符串路径或 Uri 对象。
   */
  async _resolveCwd() {
    try {
      let folders = this.hx.workspace.getWorkspaceFolders();
      if (folders && typeof folders.then === 'function') folders = await folders;
      if (Array.isArray(folders) && folders.length > 0) {
        const uri = folders[0].uri;
        if (uri && typeof uri === 'object' && uri.fsPath) return uri.fsPath;
        if (typeof uri === 'string') return uri;
        if (folders[0].fsPath) return folders[0].fsPath;
        if (folders[0].path) return folders[0].path;
      }
    } catch (e) {
      this.output.appendLine(`[router] 解析 cwd 失败: ${e && e.message}`);
    }
    return '';
  }

  /** 启动：探测 Node、拉起 ai-bridge daemon。 */
  async init() {
    // 解析项目 cwd（异步）
    this.cwd = await this._resolveCwd();
    this.output.appendLine(`[router] cwd=${this.cwd || '(empty!)'}`);

    const config = (() => { try { return this.hx.workspace.getConfiguration(); } catch (e) { return null; } })();
    // 优先 HBuilderX 内置 Node（process.execPath），见 node-detector 优先级说明
    this.nodeInfo = detectNode(config, { execPath: process.execPath });
    if (!this.nodeInfo) {
      this.output.appendLine('[router] 未找到可用 Node.js，无法启动 ai-bridge');
      this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify({ installed: false, error: 'Node.js not found' }));
      return;
    }
    this.output.appendLine(`[router] 使用 Node: ${this.nodeInfo.path} (v${this.nodeInfo.major}, 来源=${this.nodeInfo.source})`);
    if (this.nodeInfo.belowMin) {
      // 内置/可用 Node < 18：SDK（engines>=18，且无全局 fetch）很可能无法运行
      const warn = `当前 Node v${this.nodeInfo.major}(${this.nodeInfo.source}) 低于 Claude/Codex SDK 要求的 v18，可能无法正常工作。`
        + `请在 设置 → 插件配置 → CC GUI → nodePath 指定一个 ≥18 的 Node，或安装系统 Node 18+。`;
      this.output.appendLine(`[router] 警告: ${warn}`);
      this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify({ installed: true, version: this.nodeInfo.major, path: this.nodeInfo.path, belowMin: true, error: warn }));
    } else {
      this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify({ installed: true, version: this.nodeInfo.major, path: this.nodeInfo.path }));
    }

    // 权限桥接 env 必须在 spawn 前注入；provider 的 key/baseURL 走 ~/.codemoss/config.json（setupApiKey 每次发送读取）
    this.aiBridge = new AiBridgeClient(this.nodeInfo.path, this.output, undefined, this.permission.env());
    // 启动时同步一次 provider 配置到 ~/.codemoss/config.json
    this._syncCodemossConfig();
    try {
      await this.aiBridge.start();
      this.permission.start();
    } catch (err) {
      this.output.appendLine(`[router] ai-bridge 启动失败: ${err && err.message}`);
      this.bridge.callJs('addErrorMessage', `ai-bridge 启动失败: ${err && err.message}`);
    }
  }

  /** 启动后向前端推送初始状态，使聊天界面可用。 */
  bootstrap() {
    // SDK 安装状态（不发则前端一直停在 "checking SDK status"）
    this.bridge.callJs('updateDependencyStatus', JSON.stringify(this._dependencyStatusPayload()));
    // 恢复持久化的 mode / model 到前端
    // 注意：不调用 updateActiveProvider —— 它期望完整 provider 配置对象（属阶段 3），
    // 传裸字符串会触发前端 JSON.parse 失败。前端 currentProvider 默认即 'claude'。
    this.bridge.callJs('onModeReceived', this.permissionMode);
    if (this.model) {
      this.bridge.callJs('onModelChanged', this.model);
      this.bridge.callJs('onModelConfirmed', this.model, this.provider);
    }
    // Provider 列表 + 激活项（settingsBootstrap 启动时会请求）
    this._emitProviders();
    // 即时填充斜杠命令菜单（首次发送后由 system 消息刷新为真实/技能命令）
    this.bridge.callJs('updateSlashCommands', JSON.stringify(this._builtinSlashCommands()));
  }

  /** 出站事件分发器（注册到 BridgeHost.onEvent）。 */
  dispatch(event, content) {
    switch (event) {
      case 'send_message':
        this._handleSend(content);
        break;
      case 'create_new_session':
        this._handleNewSession();
        break;
      case 'load_session':
        this._handleLoadSession(content);
        break;
      case 'interrupt_session':
        if (this.aiBridge) this.aiBridge.abort();
        break;
      case 'set_model':
        this.model = content || '';
        this._persist({ model: this.model });
        this.bridge.callJs('onModelConfirmed', this.model, this.provider);
        break;
      case 'set_mode':
        this.permissionMode = content || this.permissionMode;
        this._persist({ permissionMode: this.permissionMode });
        this.bridge.callJs('onModeChanged', this.permissionMode);
        break;
      case 'set_provider':
        this.provider = content || this.provider;
        this._persist({ provider: this.provider });
        // 不回显 updateActiveProvider（见 bootstrap 说明）；仅用于路由 this.provider
        break;
      case 'permission_decision':
        this.permission.handlePermissionDecision(content);
        break;
      case 'ask_user_question_response':
        this.permission.handleAskUserQuestionResponse(content);
        break;
      case 'plan_approval_response':
        this.permission.handlePlanApprovalResponse(content);
        break;
      case 'get_dependency_status':
        this.bridge.callJs('updateDependencyStatus', JSON.stringify(this._dependencyStatusPayload()));
        break;
      case 'get_prompts': {
        // 自定义 prompt 列表（/ 自动补全）。阶段 3 接入真实存储，先回空避免前端等待。
        let type = '';
        try { type = (JSON.parse(content) || {}).type || ''; } catch (e) { /* ignore */ }
        if (type === 'project') this.bridge.callJs('updateProjectPrompts', '[]');
        else if (type === 'global') this.bridge.callJs('updateGlobalPrompts', '[]');
        else { this.bridge.callJs('updateGlobalPrompts', '[]'); this.bridge.callJs('updateProjectPrompts', '[]'); }
        break;
      }
      // ===== Provider 管理（cc-switch 兼容）=====
      case 'get_providers':
        this._emitProviders();
        break;
      case 'get_active_provider': {
        const active = this._activeProvider();
        if (active) this.bridge.callJs('updateActiveProvider', JSON.stringify({ ...active, isActive: true }));
        break;
      }
      case 'add_provider': {
        let p;
        try { p = JSON.parse(content); } catch (e) { break; }
        if (!p || !p.id) break;
        p.createdAt = p.createdAt || Date.now();
        this.providers.push(p);
        this._persistProviders();
        this._emitProviders();
        break;
      }
      case 'update_provider': {
        let d;
        try { d = JSON.parse(content); } catch (e) { break; }
        const i = this.providers.findIndex((x) => x.id === (d && d.id));
        if (i === -1) break;
        this.providers[i] = { ...this.providers[i], ...(d.updates || {}) };
        this._persistProviders();
        this._emitProviders();
        break;
      }
      case 'delete_provider': {
        let d;
        try { d = JSON.parse(content); } catch (e) { break; }
        const wasActive = d && d.id === this.activeProviderId;
        this.providers = this.providers.filter((x) => x.id !== (d && d.id));
        if (wasActive) this.activeProviderId = '';
        this._persistProviders();
        this._emitProviders();
        break;
      }
      case 'switch_provider': {
        let d;
        try { d = JSON.parse(content); } catch (e) { break; }
        this.activeProviderId = (d && d.id) || '';
        this._persistProviders();
        this._emitProviders();
        break;
      }
      case 'sort_providers': {
        let d;
        try { d = JSON.parse(content); } catch (e) { break; }
        const order = (d && d.orderedIds) || [];
        if (Array.isArray(order) && order.length) {
          const byId = new Map(this.providers.map((p) => [p.id, p]));
          const reordered = order.map((id) => byId.get(id)).filter(Boolean);
          for (const p of this.providers) if (!order.includes(p.id)) reordered.push(p);
          this.providers = reordered;
          this._persistProviders();
          this._emitProviders();
        }
        break;
      }
      case 'refresh_slash_commands':
        this.bridge.callJs('updateSlashCommands', JSON.stringify(this._builtinSlashCommands()));
        break;
      case 'get_all_skills':
        // 技能面板：阶段 3 接入 .claude/skills 读取，先回空避免前端等待
        this.bridge.callJs('updateSkills', JSON.stringify([]));
        break;
      case 'check_node_environment':
        this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(
          this.nodeInfo
            ? { installed: true, version: this.nodeInfo.major, path: this.nodeInfo.path }
            : { installed: false, error: 'Node.js not found' }
        ));
        break;
      default:
        // 其余事件（设置面板、文件操作、历史等）留待后续阶段
        this.output.appendLine(`[router] 暂未处理: ${event}`);
    }
  }

  _handleNewSession() {
    this.sessionId = '';
    this.assembler.reset();
    this.bridge.callJs('clearMessages');
  }

  /**
   * 恢复指定会话（按 id 续聊）。
   * MVP：仅设置 sessionId 使后续消息在服务端续上该会话；不在 UI 重放历史消息
   *（历史重放 UI 依赖 getSession 原始 JSONL -> 前端消息格式的转换，属阶段 3）。
   */
  _handleLoadSession(content) {
    let sessionId = content;
    try {
      const obj = JSON.parse(content);
      sessionId = obj.sessionId || obj.id || content;
    } catch (e) { /* content 即为 sessionId */ }
    if (!sessionId) return;
    this.sessionId = sessionId;
    this.assembler.reset();
    this.bridge.callJs('clearMessages');
    this.bridge.callJs('setSessionId', sessionId);
    this.bridge.callJs('historyLoadComplete');
    this.output.appendLine(`[router] 恢复会话: ${sessionId}（UI 不重放历史，续聊生效）`);
  }

  async _handleSend(content) {
    if (!this.aiBridge) {
      this.bridge.callJs('addErrorMessage', 'ai-bridge 未就绪');
      return;
    }
    if (this._busy) {
      this.output.appendLine('[router] 上一条消息仍在进行，忽略本次发送');
      return;
    }

    let payload = {};
    try { payload = JSON.parse(content); } catch (e) { payload = { text: content }; }
    const text = payload.text || '';
    if (!text.trim()) return;

    // 兜底：若 init 时还没有打开项目，发送前再解析一次 cwd
    if (!this.cwd) {
      this.cwd = await this._resolveCwd();
    }

    this.assembler.addUserMessage(text);

    const params = {
      message: text,
      sessionId: this.sessionId || '',
      cwd: this.cwd,
      permissionMode: payload.permissionMode || this.permissionMode,
      // 激活 provider 指定了主模型（如 DeepSeek 的 ANTHROPIC_MODEL）时优先用它；否则用 UI 选择
      model: this._activeProviderModel() || this.model || '',
      openedFiles: null,
      agentPrompt: (payload.agent && payload.agent.prompt) || null,
      streaming: true,
      disableThinking: false,
      reasoningEffort: payload.reasoningEffort || null,
    };

    const state = {};
    const onLine = (line) => {
      try {
        processOutputLine(line, (type, p) => {
          if (type === 'session_id') this.sessionId = p;
          this.assembler.onEvent(type, p);
        }, state);
      } catch (err) {
        this.output.appendLine(`[router] 行解析异常: ${err && err.message}`);
      }
    };

    this.output.appendLine(`[router] send: model=${params.model || '(default)'} mode=${params.permissionMode} cwd=${params.cwd || '(empty!)'}`);
    this._busy = true;
    try {
      const result = await this.aiBridge.request('claude.send', params, onLine);
      this.output.appendLine(`[router] send 完成: success=${result.success} error=${result.error || '(none)'} lastNodeError=${state.lastNodeError || '(none)'}`);
      if (!result.success && !state.hadSendError) {
        this.assembler.onError(result.error || state.lastNodeError || 'Unknown error');
      } else {
        this.assembler.onComplete();
      }
    } catch (err) {
      this.assembler.onError(err && err.message ? err.message : String(err));
    } finally {
      this._busy = false;
    }
  }

  dispose() {
    if (this.permission) this.permission.dispose();
    if (this.aiBridge) this.aiBridge.dispose();
  }
}

module.exports = { MessageRouter };
