'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectNode } = require('./node-detector');
const { AiBridgeClient } = require('./ai-bridge-client');
const { processOutputLine } = require('./stream-adapter');
const { ClaudeSessionAssembler } = require('./claude-session');
const { PermissionBridge } = require('./permission-bridge');
const { resolveTheme } = require('./webview-host');
const prefs = require('./prefs');
const skillsService = require('./skills-service');

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

    // 主题同步：缓存上次推送给前端的 isDark，仅在变化时主动推送，避免抖动
    this._lastIsDark = null;
    this._themeDisposable = null;
  }

  /**
   * 把选中代码片段以「文件标签」形式注入前端输入框并聚焦。
   * snippet 形如 `@<绝对路径>#L<起>-<止>` / `@<绝对路径>#L<行>` / `@<绝对路径>`。
   * addCodeSnippet 是「追加」语义，由调用方保证只调用一次。
   */
  injectCodeSnippet(snippet) {
    try {
      this.bridge.callJs('addCodeSnippet', snippet);
      this.bridge.callJs('focusChatInput');
    } catch (e) {
      this.output.appendLine(`[router] injectCodeSnippet 失败: ${e && e.message}`);
    }
  }

  /**
   * 把文件以 `@file` 引用形式注入前端输入框并聚焦。
   * pathOrArray 可为单个绝对路径字符串，或字符串数组。
   */
  injectFiles(pathOrArray) {
    try {
      this.bridge.callJs('handleFilePathFromJava', pathOrArray);
      this.bridge.callJs('focusChatInput');
    } catch (e) {
      this.output.appendLine(`[router] injectFiles 失败: ${e && e.message}`);
    }
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

    // 注册 IDE 主题变更监听，切换配色时主动推送给前端（Follow IDE 模式实时跟随）
    this._registerThemeListener();
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
      // ===== 技能面板（Skills）=====
      case 'get_all_skills':
        this._handleGetAllSkills();
        break;
      case 'import_skill':
        this._handleImportSkill(content);
        break;
      case 'toggle_skill':
        this._handleToggleSkill(content);
        break;
      case 'delete_skill':
        this._handleDeleteSkill(content);
        break;
      case 'open_skill':
        this._handleOpenSkill(content);
        break;
      case 'check_node_environment':
        this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(
          this.nodeInfo
            ? { installed: true, version: this.nodeInfo.major, path: this.nodeInfo.path }
            : { installed: false, error: 'Node.js not found' }
        ));
        break;
      // ===== 文件跳转 / 浏览器 / 路径解析 / 主题同步 =====
      case 'open_file':
        this._handleOpenFile(content);
        break;
      case 'open_browser':
        this._handleOpenBrowser(content);
        break;
      case 'resolve_file_path':
        this._handleResolveFilePath(content);
        break;
      case 'get_ide_theme':
        this._handleGetIdeTheme();
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

  // ===================== 文件跳转 / 浏览器 / 路径解析 helper =====================

  /**
   * 解析「路径 + 行号」字符串。
   * 形如 `path`、`path:line`、`path:start-end`。
   * 贪婪 `.*` 能正确处理 Windows 盘符冒号（如 `D:\a\b.ts:42` → path=`D:\a\b.ts`, line=42；
   * `D:\a\b.ts` 无尾部数字时整串视为路径、无行号）。
   * @param {string} raw
   * @returns {{ filePath: string, line: number|null, endLine: number|null }}
   */
  _parsePathWithLine(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { filePath: '', line: null, endLine: null };

    const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(s);
    if (!m) return { filePath: s, line: null, endLine: null };

    const filePath = m[1];
    // path 自身仍以 `:数字` 结尾（如 `a:1:2`，group1=`a:1`）说明不是行号语法，整串当作路径
    if (!filePath || /:\d+$/.test(filePath)) {
      return { filePath: s, line: null, endLine: null };
    }

    const line = parseInt(m[2], 10);
    const endLine = m[3] != null ? parseInt(m[3], 10) : null;
    if (!Number.isInteger(line) || line <= 0) {
      return { filePath: s, line: null, endLine: null };
    }
    if (endLine != null && (!Number.isInteger(endLine) || endLine <= 0 || endLine < line)) {
      return { filePath, line, endLine: null };
    }
    return { filePath, line, endLine };
  }

  /**
   * 把可能是相对路径的 p 解析为绝对路径。
   * 已是绝对路径则仅 normalize；否则相对 this.cwd 解析（cwd 为空时无法解析，返回 null）。
   * @param {string} p
   * @returns {string|null}
   */
  _resolveAbsPath(p) {
    if (typeof p !== 'string' || !p) return null;
    const normalized = path.normalize(p);
    if (path.isAbsolute(normalized)) return normalized;
    if (!this.cwd) return null; // 无项目根，相对路径无法可靠解析
    return path.resolve(this.cwd, normalized);
  }

  /**
   * 打开文件并（best-effort）定位行。
   * - HBuilderX API（核实自 hbuilderx-language-services 的 extension_js.d.ts 与官方文档）：
   *   `hx.window.openTextDocument(uri)` 返回 Promise<TextEditor>（同时完成打开+激活）；
   *   `editor.setSelection(active, anchor)` 接收的是「字符偏移量」（Number），不是行/列，也无 Range/Position 类；
   *   故行号需先由文档文本换算成偏移量。行号 1-based，转 0-based 行索引用 line-1。
   */
  _handleOpenFile(content) {
    try {
      const { filePath, line, endLine } = this._parsePathWithLine(content);
      const abs = this._resolveAbsPath(filePath);
      if (!abs) {
        this.output.appendLine(`[router] open_file 无法解析路径（cwd 为空？）: ${content}`);
        return;
      }
      if (!fs.existsSync(abs)) {
        this.output.appendLine(`[router] open_file 文件不存在: ${abs}`);
        return;
      }

      // window.openTextDocument 返回 TextEditor（workspace.* 只返回 TextDocument，拿不到光标控制）
      const opened = this.hx.window.openTextDocument(abs);
      Promise.resolve(opened).then((editor) => {
        if (line == null) {
          this.output.appendLine(`[router] open_file 已打开: ${abs}`);
          return;
        }
        // 定位行是 best-effort：换算字符偏移失败也不影响已打开的文件
        try {
          this._gotoLine(editor, abs, line, endLine);
        } catch (e) {
          this.output.appendLine(`[router] open_file 定位行失败（已打开文件）: ${e && e.message}`);
        }
      }).catch((e) => {
        this.output.appendLine(`[router] open_file 打开失败: ${abs} -> ${e && e.message}`);
      });
    } catch (e) {
      this.output.appendLine(`[router] open_file 异常: ${e && e.message}`);
    }
  }

  /**
   * 在 editor 上把光标/选区移动到指定行（1-based）。
   * setSelection(active, anchor) 用的是文档字符偏移量；这里由文档全文自行换算偏移，
   * 避免依赖 lineAt 行号是否 0/1-based 的不确定性。
   */
  _gotoLine(editor, abs, line, endLine) {
    if (!editor || typeof editor.setSelection !== 'function' || !editor.document) {
      this.output.appendLine(`[router] open_file 当前 API 不支持定位行，仅打开: ${abs}`);
      return;
    }
    const doc = editor.document;
    // getText 是同步 API，取整篇文本来换算偏移量
    const text = doc.getText({ start: 0, end: Number.MAX_SAFE_INTEGER }) || '';

    // 第 lineIdx 行（0-based）起始的字符偏移。用换行符感知扫描，正确处理 CRLF/CR/LF
    //（不能按「每行 +1」估算：CRLF 占 2 字符，否则会逐行漂移导致定位到错误行）。
    const lineStartOffset = (lineIdx) => {
      if (lineIdx <= 0) return 0;
      const re = /\r\n|\r|\n/g;
      let count = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        count += 1;
        if (count === lineIdx) return m.index + m[0].length;
      }
      return text.length; // 行号超出文件总行数，落到文末
    };
    // 从 startOffset 起到该行行尾（下一个换行符之前，或文末）的偏移。
    const lineEndOffset = (startOffset) => {
      const re = /\r\n|\r|\n/g;
      re.lastIndex = startOffset;
      const m = re.exec(text);
      return m ? m.index : text.length;
    };

    const startOffset = lineStartOffset(line - 1); // 1-based -> 0-based 行索引

    if (endLine != null && endLine >= line) {
      const endOffset = lineEndOffset(lineStartOffset(endLine - 1)); // 选到结束行行尾（不含换行符）
      // active=有光标的一端(行尾)，anchor=另一端(起始行首)
      editor.setSelection(endOffset, startOffset);
      this.output.appendLine(`[router] open_file 已打开并选中 ${line}-${endLine} 行: ${abs}（字符偏移 ${startOffset}-${endOffset}）`);
    } else {
      editor.setSelection(startOffset, startOffset); // 折叠光标置于行首
      this.output.appendLine(`[router] open_file 已打开并定位到第 ${line} 行: ${abs}（字符偏移 ${startOffset}）`);
    }
  }

  /** 用系统默认浏览器打开 URL（仅放行 http/https/mailto）。 */
  _handleOpenBrowser(content) {
    const url = typeof content === 'string' ? content.trim() : '';
    if (!/^(https?:|mailto:)/i.test(url)) {
      this.output.appendLine(`[router] open_browser 忽略不支持的协议: ${url}`);
      return;
    }
    try {
      const ret = this.hx.env.openExternal(url); // 返回 Promise<boolean>
      Promise.resolve(ret).catch((e) => {
        this.output.appendLine(`[router] open_browser 失败: ${url} -> ${e && e.message}`);
      });
      this.output.appendLine(`[router] open_browser: ${url}`);
    } catch (e) {
      this.output.appendLine(`[router] open_browser 异常: ${e && e.message}`);
    }
  }

  /**
   * 解析路径存在性并回调 onFilePathResolved（回调参数为 JSON 字符串）。
   * 存在且位于 cwd 之下 -> 回传工程相对路径（正斜杠）；存在但在 cwd 之外 -> 回传绝对路径；
   * 不存在 / cwd 为空无法解析 -> resolvedPath=null。`path` 字段原样回传前端发来的 content。
   */
  _handleResolveFilePath(content) {
    const original = typeof content === 'string' ? content : '';
    let resolvedPath = null;
    try {
      const { filePath } = this._parsePathWithLine(original);
      const abs = this._resolveAbsPath(filePath);
      if (abs && fs.existsSync(abs)) {
        if (this.cwd) {
          const rel = path.relative(this.cwd, abs);
          // rel 不以 .. 开头且非绝对路径 => 在 cwd 之下，回传相对路径（正斜杠便于 tooltip 展示）
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            resolvedPath = rel.replace(/\\/g, '/');
          } else {
            resolvedPath = abs;
          }
        } else {
          resolvedPath = abs;
        }
      }
    } catch (e) {
      this.output.appendLine(`[router] resolve_file_path 异常: ${e && e.message}`);
      resolvedPath = null;
    }
    try {
      this.bridge.callJs('onFilePathResolved', JSON.stringify({ path: original, resolvedPath }));
    } catch (e) {
      this.output.appendLine(`[router] resolve_file_path 回调失败: ${e && e.message}`);
    }
  }

  // ===================== 技能面板（Skills）=====================

  /** 兜底解析 cwd：init 时没打开项目，操作技能前再取一次（local 作用域依赖它）。 */
  async _ensureCwd() {
    if (!this.cwd) {
      this.cwd = await this._resolveCwd();
    }
    return this.cwd;
  }

  /**
   * get_all_skills：扫描 ~/.claude/skills（global）与 {cwd}/.claude/skills（local），
   * 含停用态（管理目录），回 SkillsConfig 形状（global/local/user/repo）。
   * 出错也回空壳形状，避免前端 Object.values(undefined) 崩溃。
   */
  async _handleGetAllSkills() {
    let payload = { global: {}, local: {}, user: {}, repo: {} };
    try {
      await this._ensureCwd();
      payload = skillsService.getAllSkills(this.cwd || '');
    } catch (e) {
      this.output.appendLine(`[router] get_all_skills 异常: ${e && e.message}`);
    }
    try {
      this.bridge.callJs('updateSkills', JSON.stringify(payload));
    } catch (e) {
      this.output.appendLine(`[router] get_all_skills 回调失败: ${e && e.message}`);
    }
  }

  /**
   * import_skill：前端只发 { scope }，由后端弹文件/目录选择框拿源路径再复制到启用目录。
   * HBuilderX 无原生 showOpenDialog，用 hx.window.showFormDialog 的 fileSelectInput 控件
   *（mode:'folder'，对齐 Agent Skills 规范「skill 是目录」）让用户选一个 skill 目录。
   * 取消/出错也回 skillImportResult，不让前端卡在 loading。
   */
  async _handleImportSkill(content) {
    let scope = 'global';
    try {
      const obj = JSON.parse(content);
      if (obj && obj.scope) scope = obj.scope;
    } catch (e) { /* content 解析失败用默认 global */ }

    const replyError = (msg) => {
      try {
        this.bridge.callJs('skillImportResult', JSON.stringify({ success: false, error: msg }));
      } catch (e) { /* ignore */ }
    };

    try {
      await this._ensureCwd();
      if (scope === 'local' && !this.cwd) {
        replyError('未打开项目，无法导入本地技能');
        return;
      }

      let selectedPath = null;
      // 优先用 showFormDialog 的 fileSelectInput（实证自 extension_js.d.ts）
      if (this.hx.window && typeof this.hx.window.showFormDialog === 'function') {
        const dialogResult = await this.hx.window.showFormDialog({
          title: '导入技能',
          subtitle: '选择一个 Skill 文件夹（应包含 SKILL.md）',
          width: 540,
          height: 220,
          submitButtonText: '导入',
          cancelButtonText: '取消',
          formItems: [
            {
              type: 'fileSelectInput',
              name: 'skillPath',
              mode: 'folder',
              label: 'Skill 文件夹',
              placeholder: '请选择 Skill 文件夹',
              value: this.cwd || '',
            },
          ],
        });
        // code === 0 视为正常提交（不同版本约定不一，data 有路径即采纳）
        const data = dialogResult && dialogResult.data;
        if (data) {
          selectedPath = typeof data === 'string'
            ? data
            : (data.skillPath || data.path || '');
        }
        if (!selectedPath) {
          // 用户取消或未选：静默回失败但不弹错误 toast（前端 success:false 仅在有 error 时提示）
          this.output.appendLine('[router] import_skill 已取消或未选择路径');
          this.bridge.callJs('skillImportResult', JSON.stringify({ success: false }));
          return;
        }
      } else {
        replyError('当前 HBuilderX 版本不支持文件选择对话框');
        return;
      }

      const result = skillsService.importSkills([selectedPath], scope, this.cwd || '');
      this.output.appendLine(`[router] import_skill: scope=${scope} count=${result.count} total=${result.total} src=${selectedPath}`);
      this.bridge.callJs('skillImportResult', JSON.stringify(result));
    } catch (e) {
      this.output.appendLine(`[router] import_skill 异常: ${e && e.message}`);
      replyError(e && e.message ? e.message : String(e));
    }
  }

  /**
   * toggle_skill：载荷 { name, scope, enabled }（enabled=当前状态）。
   * 启用/停用是目录移动，结果回 skillToggleResult（前端期望 {success, enabled, name, error?, conflict?}）。
   */
  async _handleToggleSkill(content) {
    let json = {};
    try { json = JSON.parse(content) || {}; } catch (e) { json = {}; }
    const name = json.name;
    const scope = json.scope || 'global';
    const currentEnabled = json.enabled != null ? !!json.enabled : true;

    let result;
    try {
      await this._ensureCwd();
      result = skillsService.toggleSkill(name, scope, currentEnabled, this.cwd || '');
    } catch (e) {
      this.output.appendLine(`[router] toggle_skill 异常: ${e && e.message}`);
      result = { success: false, error: e && e.message ? e.message : String(e) };
    }
    try {
      this.bridge.callJs('skillToggleResult', JSON.stringify(result));
    } catch (e) {
      this.output.appendLine(`[router] toggle_skill 回调失败: ${e && e.message}`);
    }
  }

  /**
   * delete_skill：载荷 { name, scope, enabled }。按 enabled 选启用/管理目录删除。
   * 结果回 skillDeleteResult（前端期望 {success, error?}）。
   */
  async _handleDeleteSkill(content) {
    let json = {};
    try { json = JSON.parse(content) || {}; } catch (e) { json = {}; }
    const name = json.name;
    const scope = json.scope || 'global';
    const enabled = json.enabled != null ? !!json.enabled : true;

    let result;
    try {
      await this._ensureCwd();
      result = skillsService.deleteSkill(name, scope, enabled, this.cwd || '');
    } catch (e) {
      this.output.appendLine(`[router] delete_skill 异常: ${e && e.message}`);
      result = { success: false, error: e && e.message ? e.message : String(e) };
    }
    try {
      this.bridge.callJs('skillDeleteResult', JSON.stringify(result));
    } catch (e) {
      this.output.appendLine(`[router] delete_skill 回调失败: ${e && e.message}`);
    }
  }

  /**
   * open_skill：载荷 { path }。在编辑器打开该技能；若 path 是目录则打开其 skill.md/SKILL.md。
   * 复用 open_file 的打开逻辑（this._handleOpenFile）。
   */
  _handleOpenSkill(content) {
    try {
      let skillPath = '';
      try {
        const obj = JSON.parse(content);
        skillPath = (obj && obj.path) || '';
      } catch (e) {
        skillPath = typeof content === 'string' ? content : '';
      }
      if (!skillPath) {
        this.output.appendLine('[router] open_skill 缺少 path');
        return;
      }
      // 拒绝可疑路径（路径穿越/空字节）
      if (skillPath.indexOf('..') !== -1 || skillPath.indexOf('\0') !== -1) {
        this.output.appendLine(`[router] open_skill 拒绝可疑路径: ${skillPath}`);
        return;
      }

      let targetPath = skillPath;
      // 目录则改打开其 skill.md / SKILL.md（对齐 Java handleOpenSkill）
      try {
        if (fs.existsSync(skillPath) && fs.statSync(skillPath).isDirectory()) {
          let md = path.join(skillPath, 'skill.md');
          if (!fs.existsSync(md)) md = path.join(skillPath, 'SKILL.md');
          if (fs.existsSync(md)) targetPath = md;
        }
      } catch (e) { /* 判定失败仍尝试打开原 path */ }

      // 复用 open_file 同款打开逻辑
      this._handleOpenFile(targetPath);
    } catch (e) {
      this.output.appendLine(`[router] open_skill 异常: ${e && e.message}`);
    }
  }

  // ===================== 主题同步 =====================

  /** 计算当前 IDE 是否为深色主题（复用 webview-host 的 resolveTheme）。 */
  _computeIsDark() {
    try {
      return resolveTheme(this.hx) === 'dark';
    } catch (e) {
      return false;
    }
  }

  /** 回应前端 get_ide_theme（必须及时同步回，前端 5 秒超时）。 */
  _handleGetIdeTheme() {
    try {
      const isDark = this._computeIsDark();
      this._lastIsDark = isDark; // 同步缓存，避免随后监听器重复推送同值
      this.bridge.callJs('onIdeThemeReceived', JSON.stringify({ isDark }));
    } catch (e) {
      this.output.appendLine(`[router] get_ide_theme 异常: ${e && e.message}`);
    }
  }

  /**
   * 注册配色变更监听，配色切换时主动推送 onIdeThemeChanged（仅在值变化时推送）。
   * 用 try/catch 包住，onDidChangeConfiguration / affectsConfiguration 不存在也不能崩。
   */
  _registerThemeListener() {
    try {
      if (this._lastIsDark == null) this._lastIsDark = this._computeIsDark();
      if (!this.hx.workspace || typeof this.hx.workspace.onDidChangeConfiguration !== 'function') {
        this.output.appendLine('[router] 当前 API 无 onDidChangeConfiguration，主题变更不主动推送');
        return;
      }
      this._themeDisposable = this.hx.workspace.onDidChangeConfiguration((event) => {
        try {
          // affectsConfiguration 可能不存在；存在时仅在影响到 editor.colorScheme 时才重算，
          // 不存在时无法判断范围，保守起见每次都重算（仍受「值变化才推送」节流保护）
          const affects = event && typeof event.affectsConfiguration === 'function';
          if (affects && !event.affectsConfiguration('editor.colorScheme')) return;

          const isDark = this._computeIsDark();
          if (isDark !== this._lastIsDark) {
            this._lastIsDark = isDark;
            this.bridge.callJs('onIdeThemeChanged', JSON.stringify({ isDark }));
            this.output.appendLine(`[router] IDE 主题变更 -> isDark=${isDark}`);
          }
        } catch (e) {
          this.output.appendLine(`[router] 主题变更处理异常: ${e && e.message}`);
        }
      });
    } catch (e) {
      this.output.appendLine(`[router] 注册主题监听失败: ${e && e.message}`);
    }
  }

  dispose() {
    if (this.permission) this.permission.dispose();
    if (this.aiBridge) this.aiBridge.dispose();
    if (this._themeDisposable && this._themeDisposable.dispose) this._themeDisposable.dispose();
  }
}

module.exports = { MessageRouter };
