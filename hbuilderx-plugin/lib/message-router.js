'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectNode, resetCache: resetNodeCache } = require('./node-detector');
const { AiBridgeClient } = require('./ai-bridge-client');
const { processOutputLine } = require('./stream-adapter');
const { ClaudeSessionAssembler } = require('./claude-session');
const { PermissionBridge } = require('./permission-bridge');
const { resolveTheme } = require('./webview-host');
const prefs = require('./prefs');
const skillsService = require('./skills-service');
const historyService = require('./history-service');
const agentService = require('./agent-service');
const mcpService = require('./mcp-service');
const dependencyService = require('./dependency-service');

// ===== @文件补全（list_files）扫描参数 =====
// 对齐 IDEA 版 FileSystemCollector 的硬编码跳过集 / 上限（含递归深度与单目录子项数）。
const LIST_FILES_MAX_RESULTS = 200;
const LIST_FILES_MAX_DEPTH = 15;
const LIST_FILES_MAX_CHILDREN = 100;
const LIST_FILES_SKIP_DIRS = new Set([
  // 版本控制
  '.git', '.svn', '.hg', '.bzr',
  // 包管理 / 依赖缓存
  'node_modules', '__pycache__', '.pnpm', 'bower_components',
  '.m2', '.gradle', '.ivy2', '.sbt', '.coursier',
  '.npm', '.yarn', '.pnpm-store', '.cargo', '.rustup',
  '.pub-cache', '.gem', '.bundle', '.composer', '.nuget',
  '.cache', '.local',
  // 构建产物
  'target', 'build', 'dist', 'out', 'output', 'bin', 'obj',
  // IDE / 编辑器配置
  '.idea', '.vscode', '.vs', '.eclipse', '.settings',
  // 虚拟环境
  'venv', '.venv', 'env', '.env', 'virtualenv',
  // 测试 / 覆盖率
  'coverage', '.nyc_output', '.pytest_cache', '__snapshots__',
  // 临时 / 日志
  'tmp', 'temp', 'logs', '.tmp', '.temp',
]);
const LIST_FILES_SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// ===== 特殊伪 provider id（不存于 providers 列表，代表运行模式而非具体供应商）=====
// 与 webview SPECIAL_PROVIDER_IDS / IDEA ProviderManager / ai-bridge api-config 三方保持一致。
const DISABLED_PROVIDER_ID = '__disabled__';
const LOCAL_SETTINGS_PROVIDER_ID = '__local_settings_json__';
const CLI_LOGIN_PROVIDER_ID = '__cli_login__';

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
    this.projectName = ''; // 当前会话所属项目名（HBuilderX 可同时打开多个项目，顶部会话名后展示）
    this._busy = false;

    // 历史面板当前 provider（前端在 load_history_data/deep_search_history 时下发，后续 load/delete/export 沿用）
    this._historyProvider = 'claude';

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

  /**
   * 带 isActive 标记的列表（前端 updateProviders 依赖 isActive 判定当前项）。
   * 必须注入「本地 settings.json / 使用 CLI 登录信息」两张合成卡片（对齐 IDEA ProviderManager
   * .getClaudeProviders 的 createLocalProviderObject/createCliLoginProviderObject）——它们是伪 provider，
   * 不在 this.providers 里，但前端那两张特殊卡片靠列表中同 id 项的 isActive 来点亮「已启用」。
   * 缺了它们，点「授权并启用」后卡片永远停在未启用态，表现为「点了没反应」。
   */
  _providerListForUi() {
    const list = this.providers.map((p) => ({ ...p, isActive: p.id === this.activeProviderId }));
    list.unshift(
      { id: LOCAL_SETTINGS_PROVIDER_ID, name: 'Local settings.json', isActive: this.activeProviderId === LOCAL_SETTINGS_PROVIDER_ID, isLocalProvider: true },
      { id: CLI_LOGIN_PROVIDER_ID, name: 'CLI Login', isActive: this.activeProviderId === CLI_LOGIN_PROVIDER_ID, isCliLoginProvider: true },
    );
    return list;
  }

  _emitProviders() {
    const list = this._providerListForUi();
    this.bridge.callJs('updateProviders', JSON.stringify(list));
    const active = list.find((p) => p.isActive);
    if (active) {
      this.bridge.callJs('updateActiveProvider', JSON.stringify(active));
    }
    // CLI 登录模式：回显账号邮箱（前端 ProviderList 仅在该卡片激活时显示）
    if (this.activeProviderId === CLI_LOGIN_PROVIDER_ID) {
      const email = this._readCliLoginEmail();
      if (email) this.bridge.callJs('updateCliLoginAccountInfo', email);
    }
  }

  /** 从 ~/.claude.json 读取 OAuth 账号邮箱（仅取安全展示字段，绝不读凭据）。对齐 IDEA readCliLoginAccountInfo。 */
  _readCliLoginEmail() {
    try {
      const file = path.join(os.homedir(), '.claude.json');
      const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const acc = obj && obj.oauthAccount;
      if (acc && typeof acc.emailAddress === 'string' && acc.emailAddress) return acc.emailAddress;
    } catch (e) { /* 文件不存在/坏 JSON：未登录，返回 null */ }
    return null;
  }

  /**
   * 切换 provider（含特殊伪 id：__disabled__ / __local_settings_json__ / __cli_login__）。
   * 关键：切换鉴权模式/凭据后，daemon 中按 signature 复用的 SDK runtime 仍持旧凭据
   * （signature 不含鉴权状态），必须丢弃全部 runtime，下一条消息才会用新模式
   * （对齐 IDEA handleSwitchProvider 的 shutdownDaemon 意图，但用更轻量的 resetRuntime）。
   */
  async _handleSwitchProvider(content) {
    let d;
    try { d = JSON.parse(content); } catch (e) { return; }
    const id = (d && d.id) || '';
    this.activeProviderId = id;
    this._persistProviders();
    await this._refreshClaudeRuntimes();
    this._emitProviders();
    this.bridge.callJs('showSwitchSuccess', this._switchSuccessMessage(id));
  }

  /** provider 切换成功的提示文案（HBuilderX 宿主无 i18n，fork 默认中文）。 */
  _switchSuccessMessage(id) {
    if (id === CLI_LOGIN_PROVIDER_ID) return '已启用「使用 CLI 登录信息」';
    if (id === LOCAL_SETTINGS_PROVIDER_ID) return '已启用本地 settings.json';
    if (!id || id === DISABLED_PROVIDER_ID) return '已停用所有供应商';
    const p = this.providers.find((x) => x.id === id);
    return p ? `已切换到「${p.name}」` : '已切换供应商';
  }

  /** 丢弃 daemon 内全部 SDK runtime，使鉴权/凭据变更在下一条消息立即生效（不重启 daemon）。 */
  async _refreshClaudeRuntimes() {
    if (!this.aiBridge || !this.aiBridge.proc) return;
    try {
      await this.aiBridge.request('claude.resetRuntime', {});
    } catch (e) {
      this.output.appendLine(`[router] resetRuntime 失败（将于下次发送重建）: ${e && e.message}`);
    }
  }

  /** ai-bridge daemon 的额外环境变量（权限 IPC + 用户自定义 Claude CLI 路径）。 */
  _bridgeExtraEnv() {
    const env = { ...this.permission.env() };
    const cliPath = (this._prefs.claudeCliPath || '').trim();
    if (cliPath) env.CLAUDE_CODE_PATH = cliPath; // ai-bridge getClaudeCliPathOverride() 读取 → SDK pathToClaudeCodeExecutable
    return env;
  }

  /** HBuilderX 配置代理：让 node-detector 的 ccgui.nodePath 优先取「环境」tab 保存的覆盖值。 */
  _nodeConfig() {
    const hxConfig = (() => { try { return this.hx.workspace.getConfiguration(); } catch (e) { return null; } })();
    const override = (this._prefs.nodePath || '').trim();
    return {
      get: (key) => {
        if (key === 'ccgui.nodePath' && override) return override;
        return hxConfig && hxConfig.get ? hxConfig.get(key) : undefined;
      },
    };
  }

  /** 探测 Node 完整版本字符串（如 "v18.20.0"，失败返回 null）。 */
  _probeNodeVersion(nodePath) {
    try {
      return require('child_process').execFileSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 4000 }).trim();
    } catch (e) { return null; }
  }

  /**
   * 用当前 nodeInfo.path + extraEnv 重启 ai-bridge daemon。
   * 改 Node 路径（换二进制）或 Claude CLI 路径（CLAUDE_CODE_PATH 在 spawn 时固化）后必须整体重启。
   */
  async _restartBridge() {
    if (!this.nodeInfo || !this.nodeInfo.path) return;
    try { if (this.aiBridge) this.aiBridge.dispose(); } catch (e) { /* ignore */ }
    this.aiBridge = new AiBridgeClient(this.nodeInfo.path, this.output, undefined, this._bridgeExtraEnv());
    try {
      await this.aiBridge.start();
    } catch (err) {
      this.output.appendLine(`[router] 重启 ai-bridge 失败: ${err && err.message}`);
      this.bridge.callJs('addErrorMessage', `ai-bridge 重启失败: ${err && err.message}`);
    }
  }

  // ===== 设置 → 基础配置 → 环境（Node 路径 / Claude CLI 路径 / 工作目录）=====
  // 原 HBuilderX 移植版漏实现这 6 个 case → 全落 default「暂未处理」→ 三个保存按钮点了无效（用户反馈「环境设置保存不了」）。

  _envNodePayload() {
    return {
      path: (this._prefs.nodePath || '').trim(), // 用户覆盖值（空=自动探测）
      version: this.nodeInfo ? this._probeNodeVersion(this.nodeInfo.path) : null, // 当前生效 Node 版本
      minVersion: 18,
    };
  }

  _handleGetNodePath() {
    this.bridge.callJs('updateNodePath', JSON.stringify(this._envNodePayload()));
  }

  async _handleSetNodePath(content) {
    let d = {};
    try { d = JSON.parse(content) || {}; } catch (e) { d = {}; }
    const next = typeof d.path === 'string' ? d.path.trim() : '';
    this._persist({ nodePath: next });
    // 重新探测（尊重新覆盖值），并重启 daemon 使新 Node 立即生效
    resetNodeCache();
    const detected = detectNode(this._nodeConfig(), { execPath: process.execPath, force: true });
    if (detected) this.nodeInfo = detected;
    this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(this._nodeEnvPayload()));
    await this._restartBridge();
    this._handleGetNodePath();
  }

  _handleGetClaudeCliPath() {
    this.bridge.callJs('updateClaudeCliPath', JSON.stringify({ path: (this._prefs.claudeCliPath || '').trim() }));
  }

  async _handleSetClaudeCliPath(content) {
    let d = {};
    try { d = JSON.parse(content) || {}; } catch (e) { d = {}; }
    const next = typeof d.path === 'string' ? d.path.trim() : '';
    this._persist({ claudeCliPath: next });
    // CLAUDE_CODE_PATH 在 daemon spawn 时固化，必须重启才能让 SDK 用新的 CLI 二进制
    await this._restartBridge();
    this._handleGetClaudeCliPath();
  }

  _handleGetWorkingDirectory() {
    this.bridge.callJs('updateWorkingDirectory', JSON.stringify({ customWorkingDir: (this._prefs.customWorkingDir || '').trim() }));
  }

  _handleSetWorkingDirectory(content) {
    let d = {};
    try { d = JSON.parse(content) || {}; } catch (e) { d = {}; }
    const next = typeof d.customWorkingDir === 'string' ? d.customWorkingDir.trim() : '';
    this._persist({ customWorkingDir: next });
    // 无需重启 daemon：工作目录是 per-request 的 params.cwd（见 _handleSend）
    this._handleGetWorkingDirectory();
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
   * 形态对齐前端 updateDependencyStatus 期望：{ 'claude-sdk': {id,name,status,installedVersion?,installPath?,hasUpdate}, 'codex-sdk': {...} }
   */
  _dependencyStatusPayload() {
    return dependencyService.getStatus();
  }

  /**
   * Node 环境状态，形态对齐前端 nodeEnvironmentStatus 期望 `{ available }`。
   * （前端只读 status.available；version/path/belowMin 仅用于调试展示。）
   */
  _nodeEnvPayload() {
    const available = !!(this.nodeInfo && this.nodeInfo.path);
    const payload = { available };
    if (this.nodeInfo) {
      payload.version = this.nodeInfo.major;
      payload.path = this.nodeInfo.path;
      if (this.nodeInfo.belowMin) payload.belowMin = true;
    } else {
      payload.error = 'Node.js not found';
    }
    return payload;
  }

  /**
   * 安装/升级 SDK。流式回灌 dependencyInstallProgress，结束回 dependencyInstallResult（均为 JSON 字符串）。
   * content 形如 {"id":"claude-sdk","version":"0.2.88"}（version 可选）。
   */
  async _handleInstallDependency(content) {
    let id = '';
    let version;
    try { const o = JSON.parse(content || '{}') || {}; id = o.id || ''; version = o.version; } catch (e) { /* ignore */ }

    const nodePath = this.nodeInfo && this.nodeInfo.path;
    if (!nodePath) {
      this.bridge.callJs('dependencyInstallResult', JSON.stringify({ success: false, sdkId: id, error: 'node_not_configured' }));
      return;
    }
    if (this._depBusy) {
      this.bridge.callJs('dependencyInstallResult', JSON.stringify({ success: false, sdkId: id, error: '已有依赖操作进行中，请稍候' }));
      return;
    }
    this._depBusy = true;
    try {
      const res = await dependencyService.install({
        sdkId: id,
        version,
        nodePath,
        onLog: (line) => this.bridge.callJs('dependencyInstallProgress', JSON.stringify({ sdkId: id, log: line })),
      });
      this.bridge.callJs('dependencyInstallResult', JSON.stringify(res));
      // 安装成功后刷新状态（daemon 的 sdk-loader 每次发送都会 existsSync 检查，无需重启即可加载新装的 SDK）
      if (res && res.success) {
        this.bridge.callJs('updateDependencyStatus', JSON.stringify(this._dependencyStatusPayload()));
      }
    } catch (e) {
      this.bridge.callJs('dependencyInstallResult', JSON.stringify({ success: false, sdkId: id, error: e && e.message }));
    } finally {
      this._depBusy = false;
    }
  }

  /** 检查更新，回 dependencyUpdateAvailable（JSON 字符串）。content 可选 {"id":sdkId}。 */
  async _handleCheckDependencyUpdates(content) {
    let id;
    try { id = (JSON.parse(content || '{}') || {}).id; } catch (e) { /* ignore */ }
    try {
      const res = await dependencyService.checkUpdates({ sdkId: id, nodePath: this.nodeInfo && this.nodeInfo.path });
      this.bridge.callJs('dependencyUpdateAvailable', JSON.stringify(res));
    } catch (e) {
      this.output.appendLine(`[router] check_dependency_updates 失败: ${e && e.message}`);
    }
  }

  /** 拉取可选版本，回 dependencyVersionsLoaded（JSON 字符串）。content 可选 {"id":sdkId}。 */
  async _handleGetDependencyVersions(content) {
    let id;
    try { id = (JSON.parse(content || '{}') || {}).id; } catch (e) { /* ignore */ }
    try {
      const res = await dependencyService.getVersions({ sdkId: id, nodePath: this.nodeInfo && this.nodeInfo.path });
      this.bridge.callJs('dependencyVersionsLoaded', JSON.stringify(res));
    } catch (e) {
      this.output.appendLine(`[router] get_dependency_versions 失败: ${e && e.message}`);
    }
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
  /** 解析 HBuilderX 当前打开的所有项目目录（可能多个）。返回 [{id,name,path}]。 */
  async _resolveWorkspaceFolders() {
    try {
      let folders = this.hx.workspace.getWorkspaceFolders();
      if (folders && typeof folders.then === 'function') folders = await folders;
      if (!Array.isArray(folders)) return [];
      return folders.map((f) => {
        let p = '';
        const uri = f && f.uri;
        if (uri && typeof uri === 'object' && uri.fsPath) p = uri.fsPath;
        else if (typeof uri === 'string') p = uri;
        else if (f && f.fsPath) p = f.fsPath;
        else if (f && f.path) p = f.path;
        return { id: (f && f.id) || p, name: (f && f.name) || (p ? path.basename(p) : ''), path: p };
      }).filter((f) => f.path);
    } catch (e) {
      this.output.appendLine(`[router] 解析项目列表失败: ${e && e.message}`);
      return [];
    }
  }

  /**
   * 路径归一化（用于「文件属于哪个项目」前缀匹配）：统一分隔符、去尾分隔符；
   * Windows 文件系统大小写不敏感故转小写。
   * 关键：`editor.document.uri.fsPath` 在 Windows 可能是正斜杠 / 小写盘符（如 `d:/.../movie/x.md`），
   * 而 `WorkspaceFolder.path` 可能是反斜杠（`D:\...\movie`）——不归一化直接 `startsWith` 会匹配失败，
   * 进而误落到兜底的第一个项目（曾导致开 movie 的文件却定位到 it-tools）。
   */
  _normPath(p) {
    if (!p) return '';
    let s = String(p).replace(/[\\/]+/g, path.sep).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  }

  /** 在 folders 中找包含 fsPath 的项目（归一化后最长前缀匹配）。无则 null。 */
  _folderContaining(folders, fsPath) {
    const nf = this._normPath(fsPath);
    if (!nf) return null;
    return folders
      .filter((f) => {
        const np = this._normPath(f.path);
        return np && (nf === np || nf.startsWith(np + path.sep));
      })
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  /**
   * 选定本次会话所属项目（HBuilderX 可同时打开多个项目）。
   * 优先级：① 当前正在编辑的文件所属项目 → ② 第一个项目。
   * 一个项目都没有时返回空，由调用方（_handleRequestProject）提示用户先创建/打开项目。
   * @returns {Promise<{path:string,name:string}>}
   */
  async _resolveActiveProject() {
    const folders = await this._resolveWorkspaceFolders();
    if (folders.length === 0) return { path: '', name: '' };
    if (folders.length === 1) return folders[0];
    // ① 当前正在编辑的文件所属项目（取最长前缀匹配）
    try {
      const editor = await this.hx.window.getActiveTextEditor();
      const fsPath = editor && editor.document && editor.document.uri && editor.document.uri.fsPath;
      this.output.appendLine(`[router] _resolveActiveProject: activeFile=${fsPath || '(none)'} folders=[${folders.map((f) => f.path).join(', ')}]`);
      const containing = this._folderContaining(folders, fsPath);
      if (containing) return containing;
    } catch (e) { this.output.appendLine(`[router] _resolveActiveProject 异常: ${e && e.message}`); }
    // ② 编辑区没有文件 / 文件不属于任何已打开项目：兜底用第一个项目
    return folders[0];
  }

  /** 解析当前 cwd（并同步 projectName）。供 init / 发送前兜底调用。 */
  async _resolveCwd() {
    const proj = await this._resolveActiveProject();
    this.projectName = proj.name || '';
    return proj.path || '';
  }

  /** 向前端顶部推送当前项目名（会话名后展示）。 */
  _emitProject() {
    this.bridge.callJs('onProjectChanged', JSON.stringify({ name: this.projectName || '', path: this.cwd || '' }));
  }

  /** 启动：探测 Node、拉起 ai-bridge daemon。 */
  async init() {
    // 解析项目 cwd（异步）
    this.cwd = await this._resolveCwd();
    this.output.appendLine(`[router] cwd=${this.cwd || '(empty!)'}`);

    // 优先级：环境 tab 保存的 nodePath 覆盖（经 _nodeConfig 注入）> HBuilderX 内置 Node（execPath）
    this.nodeInfo = detectNode(this._nodeConfig(), { execPath: process.execPath });
    if (!this.nodeInfo) {
      this.output.appendLine('[router] 未找到可用 Node.js，无法启动 ai-bridge');
      this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(this._nodeEnvPayload()));
      return;
    }
    this.output.appendLine(`[router] 使用 Node: ${this.nodeInfo.path} (v${this.nodeInfo.major}, 来源=${this.nodeInfo.source})`);
    if (this.nodeInfo.belowMin) {
      // 内置/可用 Node < 18：SDK（engines>=18，且无全局 fetch）很可能无法运行
      const warn = `当前 Node v${this.nodeInfo.major}(${this.nodeInfo.source}) 低于 Claude/Codex SDK 要求的 v18，可能无法正常工作。`
        + `请在 设置 → 插件配置 → CC GUI → nodePath 指定一个 ≥18 的 Node，或安装系统 Node 18+。`;
      this.output.appendLine(`[router] 警告: ${warn}`);
      // 仍 available:true —— npm install 本身在 Node 16 也能跑；SDK 运行期的版本告警已写入 OutputChannel
      this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(this._nodeEnvPayload()));
    } else {
      this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(this._nodeEnvPayload()));
    }

    // 权限桥接 env + 自定义 Claude CLI 路径必须在 spawn 前注入；provider 的 key/baseURL 走 ~/.codemoss/config.json（setupApiKey 每次发送读取）
    this.aiBridge = new AiBridgeClient(this.nodeInfo.path, this.output, undefined, this._bridgeExtraEnv());
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
    // 顶部展示当前会话所属项目（HBuilderX 可同时打开多个项目）
    this._emitProject();
  }

  /** 出站事件分发器（注册到 BridgeHost.onEvent）。 */
  dispatch(event, content) {
    switch (event) {
      case 'send_message':
        this._handleSend(content);
        break;
      case 'create_new_session':
        this._handleNewSessionFromUser();
        break;
      case 'select_project':
        this._handleSelectProject(content);
        break;
      case 'request_project':
        this._handleRequestProject();
        break;
      case 'get_project_info':
        this._handleGetProjectInfo();
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
      // ===== SDK 依赖联网安装（移植 IDEA DependencyManager；本插件不打包 SDK）=====
      case 'install_dependency':
      case 'update_dependency':
        this._handleInstallDependency(content);
        break;
      case 'uninstall_dependency': {
        let id = '';
        try { id = (JSON.parse(content || '{}') || {}).id || ''; } catch (e) { /* ignore */ }
        const res = dependencyService.uninstall(id);
        this.bridge.callJs('dependencyUninstallResult', JSON.stringify(res));
        // 卸载后刷新状态
        this.bridge.callJs('updateDependencyStatus', JSON.stringify(this._dependencyStatusPayload()));
        break;
      }
      case 'check_dependency_updates':
        this._handleCheckDependencyUpdates(content);
        break;
      case 'get_dependency_versions':
        this._handleGetDependencyVersions(content);
        break;
      case 'check_node_environment':
        this.bridge.callJs('nodeEnvironmentStatus', JSON.stringify(this._nodeEnvPayload()));
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
        const active = this._providerListForUi().find((p) => p.isActive);
        if (active) this.bridge.callJs('updateActiveProvider', JSON.stringify(active));
        if (this.activeProviderId === CLI_LOGIN_PROVIDER_ID) {
          const email = this._readCliLoginEmail();
          if (email) this.bridge.callJs('updateCliLoginAccountInfo', email);
        }
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
      case 'switch_provider':
        this._handleSwitchProvider(content);
        break;
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
      // ===== 设置 → 基础配置 → 环境 =====
      case 'get_node_path':
        this._handleGetNodePath();
        break;
      case 'set_node_path':
        this._handleSetNodePath(content);
        break;
      case 'get_claude_cli_path':
        this._handleGetClaudeCliPath();
        break;
      case 'set_claude_cli_path':
        this._handleSetClaudeCliPath(content);
        break;
      case 'get_working_directory':
        this._handleGetWorkingDirectory();
        break;
      case 'set_working_directory':
        this._handleSetWorkingDirectory(content);
        break;
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
      // ===== Agent（子智能体）面板 =====
      case 'get_agents':
        this._handleGetAgents();
        break;
      case 'add_agent':
        this._handleAddAgent(content);
        break;
      case 'update_agent':
        this._handleUpdateAgent(content);
        break;
      case 'delete_agent':
        this._handleDeleteAgent(content);
        break;
      case 'export_agents':
        this._handleExportAgents(content);
        break;
      case 'import_agents_file':
        this._handleImportAgentsFile();
        break;
      case 'save_imported_agents':
        this._handleSaveImportedAgents(content);
        break;
      // ===== MCP 服务器面板（Claude）=====
      case 'get_mcp_servers':
        this._handleGetMcpServers('claude');
        break;
      case 'get_mcp_server_status':
        this._handleGetMcpServerStatus('claude');
        break;
      case 'get_mcp_server_tools':
        this._handleGetMcpServerTools('claude', content);
        break;
      case 'add_mcp_server':
        this._handleUpsertMcpServer('claude', content, false);
        break;
      case 'update_mcp_server':
        this._handleUpsertMcpServer('claude', content, true);
        break;
      case 'delete_mcp_server':
        this._handleDeleteMcpServer('claude', content);
        break;
      case 'toggle_mcp_server':
        this._handleToggleMcpServer('claude', content);
        break;
      // ===== MCP 服务器面板（Codex 变体）=====
      case 'get_codex_mcp_servers':
        this._handleGetMcpServers('codex');
        break;
      case 'get_codex_mcp_server_status':
        this._handleGetMcpServerStatus('codex');
        break;
      case 'get_codex_mcp_server_tools':
        this._handleGetMcpServerTools('codex', content);
        break;
      case 'add_codex_mcp_server':
        this._handleUpsertMcpServer('codex', content, false);
        break;
      case 'update_codex_mcp_server':
        this._handleUpsertMcpServer('codex', content, true);
        break;
      case 'delete_codex_mcp_server':
        this._handleDeleteMcpServer('codex', content);
        break;
      case 'toggle_codex_mcp_server':
        this._handleToggleMcpServer('codex', content);
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
      case 'list_files':
        this._handleListFiles(content);
        break;
      case 'get_ide_theme':
        this._handleGetIdeTheme();
        break;
      // ===== 历史会话（History）=====
      case 'load_history_data':
        this._handleLoadHistoryData(content);
        break;
      case 'deep_search_history':
        // 无内存缓存层，深扫等同重新加载列表（对齐 Java：清缓存后 reload）
        this._handleLoadHistoryData(content);
        break;
      case 'delete_session':
        this._handleDeleteSession(content);
        break;
      case 'delete_sessions':
        this._handleDeleteSessions(content);
        break;
      case 'export_session':
        this._handleExportSession(content);
        break;
      case 'toggle_favorite':
        this._handleToggleFavorite(content);
        break;
      case 'update_title':
        this._handleUpdateTitle(content);
        break;
      case 'delete_title':
        this._handleDeleteTitle(content);
        break;
      case 'convert_to_cli_session':
        this._handleConvertToCliSession(content);
        break;
      case 'load_subagent_session':
        this._handleLoadSubagentSession(content);
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
   * 选择/切换本次会话所属项目（HBuilderX 可同时打开多个项目）。
   * content 为空 -> 弹原生 showQuickPick 让用户选；content={path} -> 直接切到该项目。
   * 切换即在新项目里开新会话（历史/技能/MCP 均按项目隔离），并刷新顶部项目名。
   */
  async _handleSelectProject(content) {
    const folders = await this._resolveWorkspaceFolders();
    if (folders.length === 0) {
      this.projectName = '';
      this._emitProject();
      return;
    }

    let chosen = null;
    try {
      const obj = content ? JSON.parse(content) : null;
      if (obj && obj.path) chosen = folders.find((f) => f.path === obj.path) || null;
    } catch (e) { /* content 非 JSON：走选择器 */ }

    if (!chosen) {
      if (folders.length === 1) {
        chosen = folders[0];
      } else {
        try {
          const items = folders.map((f) => ({ label: f.name, description: f.path }));
          const picked = await this.hx.window.showQuickPick(items, { placeHolder: '选择本次会话使用的项目' });
          if (!picked) return; // 用户取消
          chosen = folders.find((f) => f.path === picked.description) || null;
        } catch (e) {
          this.output.appendLine(`[router] 选择项目失败: ${e && e.message}`);
          return;
        }
      }
    }
    if (!chosen || !chosen.path) return;

    // 选中的就是当前项目：仅刷新顶部展示，不动当前会话（避免点一下就误清空对话）
    if (chosen.path === this.cwd) {
      this.projectName = chosen.name;
      this._emitProject();
      return;
    }

    this.cwd = chosen.path;
    this.projectName = chosen.name;
    // 注：默认项目按「活动编辑器→第一个」解析，不再持久化「上次选择」，故此处不写 projectPath。
    this.output.appendLine(`[router] 切换项目 -> ${this.projectName} (${this.cwd})`);
    this._handleNewSession(); // 切到不同项目：历史按项目隔离，开新会话
    this._emitProject();
  }

  /**
   * 纯切换原语：若「当前活动编辑器文件」属于另一个已打开项目，则切 cwd/projectName。
   * 只改 cwd/projectName，**不开新会话、不推送前端**（交由调用方决定，避免污染 `_handleSelectProject` 的显式选择）。
   * 仅在「≥2 个项目 且 确有活动文件 且 归属另一个已打开项目 且 与当前 cwd 不同」时切换。
   * @returns {Promise<boolean>} 是否发生了切换
   */
  async _relocateActiveProject(activeFsPath) {
    try {
      const folders = await this._resolveWorkspaceFolders();
      if (folders.length < 2) return false; // 0/1 个项目无可切换
      let fsPath = activeFsPath || '';
      if (!fsPath) {
        const editor = await this.hx.window.getActiveTextEditor();
        fsPath = (editor && editor.document && editor.document.uri && editor.document.uri.fsPath) || '';
      }
      this.output.appendLine(`[router] _relocateActiveProject: activeFile=${fsPath || '(none)'} cwd=${this.cwd || '(empty)'} folders=[${folders.map((f) => f.path).join(', ')}]`);
      if (!fsPath) return false; // 无活动文件（如聚焦在设置/欢迎页）：保持当前项目
      const containing = this._folderContaining(folders, fsPath);
      if (!containing) {
        this.output.appendLine('[router] 活动文件不属于任何已打开项目，保持当前项目');
        return false;
      }
      if (this._normPath(containing.path) === this._normPath(this.cwd)) return false; // 已是当前项目
      this.cwd = containing.path;
      this.projectName = containing.name;
      this.output.appendLine(`[router] 定位活动文件所属项目 -> ${this.projectName} (${this.cwd})`);
      return true;
    } catch (e) {
      this.output.appendLine(`[router] _relocateActiveProject 失败: ${e && e.message}`);
      return false;
    }
  }

  /**
   * 用户主动打开视图（状态栏图标 / Ctrl+Alt+C）时调用：把会话对焦到「当前正在编辑文件」所属项目。
   * cwd 只在 init() 解析一次（IDE 启动那刻），之后切到别的项目编辑文件、再点图标/快捷键打开，
   * 会话仍停在旧项目——本方法补上这步重新对焦。
   * **仅在「没有进行中的会话」时定位**（`sessionId` 为空 = 新打开/新建会话的空白态）：
   * 已在对话中再点图标只是想聚焦视图，不应切项目清会话；流式发送中(`_busy`)同样不动。
   */
  async syncProjectFromActiveEditor(activeFsPath) {
    if (this._busy) { this.output.appendLine('[router] 打开视图：流式进行中，跳过项目定位'); return; }
    if (this.sessionId) { this.output.appendLine('[router] 打开视图：已有进行中会话，仅聚焦不定位'); return; }
    if (await this._relocateActiveProject(activeFsPath)) {
      this._handleNewSession(); // 切到不同项目：历史按项目隔离，开新会话
      this._emitProject();
    }
  }

  /**
   * 新建会话（前端 `create_new_session`：新建按钮 / /clear|/new|/reset / 切 provider / 删当前会话后）。
   * 用户明确要求「新建会话时才定位项目」：先把 cwd 对焦到当前活动文件所属项目，再重置会话。
   * 注意区别于底层原语 `_handleNewSession()`——后者还被 `_handleSelectProject` 调用，那条路径已显式选定项目，不可再定位。
   */
  async _handleNewSessionFromUser() {
    this._handleNewSession(); // 先重置（clearMessages 即时下发，保持与前端 session transition 的原时序）
    if (await this._relocateActiveProject()) {
      this._emitProject(); // 项目变了才刷新顶部 chip
    }
  }

  /**
   * 前端挂载后主动拉取当前项目（事件 `request_project`）。
   * 规避竞态：bootstrap 的 `onProjectChanged` 推送可能早于前端注册回调而被桥接 shim 静默丢弃，
   * 导致顶部一直显示不出项目名。前端注册回调后再请求，这里回推即可命中。
   */
  async _handleRequestProject() {
    if (!this.cwd) {
      this.cwd = await this._resolveCwd(); // 顺带同步 this.projectName
    }
    if (!this.cwd) {
      // 一个项目都没有：提示用户先创建/打开项目（每进程仅提示一次，避免重载刷屏）
      this._promptNoProject();
    }
    this._emitProject();
  }

  /** 未打开任何项目时提示先创建/打开项目；每进程仅提示一次。 */
  _promptNoProject() {
    if (this._noProjectPrompted) return;
    this._noProjectPrompted = true;
    try {
      this.hx.window.showInformationMessage(
        '尚未打开任何项目。CC GUI 需要一个项目作为工作目录，请先在 HBuilderX 中新建或打开一个项目后再使用。',
        ['知道了'],
      );
    } catch (e) { /* ignore */ }
  }

  /**
   * 响应前端 `get_project_info`（项目级提示词等使用）：回推 {name,path,available}。
   * 此前未实现，前端会一直停在加载态、日志刷 “暂未处理: get_project_info”。
   */
  async _handleGetProjectInfo() {
    if (!this.cwd) {
      this.cwd = await this._resolveCwd();
    }
    const payload = { name: this.projectName || '', path: this.cwd || '', available: !!this.cwd };
    this.bridge.callJs('updateProjectInfo', JSON.stringify(payload));
  }

  /**
   * 恢复指定会话：读取 JSONL，逐条 addHistoryMessage 重放到 UI，再 historyLoadComplete；
   * 同时设置 this.sessionId 使后续消息在服务端续上该会话。
   *
   * 时序要点（与 webview 的 session transition guard 协同）：
   *   - 前端 loadHistorySession 已先 beginSessionTransition（置 window.__sessionTransitioning=true 并清空消息）。
   *   - addHistoryMessage 在 transitioning 期间会被前端直接丢弃，故必须先 setSessionId（其内部会
   *     releaseSessionTransition 释放 guard）再重放。
   *   - 最后 historyLoadComplete 触发 Markdown 重渲染并兜底释放 guard。
   * 出错也调用 historyLoadComplete + addErrorMessage，绝不让前端卡在 transition guard。
   */
  async _handleLoadSession(content) {
    let sessionId = content;
    let provider = this._historyProvider;
    try {
      const obj = JSON.parse(content);
      sessionId = obj.sessionId || obj.id || content;
      if (obj.provider) provider = obj.provider;
    } catch (e) { /* content 即为 sessionId */ }
    if (!sessionId) {
      this.bridge.callJs('historyLoadComplete');
      return;
    }

    this.sessionId = sessionId;
    this.assembler.reset();

    try {
      await this._ensureCwd();

      // 释放 transition guard（setSessionId 内部会 releaseSessionTransition），随后重放才不被丢弃。
      this.bridge.callJs('setSessionId', sessionId);

      if (provider !== 'claude') {
        // Codex 等暂不支持 UI 重放：仅续聊，立即完成（不报错，避免卡 loading）
        this.output.appendLine(`[router] load_session: provider=${provider} 暂不支持 UI 重放，仅续聊`);
        this.bridge.callJs('historyLoadComplete');
        return;
      }

      const messages = historyService.loadSessionMessages(this.cwd || '', sessionId);
      for (const msg of messages) {
        // addHistoryMessage 期望 ClaudeMessage 对象（前端不做 JSON.parse），直接透传对象。
        this.bridge.callJs('addHistoryMessage', msg);
      }
      this.bridge.callJs('historyLoadComplete');
      this.output.appendLine(`[router] load_session: ${sessionId} 重放 ${messages.length} 条历史消息`);
    } catch (e) {
      this.output.appendLine(`[router] load_session 异常: ${e && e.message}`);
      // 兜底释放 guard + 报错，前端不卡
      this.bridge.callJs('historyLoadComplete');
      this.bridge.callJs('addErrorMessage', `加载会话失败: ${e && e.message ? e.message : String(e)}`);
    }
  }

  // ===================== 历史会话（History）handler =====================

  /**
   * load_history_data / deep_search_history：扫描项目会话 + 合并收藏/标题，回 setHistoryData。
   * 出错也回 setHistoryData({success:false,error}) —— 前端据此显示错误而非卡 loading。
   */
  async _handleLoadHistoryData(content) {
    const provider = (typeof content === 'string' && content) ? content : 'claude';
    this._historyProvider = provider;
    let data;
    try {
      await this._ensureCwd();
      data = historyService.loadHistoryData(this.cwd || '', provider);
      this.output.appendLine(`[router] load_history_data: provider=${provider} sessions=${(data.sessions || []).length}`);
    } catch (e) {
      this.output.appendLine(`[router] load_history_data 异常: ${e && e.message}`);
      data = { success: false, error: e && e.message ? e.message : String(e), sessions: [], total: 0, favorites: {} };
    }
    try {
      // setHistoryData 期望 HistoryData 对象（前端不做 JSON.parse），直接透传对象。
      this.bridge.callJs('setHistoryData', data);
    } catch (e) {
      this.output.appendLine(`[router] load_history_data 回调失败: ${e && e.message}`);
    }
  }

  /**
   * delete_session：删除会话 JSONL（+ 关联 agent 文件 + sidecar 收藏/标题）。
   * 前端已乐观更新本地列表，无需回列表；仅记录日志。
   */
  async _handleDeleteSession(content) {
    const sessionId = typeof content === 'string' ? content.trim() : '';
    if (!sessionId) return;
    try {
      await this._ensureCwd();
      const r = historyService.deleteSession(this.cwd || '', sessionId);
      this.output.appendLine(`[router] delete_session: ${sessionId} main=${r.mainDeleted} agents=${r.agentFilesDeleted} ${r.error ? 'err=' + r.error : ''}`);
    } catch (e) {
      this.output.appendLine(`[router] delete_session 异常: ${e && e.message}`);
    }
  }

  /** delete_sessions：批量删除。content 为 JSON 数组字符串。前端已乐观更新，无需回列表。 */
  async _handleDeleteSessions(content) {
    try {
      await this._ensureCwd();
      const r = historyService.deleteSessions(this.cwd || '', content);
      this.output.appendLine(`[router] delete_sessions: deleted=${r.mainDeletedCount}/${r.total}`);
    } catch (e) {
      this.output.appendLine(`[router] delete_sessions 异常: ${e && e.message}`);
    }
  }

  /**
   * export_session：读取会话原始消息，回 onExportSessionData(JSON 字符串)。
   * 前端对该参数做 JSON.parse，故必须 stringify；失败时回 { error } 让前端 toast。
   */
  async _handleExportSession(content) {
    let sessionId = '';
    let title = '';
    try {
      const obj = JSON.parse(content);
      sessionId = (obj && obj.sessionId) || '';
      title = (obj && obj.title) || '';
    } catch (e) { /* 解析失败下方按空处理 */ }

    let result;
    try {
      await this._ensureCwd();
      if (this._historyProvider !== 'claude') {
        result = { error: '当前 provider 暂不支持导出' };
      } else {
        result = historyService.exportSession(this.cwd || '', sessionId, title);
      }
    } catch (e) {
      this.output.appendLine(`[router] export_session 异常: ${e && e.message}`);
      result = { error: e && e.message ? e.message : String(e) };
    }
    try {
      this.bridge.callJs('onExportSessionData', JSON.stringify(result));
      this.output.appendLine(`[router] export_session: ${sessionId} ${result.error ? 'err=' + result.error : 'msgs=' + (result.messages ? result.messages.length : 0)}`);
    } catch (e) {
      this.output.appendLine(`[router] export_session 回调失败: ${e && e.message}`);
    }
  }

  /** toggle_favorite：持久化收藏态到 ~/.codemoss/favorites.json（前端已乐观更新，无需回）。 */
  _handleToggleFavorite(content) {
    const sessionId = typeof content === 'string' ? content.trim() : '';
    if (!sessionId) return;
    try {
      const r = historyService.toggleFavorite(sessionId);
      this.output.appendLine(`[router] toggle_favorite: ${sessionId} -> ${r.isFavorited} ${r.error ? 'err=' + r.error : ''}`);
    } catch (e) {
      this.output.appendLine(`[router] toggle_favorite 异常: ${e && e.message}`);
    }
  }

  /**
   * update_title：持久化自定义标题到 ~/.codemoss/session-titles.json。
   * 前端已乐观更新；仅当持久化失败时回 addToast 提示（对齐 Java）。
   */
  _handleUpdateTitle(content) {
    let sessionId = '';
    let customTitle = '';
    try {
      const obj = JSON.parse(content);
      sessionId = (obj && obj.sessionId) || '';
      customTitle = (obj && typeof obj.customTitle === 'string') ? obj.customTitle : '';
    } catch (e) { /* 解析失败下方按空处理 */ }
    if (!sessionId) return;

    try {
      const r = historyService.updateTitle(sessionId, customTitle);
      this.output.appendLine(`[router] update_title: ${sessionId} success=${r.success} ${r.error ? 'err=' + r.error : ''}`);
      if (!r.success && r.error) {
        this.bridge.callJs('addToast', `更新标题失败: ${r.error}`, 'error');
      }
    } catch (e) {
      this.output.appendLine(`[router] update_title 异常: ${e && e.message}`);
      this.bridge.callJs('addToast', `更新标题失败: ${e && e.message ? e.message : String(e)}`, 'error');
    }
  }

  /** delete_title：删除孤立的自定义标题条目（B-011 会话 id 迁移清理）。 */
  _handleDeleteTitle(content) {
    const sessionId = typeof content === 'string' ? content.trim() : '';
    if (!sessionId) return;
    try {
      historyService.deleteTitle(sessionId);
      this.output.appendLine(`[router] delete_title: ${sessionId}`);
    } catch (e) {
      this.output.appendLine(`[router] delete_title 异常: ${e && e.message}`);
    }
  }

  /**
   * convert_to_cli_session：HBuilderX 移植不实现 SDK->CLI 会话转换。
   * 优雅降级：回 onConversionResult 明确的不支持结果（success:false + 已知 errorCode），
   * 前端据 errorCode 显示文案并 reload，不会崩。
   */
  _handleConvertToCliSession(content) {
    const sessionId = typeof content === 'string' ? content.trim() : '';
    // CONVERSION_FAILED 是前端 conversionErrors 已知 code，触发其失败分支（含 reload 回滚乐观更新）。
    const result = { success: false, errorCode: 'CONVERSION_FAILED', sessionId: sessionId };
    try {
      this.bridge.callJs('onConversionResult', JSON.stringify(result));
      this.output.appendLine(`[router] convert_to_cli_session: ${sessionId} 不支持，回降级结果`);
    } catch (e) {
      this.output.appendLine(`[router] convert_to_cli_session 回调失败: ${e && e.message}`);
    }
  }

  /**
   * load_subagent_session：读取 sidechain agent 日志，回 onSubagentHistoryLoaded(JSON 字符串)。
   * 文件位置对齐 Java SubagentHistoryService：
   *   ~/.claude/projects/<sanitized cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
   * 未找到/出错也回 success:false，前端可重试，不卡。
   */
  async _handleLoadSubagentSession(content) {
    let req = {};
    try { req = JSON.parse(content) || {}; } catch (e) { req = {}; }
    const sessionId = req.sessionId;
    const agentId = req.agentId;
    const toolUseId = req.toolUseId;

    const response = { toolUseId: toolUseId, agentId: agentId, sessionId: sessionId };
    const SAFE_ID = /^[A-Za-z0-9_-]+$/;
    try {
      await this._ensureCwd();
      if (!sessionId || !SAFE_ID.test(sessionId)) throw new Error('Invalid sessionId');
      if (!agentId || !SAFE_ID.test(agentId)) {
        // 仅支持按 agentId 定位（按 description 匹配属 niche，省略）
        throw new Error('Missing or invalid agentId');
      }
      const dir = historyService.getProjectSessionDir(this.cwd || '');
      if (!dir) throw new Error('Project session dir unavailable');
      const file = require('path').join(dir, sessionId, 'subagents', 'agent-' + agentId + '.jsonl');
      const raws = this._readJsonlArray(file);
      if (raws == null) {
        response.success = false;
        response.error = 'Subagent log not found';
      } else {
        response.success = true;
        response.messages = raws;
      }
    } catch (e) {
      response.success = false;
      response.error = e && e.message ? e.message : String(e);
    }
    try {
      this.bridge.callJs('onSubagentHistoryLoaded', JSON.stringify(response));
    } catch (e) {
      this.output.appendLine(`[router] load_subagent_session 回调失败: ${e && e.message}`);
    }
  }

  /** 读取一个 JSONL 文件为对象数组（不存在返回 null，坏行跳过）。 */
  _readJsonlArray(file) {
    if (!fs.existsSync(file)) return null;
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) { return null; }
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (e) { /* 跳过坏行 */ }
    }
    return out;
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

    // 「环境」tab 的自定义工作目录覆盖：显式设置且目录存在时优先于项目 cwd
    const customWd = (this._prefs.customWorkingDir || '').trim();
    const effectiveCwd = (customWd && fs.existsSync(customWd)) ? customWd : this.cwd;

    const params = {
      message: text,
      sessionId: this.sessionId || '',
      cwd: effectiveCwd,
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

  // ===================== @文件补全（list_files）=====================

  /**
   * list_files：前端输入框 `@` 补全的数据源。
   * 载荷 {query, currentPath}（currentPath 形如 `src/`，query 是末段搜索词）；回 onFileListResult({files})。
   * 移植自 IDEA 版 FileHandler/FileSystemCollector 的「磁盘扫描」分支（终端/服务/已开/最近文件等 IDE 专有源未移植）：
   * - 有 query：从 cwd 递归扫描，文件名或相对路径（小写）包含 query 即命中，限 200 条、深度 15。
   * - 无 query：列出 cwd/currentPath 下的直接子项（非递归），限 100 条。
   * 缺 cwd（未打开项目）回空列表，前端 3s 超时也会兜底，但显式回更快且能复位 spinner。
   */
  async _handleListFiles(content) {
    let files = [];
    try {
      await this._ensureCwd();
      const base = this.cwd;
      if (!base) {
        this.bridge.callJs('onFileListResult', JSON.stringify({ files: [] }));
        return;
      }
      let query = '';
      let currentPath = '';
      if (content) {
        try {
          const obj = JSON.parse(content);
          query = obj && obj.query ? String(obj.query) : '';
          currentPath = obj && obj.currentPath ? String(obj.currentPath) : '';
        } catch (e) {
          query = String(content).trim(); // 非 JSON：整串当搜索词
        }
      }
      const q = query.toLowerCase();
      if (q) {
        files = this._scanFilesRecursive(base, base, q, 0, []);
      } else {
        files = this._listDirectChildren(base, path.join(base, currentPath));
      }
      this._sortListFiles(files);
    } catch (e) {
      this.output.appendLine(`[router] list_files 异常: ${e && e.message}`);
      files = [];
    }
    try {
      this.bridge.callJs('onFileListResult', JSON.stringify({ files }));
    } catch (e) {
      this.output.appendLine(`[router] list_files 回调失败: ${e && e.message}`);
    }
  }

  /** 跳过噪声目录/文件（硬编码集，对齐 Java shouldSkipInSearch 基础版；未做 .gitignore 解析）。 */
  _listFilesShouldSkip(name, isDir) {
    return isDir ? LIST_FILES_SKIP_DIRS.has(name) : LIST_FILES_SKIP_FILES.has(name);
  }

  /** 构造与 Java createFileObject 同形的 FileItem：{name, path(相对/正斜杠), absolutePath(正斜杠), type, extension?}。 */
  _listFileObject(base, absPath, isDir) {
    const name = path.basename(absPath);
    const obj = {
      name,
      path: path.relative(base, absPath).replace(/\\/g, '/'),
      absolutePath: absPath.replace(/\\/g, '/'),
      type: isDir ? 'directory' : 'file',
    };
    if (!isDir) {
      const dot = name.lastIndexOf('.');
      if (dot > 0) obj.extension = name.slice(dot + 1);
    }
    return obj;
  }

  /** 列出目录直接子项（非递归），限 LIST_FILES_MAX_CHILDREN 条。 */
  _listDirectChildren(base, dir) {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return out; // 目录不存在/无权限：回空
    }
    for (const ent of entries) {
      if (out.length >= LIST_FILES_MAX_CHILDREN) break;
      const isDir = ent.isDirectory();
      if (this._listFilesShouldSkip(ent.name, isDir)) continue;
      out.push(this._listFileObject(base, path.join(dir, ent.name), isDir));
    }
    return out;
  }

  /** 从 dir 递归扫描，名字或相对路径(小写)含 q 即收入 acc；限深度与总条数。acc 引用累积。 */
  _scanFilesRecursive(base, dir, q, depth, acc) {
    if (depth > LIST_FILES_MAX_DEPTH || acc.length >= LIST_FILES_MAX_RESULTS) return acc;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return acc;
    }
    for (const ent of entries) {
      if (acc.length >= LIST_FILES_MAX_RESULTS) break;
      const isDir = ent.isDirectory();
      if (this._listFilesShouldSkip(ent.name, isDir)) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(base, abs).replace(/\\/g, '/');
      if (ent.name.toLowerCase().includes(q) || rel.toLowerCase().includes(q)) {
        acc.push(this._listFileObject(base, abs, isDir));
      }
      // 目录始终下钻：自身不命中但子项可能命中
      if (isDir) this._scanFilesRecursive(base, abs, q, depth + 1, acc);
    }
    return acc;
  }

  /** 排序：浅层优先 → 父目录 → 目录在前 → 名字（对齐 Java priority-3 排序，提升「文件名匹配」可见性）。 */
  _sortListFiles(files) {
    files.sort((a, b) => {
      const da = a.path.split('/').length;
      const db = b.path.split('/').length;
      if (da !== db) return da - db;
      const pa = a.path.slice(0, a.path.lastIndexOf('/') + 1);
      const pb = b.path.slice(0, b.path.lastIndexOf('/') + 1);
      if (pa !== pb) return pa.localeCompare(pb);
      const ad = a.type === 'directory';
      const bd = b.type === 'directory';
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return files;
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

  // ===================== Agent（子智能体）面板 =====================
  //
  // 存储：~/.codemoss/agent.json（单一 JSON 文件，非 .md），对齐 Java AgentManager。
  // 本面板 4 个回调全部接收 **JSON 字符串**（前端 useSettingsWindowCallbacks.ts 对每个回调都做
  // JSON.parse）：updateAgents / agentOperationResult / agentImportPreviewResult / agentImportResult。
  // 导出无前端回调（对齐 Java：仅落文件 + 原生提示），用 hx.window 提示成功/失败。

  /**
   * get_agents：读取 agent.json 全部 agent（createdAt 降序），回 updateAgents(JSON 字符串)。
   * 出错也回 '[]'，避免前端卡 loading（前端有 3s 超时但仍尽量及时回）。
   */
  _handleGetAgents() {
    let json = '[]';
    try {
      json = JSON.stringify(agentService.getAgents());
    } catch (e) {
      this.output.appendLine(`[router] get_agents 异常: ${e && e.message}`);
      json = '[]';
    }
    try {
      this.bridge.callJs('updateAgents', json);
    } catch (e) {
      this.output.appendLine(`[router] get_agents 回调失败: ${e && e.message}`);
    }
  }

  /**
   * add_agent：content 为 {id,name,prompt} JSON。写入后回 agentOperationResult。
   * 成功 {success:true,operation:'add'}；失败带 error。前端会随后自行 loadAgents 刷新列表。
   */
  _handleAddAgent(content) {
    let result;
    try {
      const agent = JSON.parse(content);
      agentService.addAgent(agent);
      result = { success: true, operation: 'add' };
    } catch (e) {
      this.output.appendLine(`[router] add_agent 异常: ${e && e.message}`);
      result = { success: false, operation: 'add', error: e && e.message ? e.message : String(e) };
    }
    this._emitAgentOperationResult(result);
  }

  /**
   * update_agent：content 为 {id, updates:{...}} JSON。合并更新后回 agentOperationResult。
   */
  _handleUpdateAgent(content) {
    let result;
    try {
      const data = JSON.parse(content);
      const id = data && data.id;
      const updates = (data && data.updates) || {};
      if (id == null) throw new Error('Missing required field: id');
      agentService.updateAgent(String(id), updates);
      result = { success: true, operation: 'update' };
    } catch (e) {
      this.output.appendLine(`[router] update_agent 异常: ${e && e.message}`);
      result = { success: false, operation: 'update', error: e && e.message ? e.message : String(e) };
    }
    this._emitAgentOperationResult(result);
  }

  /**
   * delete_agent：content 为 {id} JSON。删除后回 agentOperationResult。
   * 不存在时回 success:false + error:'Agent not found'（对齐 Java）。
   */
  _handleDeleteAgent(content) {
    let result;
    try {
      const data = JSON.parse(content);
      const id = data && data.id;
      if (id == null) throw new Error('Missing required field: id');
      const deleted = agentService.deleteAgent(String(id));
      result = deleted
        ? { success: true, operation: 'delete' }
        : { success: false, operation: 'delete', error: 'Agent not found' };
    } catch (e) {
      this.output.appendLine(`[router] delete_agent 异常: ${e && e.message}`);
      result = { success: false, operation: 'delete', error: e && e.message ? e.message : String(e) };
    }
    this._emitAgentOperationResult(result);
  }

  /** 统一回 agentOperationResult(JSON 字符串)。 */
  _emitAgentOperationResult(result) {
    try {
      this.bridge.callJs('agentOperationResult', JSON.stringify(result));
    } catch (e) {
      this.output.appendLine(`[router] agentOperationResult 回调失败: ${e && e.message}`);
    }
  }

  /**
   * export_agents：content 为 {agentIds:[...]}（空/无则导全部）。
   * 对齐 Java：弹「保存文件」对话框，把导出 JSON 写到用户选的文件；无前端回调，
   * 成功/失败用 hx.window.showInformationMessage/showErrorMessage 原生提示（best-effort）。
   */
  async _handleExportAgents(content) {
    let agentIds = [];
    try {
      const data = JSON.parse(content);
      if (data && Array.isArray(data.agentIds)) agentIds = data.agentIds;
    } catch (e) { /* 解析失败导全部 */ }

    try {
      await this._ensureCwd();
      const exportData = agentService.buildExportData(agentIds);
      const defaultName = agentService.defaultExportFilename();

      // HBuilderX 无原生 showSaveDialog；用 showFormDialog 让用户填「目录 + 文件名」。
      if (!(this.hx.window && typeof this.hx.window.showFormDialog === 'function')) {
        this._notifyError('当前 HBuilderX 版本不支持文件保存对话框');
        return;
      }

      const dialogResult = await this.hx.window.showFormDialog({
        title: '导出 Agent',
        subtitle: `将导出 ${exportData.agentCount} 个 Agent 到 JSON 文件`,
        width: 540,
        height: 280,
        submitButtonText: '导出',
        cancelButtonText: '取消',
        formItems: [
          {
            type: 'fileSelectInput',
            name: 'targetDir',
            mode: 'folder',
            label: '保存目录',
            placeholder: '请选择保存目录',
            value: this.cwd || '',
          },
          {
            type: 'input',
            name: 'fileName',
            label: '文件名',
            placeholder: '文件名（.json）',
            value: defaultName,
          },
        ],
      });

      const data = dialogResult && dialogResult.data;
      if (!data) {
        this.output.appendLine('[router] export_agents 已取消');
        return;
      }
      const targetDir = (typeof data === 'string' ? data : (data.targetDir || data.path || '')) || '';
      let fileName = (data && data.fileName) || defaultName;
      if (!targetDir) {
        this.output.appendLine('[router] export_agents 未选择目录，已取消');
        return;
      }
      if (!/\.json$/i.test(fileName)) fileName += '.json';

      const targetPath = path.join(targetDir, fileName);
      fs.writeFileSync(targetPath, JSON.stringify(exportData, null, 2), 'utf-8');
      this.output.appendLine(`[router] export_agents: 已导出 ${exportData.agentCount} 个 Agent -> ${targetPath}`);
      this._notifyInfo(`已导出 ${exportData.agentCount} 个 Agent 到 ${fileName}`);
    } catch (e) {
      this.output.appendLine(`[router] export_agents 异常: ${e && e.message}`);
      this._notifyError(`导出 Agent 失败: ${e && e.message ? e.message : String(e)}`);
    }
  }

  /**
   * import_agents_file：前端不带载荷。弹「选择 JSON 文件」对话框，解析为预览结构，
   * 回 agentImportPreviewResult(JSON 字符串)。预览结构必须含 items 数组 + summary 对象
   *（前端会校验，否则丢弃）。取消则不回调（无预览可弹）；解析失败用原生错误提示。
   */
  async _handleImportAgentsFile() {
    try {
      if (!(this.hx.window && typeof this.hx.window.showFormDialog === 'function')) {
        this._notifyError('当前 HBuilderX 版本不支持文件选择对话框');
        return;
      }
      await this._ensureCwd();

      const dialogResult = await this.hx.window.showFormDialog({
        title: '导入 Agent',
        subtitle: '选择一个导出的 JSON 文件（claude-code-agents-export-v1）',
        width: 540,
        height: 220,
        submitButtonText: '下一步',
        cancelButtonText: '取消',
        formItems: [
          {
            type: 'fileSelectInput',
            name: 'filePath',
            mode: 'file',
            label: 'Agent 文件',
            placeholder: '请选择 JSON 文件',
            value: this.cwd || '',
          },
        ],
      });

      const data = dialogResult && dialogResult.data;
      let filePath = data
        ? (typeof data === 'string' ? data : (data.filePath || data.path || ''))
        : '';
      if (!filePath) {
        this.output.appendLine('[router] import_agents_file 已取消或未选择文件');
        return;
      }

      if (!fs.existsSync(filePath)) {
        this._notifyError('文件不存在: ' + filePath);
        return;
      }
      const stat = fs.statSync(filePath);
      if (stat.size > 5 * 1024 * 1024) {
        this._notifyError('文件过大（> 5MB），请减少条目数量');
        return;
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const preview = agentService.buildImportPreview(fileContent);
      this.output.appendLine(`[router] import_agents_file: total=${preview.summary.total} new=${preview.summary.newCount} update=${preview.summary.updateCount}`);
      try {
        this.bridge.callJs('agentImportPreviewResult', JSON.stringify(preview));
      } catch (e) {
        this.output.appendLine(`[router] agentImportPreviewResult 回调失败: ${e && e.message}`);
      }
    } catch (e) {
      this.output.appendLine(`[router] import_agents_file 异常: ${e && e.message}`);
      this._notifyError(`加载导入文件失败: ${e && e.message ? e.message : String(e)}`);
    }
  }

  /**
   * save_imported_agents：content 为 {agents:[...], strategy}。按策略批量导入，
   * 回 agentImportResult(JSON 字符串)：{success, imported, updated, skipped, error?}。
   * 前端收到后会 toast 并自行 loadAgents 刷新列表。出错也回 success:false。
   */
  _handleSaveImportedAgents(content) {
    let result;
    try {
      const data = JSON.parse(content);
      if (!data || !Array.isArray(data.agents)) {
        throw new Error('Missing required fields: agents or strategy');
      }
      const strategy = data.strategy;
      const r = agentService.batchImportAgents(data.agents, strategy);
      result = { success: r.success, imported: r.imported, updated: r.updated, skipped: r.skipped };
      this.output.appendLine(`[router] save_imported_agents: imported=${r.imported} updated=${r.updated} skipped=${r.skipped}`);
    } catch (e) {
      this.output.appendLine(`[router] save_imported_agents 异常: ${e && e.message}`);
      result = { success: false, imported: 0, updated: 0, skipped: 0, error: e && e.message ? e.message : String(e) };
    }
    try {
      this.bridge.callJs('agentImportResult', JSON.stringify(result));
    } catch (e) {
      this.output.appendLine(`[router] agentImportResult 回调失败: ${e && e.message}`);
    }
  }

  /** best-effort 原生信息提示（API 不存在则只记日志）。 */
  _notifyInfo(msg) {
    try {
      if (this.hx.window && typeof this.hx.window.showInformationMessage === 'function') {
        this.hx.window.showInformationMessage(msg);
      }
    } catch (e) { /* ignore */ }
  }

  /** best-effort 原生错误提示（API 不存在则只记日志）。 */
  _notifyError(msg) {
    this.output.appendLine(`[router] ${msg}`);
    try {
      if (this.hx.window && typeof this.hx.window.showErrorMessage === 'function') {
        this.hx.window.showErrorMessage(msg);
      }
    } catch (e) { /* ignore */ }
  }

  // ===================== MCP 服务器面板 =====================
  //
  // 前端来源：webview/src/components/mcp/*。messagePrefix：claude='' / codex='codex_'，
  // 即 claude 事件 get_mcp_servers，codex 事件 get_codex_mcp_servers，回调相应带/不带 Codex。
  //
  // 回调传参（已逐一核对前端，三个回调函数体第一行都对参数 JSON.parse，故后端必须传 JSON 字符串）：
  //   - updateMcpServers / updateCodexMcpServers      <- JSON.stringify(McpServer[])
  //   - updateMcpServerStatus / updateCodexMcpServerStatus <- JSON.stringify(McpServerStatusInfo[])
  //   - updateMcpServerTools （codex 也复用这个回调名）<- JSON.stringify({serverId,serverName,tools,error})
  //
  // 存储（对齐 Java + ai-bridge mcp-status/config-loader）：
  //   - Claude：~/.claude.json 的 mcpServers / disabledMcpServers（含项目级 projects[cwd].*），读-改-写保留其它字段。
  //   - Codex：~/.codex/config.toml 的 [mcp_servers.<id>]（极简 TOML，enabled 字段控制启停）。
  //
  // 实时状态/工具走 ai-bridge daemon RPC：claude.getMcpServerStatus({cwd}) / claude.getMcpServerTools({serverId,cwd})，
  // daemon 把结果以 [MCP_SERVER_STATUS]<json> / [MCP_SERVER_TOOLS] <json> 标记行经 onLine 回灌；
  // 解析到则用其结果，接不通/超时则优雅降级（status 回 unknown / tools 回空），绝不让前端卡 loading。

  /** 取回调名（带/不带 Codex 前缀）。 */
  _mcpCb(provider, claudeName, codexName) {
    return provider === 'codex' ? codexName : claudeName;
  }

  /**
   * get_mcp_servers / get_codex_mcp_servers：读配置文件，回 updateMcpServers / updateCodexMcpServers。
   * 出错也回 '[]'，前端不卡 loading。
   */
  async _handleGetMcpServers(provider) {
    const cb = this._mcpCb(provider, 'updateMcpServers', 'updateCodexMcpServers');
    let list = [];
    try {
      await this._ensureCwd();
      list = provider === 'codex'
        ? mcpService.getCodexServers()
        : mcpService.getClaudeServers(this.cwd || '');
      this.output.appendLine(`[router] get_mcp_servers(${provider}): ${list.length} 个`);
    } catch (e) {
      this.output.appendLine(`[router] get_mcp_servers(${provider}) 异常: ${e && e.message}`);
      list = [];
    }
    try {
      this.bridge.callJs(cb, JSON.stringify(list));
    } catch (e) {
      this.output.appendLine(`[router] ${cb} 回调失败: ${e && e.message}`);
    }
  }

  /**
   * add/update_mcp_server（及 codex 变体）：content 为整个 McpServer 对象 JSON。
   * upsert 落盘后**重新读列表回前端**（前端 add/update 后期望看到刷新的 updateMcpServers）。
   * 出错也回当前列表（best-effort）+ 记日志。
   */
  async _handleUpsertMcpServer(provider, content, isUpdate) {
    let server = null;
    try { server = JSON.parse(content); } catch (e) { server = null; }
    try {
      await this._ensureCwd();
      if (!server || server.id == null) throw new Error('Missing required field: id');
      if (provider === 'codex') {
        mcpService.upsertCodexServer(server);
      } else {
        mcpService.upsertClaudeServer(server, this.cwd || '');
      }
      this.output.appendLine(`[router] ${isUpdate ? 'update' : 'add'}_mcp_server(${provider}): id=${server.id}`);
    } catch (e) {
      this.output.appendLine(`[router] ${isUpdate ? 'update' : 'add'}_mcp_server(${provider}) 异常: ${e && e.message}`);
      this._notifyError(`保存 MCP 服务器失败: ${e && e.message ? e.message : String(e)}`);
    }
    // 无论成功失败都回最新列表，让前端与磁盘一致
    this._handleGetMcpServers(provider);
  }

  /**
   * delete_mcp_server（及 codex 变体）：content 为 { id } JSON。删除后回最新列表。
   */
  async _handleDeleteMcpServer(provider, content) {
    let id = '';
    try {
      const obj = JSON.parse(content);
      id = (obj && obj.id != null) ? String(obj.id) : '';
    } catch (e) { id = ''; }
    try {
      await this._ensureCwd();
      if (!id) throw new Error('Missing required field: id');
      if (provider === 'codex') mcpService.deleteCodexServer(id);
      else mcpService.deleteClaudeServer(id);
      this.output.appendLine(`[router] delete_mcp_server(${provider}): id=${id}`);
    } catch (e) {
      this.output.appendLine(`[router] delete_mcp_server(${provider}) 异常: ${e && e.message}`);
      this._notifyError(`删除 MCP 服务器失败: ${e && e.message ? e.message : String(e)}`);
    }
    this._handleGetMcpServers(provider);
  }

  /**
   * toggle_mcp_server（及 codex 变体）：content 为整个 McpServer 对象（带新 enabled/apps）JSON。
   * 仅维护启停态（Claude 改 disabledMcpServers，Codex 改段内 enabled），落盘后回最新列表。
   */
  async _handleToggleMcpServer(provider, content) {
    let server = null;
    try { server = JSON.parse(content); } catch (e) { server = null; }
    try {
      await this._ensureCwd();
      if (!server || server.id == null) throw new Error('Missing required field: id');
      if (provider === 'codex') mcpService.toggleCodexServer(server);
      else mcpService.toggleClaudeServer(server, this.cwd || '');
      this.output.appendLine(`[router] toggle_mcp_server(${provider}): id=${server.id} enabled=${server.enabled !== false}`);
    } catch (e) {
      this.output.appendLine(`[router] toggle_mcp_server(${provider}) 异常: ${e && e.message}`);
      this._notifyError(`切换 MCP 服务器失败: ${e && e.message ? e.message : String(e)}`);
    }
    this._handleGetMcpServers(provider);
  }

  /**
   * get_mcp_server_status / get_codex_mcp_server_status：查实时连接状态。
   * 走 daemon RPC claude.getMcpServerStatus({cwd})，解析 [MCP_SERVER_STATUS]<json> 标记行；
   * 接不通/超时 → 对每个已配置服务器回 status:'unknown' 降级（前端不卡 loading）。
   * 注意：Codex 暂无 daemon 状态 RPC，统一对其全部服务器回 unknown 降级。
   */
  async _handleGetMcpServerStatus(provider) {
    const cb = this._mcpCb(provider, 'updateMcpServerStatus', 'updateCodexMcpServerStatus');
    let statusList = null;
    try {
      await this._ensureCwd();
      if (provider === 'claude' && this.aiBridge) {
        statusList = await this._queryMcpStatusViaDaemon(this.cwd || '');
      }
    } catch (e) {
      this.output.appendLine(`[router] get_mcp_server_status(${provider}) 异常: ${e && e.message}`);
      statusList = null;
    }

    // 降级：daemon 未就绪/失败/Codex → 用当前配置列表回 unknown 状态
    if (!Array.isArray(statusList)) {
      try {
        const servers = provider === 'codex'
          ? mcpService.getCodexServers()
          : mcpService.getClaudeServers(this.cwd || '');
        statusList = servers.map((s) => ({
          name: s.id,
          status: s.enabled === false ? 'failed' : 'unknown',
          error: s.enabled === false ? 'Server is disabled' : undefined,
        }));
        this.output.appendLine(`[router] get_mcp_server_status(${provider}) 降级 unknown: ${statusList.length} 个`);
      } catch (e) {
        statusList = [];
      }
    } else {
      this.output.appendLine(`[router] get_mcp_server_status(${provider}) daemon: ${statusList.length} 个`);
    }

    try {
      this.bridge.callJs(cb, JSON.stringify(statusList));
    } catch (e) {
      this.output.appendLine(`[router] ${cb} 回调失败: ${e && e.message}`);
    }
  }

  /**
   * get_mcp_server_tools / get_codex_mcp_server_tools：查某服务器工具列表。
   * content 为 { serverId, forceRefresh }。走 daemon RPC claude.getMcpServerTools({serverId,cwd})，
   * 解析 [MCP_SERVER_TOOLS] <json>；接不通/超时 → 回 {serverId, tools:[], error} 降级。
   * Codex 暂无 daemon 工具 RPC → 直接回空工具列表 success。前端回调（updateMcpServerTools）做 JSON.parse。
   */
  async _handleGetMcpServerTools(provider, content) {
    const cb = this._mcpCb(provider, 'updateMcpServerTools', 'updateMcpServerTools'); // codex 也复用 updateMcpServerTools
    let serverId = '';
    try {
      const obj = JSON.parse(content);
      serverId = (obj && obj.serverId != null) ? String(obj.serverId) : '';
    } catch (e) { serverId = ''; }

    let result = null;
    try {
      await this._ensureCwd();
      if (!serverId) throw new Error('Missing required field: serverId');
      if (provider === 'claude' && this.aiBridge) {
        result = await this._queryMcpToolsViaDaemon(serverId, this.cwd || '');
      }
    } catch (e) {
      this.output.appendLine(`[router] get_mcp_server_tools(${provider}) 异常: ${e && e.message}`);
      result = null;
    }

    // 降级：daemon 未就绪/失败/Codex → 回空工具列表（前端按 0 工具且无 error 视为空结果，不卡）
    if (!result || typeof result !== 'object') {
      result = { serverId, serverName: serverId, tools: [] };
      this.output.appendLine(`[router] get_mcp_server_tools(${provider}) 降级空列表: serverId=${serverId}`);
    } else {
      // 确保 serverId 字段存在（前端按它定位是哪台服务器）
      if (result.serverId == null) result.serverId = serverId;
      this.output.appendLine(`[router] get_mcp_server_tools(${provider}): serverId=${serverId} tools=${(result.tools || []).length}`);
    }

    try {
      this.bridge.callJs(cb, JSON.stringify(result));
    } catch (e) {
      this.output.appendLine(`[router] ${cb} 回调失败: ${e && e.message}`);
    }
  }

  /**
   * 经 daemon 查 MCP 状态：发 claude.getMcpServerStatus，从 onLine 标记行抓 [MCP_SERVER_STATUS]<json>。
   * 返回解析出的数组；未拿到则返回 null（让上层走降级）。
   * daemon 该命令输出形如：console.log('[MCP_SERVER_STATUS]' + JSON.stringify(arr))（标记紧贴 json，无空格）。
   */
  async _queryMcpStatusViaDaemon(cwd) {
    let captured = null;
    const onLine = (line) => {
      const s = typeof line === 'string' ? line : '';
      const idx = s.indexOf('[MCP_SERVER_STATUS]');
      if (idx !== -1) {
        const jsonStr = s.slice(idx + '[MCP_SERVER_STATUS]'.length).trim();
        try {
          const arr = JSON.parse(jsonStr);
          if (Array.isArray(arr)) captured = arr;
        } catch (e) { /* 非完整 json 行，忽略 */ }
      }
    };
    const result = await this.aiBridge.request('claude.getMcpServerStatus', { cwd: cwd || '' }, onLine);
    if (!result || result.success === false) {
      this.output.appendLine(`[router] daemon getMcpServerStatus 失败: ${result && result.error}`);
    }
    return captured; // 可能为 null（上层降级）
  }

  /**
   * 经 daemon 查 MCP 工具：发 claude.getMcpServerTools，从 onLine 抓 [MCP_SERVER_TOOLS] <json>。
   * 返回 { serverId, serverName, tools, error }；未拿到则返回 null（上层降级）。
   * daemon 输出形如：console.log('[MCP_SERVER_TOOLS]', resultJson) → 标记 + 空格 + json，随后还会单独打一行裸 json。
   */
  async _queryMcpToolsViaDaemon(serverId, cwd) {
    let captured = null;
    const onLine = (line) => {
      const s = typeof line === 'string' ? line : '';
      const idx = s.indexOf('[MCP_SERVER_TOOLS]');
      if (idx !== -1) {
        const jsonStr = s.slice(idx + '[MCP_SERVER_TOOLS]'.length).trim();
        try {
          const obj = JSON.parse(jsonStr);
          if (obj && typeof obj === 'object') captured = obj;
        } catch (e) { /* 忽略不完整行 */ }
      }
    };
    const result = await this.aiBridge.request('claude.getMcpServerTools', { serverId, cwd: cwd || '' }, onLine);
    if (!result || result.success === false) {
      this.output.appendLine(`[router] daemon getMcpServerTools 失败: ${result && result.error}`);
    }
    return captured;
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
