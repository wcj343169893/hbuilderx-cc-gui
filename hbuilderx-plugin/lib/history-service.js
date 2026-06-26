'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 历史会话服务。
 *
 * 移植自 JetBrains(Java) 版的历史能力（权威语义对齐）：
 *   - src/.../provider/claude/ClaudeHistoryReader + ClaudeHistoryIndexService + ClaudeSessionLiteReader
 *     （会话列表：title / messageCount / entrypoint / 时间）
 *   - src/.../handler/history/HistoryLoadService（列表 + favorites/titles 合并增强）
 *   - src/.../session/MessageParser + SessionMessageOrchestrator（JSONL -> ClaudeMessage 重放）
 *   - src/.../handler/history/HistoryDeleteService（删除主会话 + 关联 agent-*.jsonl）
 *   - src/.../handler/history/HistoryExportService（导出）
 *   - ai-bridge/services/favorites-service.cjs / session-titles-service.cjs（收藏/标题存储）
 *
 * 关键对齐点（务必与 Java/CLI 一致，否则找不到会话或重载丢数据）：
 *   1. 会话 JSONL 存储：~/.claude/projects/<sanitizePath(cwd)>/<sessionId>.jsonl
 *      sanitizePath = cwd.replace(/[^a-zA-Z0-9]/g, '-')（对齐 Java PathUtils.sanitizePath
 *      与 ai-bridge session-service.js persistJsonlMessage 的同款编码）。
 *   2. 收藏：~/.codemoss/favorites.json，形如 { "<sessionId>": { "favoritedAt": <ms> } }。
 *   3. 自定义标题：~/.codemoss/session-titles.json，形如
 *      { "<sessionId>": { "customTitle": "...", "updatedAt": <ms> } }（最长 50 字符）。
 *   这两个 sidecar 与 ai-bridge 的 .cjs 服务完全同路径同格式，重载后保留收藏/标题。
 *
 * 设计：纯数据/文件逻辑放本模块（无 hbuilderx 依赖，便于 node --check 与单测）；
 * router 只负责取 cwd、调用本模块、把结果 callJs 回前端，并保证出错也回对应回调。
 */

// ==================== 路径解析 ====================

/** Claude 配置根：~/.claude。 */
function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

/** Claude 会话项目根：~/.claude/projects。 */
function getProjectsDir() {
  return path.join(getClaudeDir(), 'projects');
}

/** CodeMoss 配置根：~/.codemoss（收藏/标题 sidecar 落盘处）。 */
function getCodemossDir() {
  return path.join(os.homedir(), '.codemoss');
}

function getFavoritesFile() {
  return path.join(getCodemossDir(), 'favorites.json');
}

function getTitlesFile() {
  return path.join(getCodemossDir(), 'session-titles.json');
}

/**
 * 把工作区路径编码为 ~/.claude/projects 下的目录名。
 * 必须与 Java PathUtils.sanitizePath 完全一致：所有非字母数字字符替换为 '-'。
 * 例：D:\Projects\My-App -> D--Projects-My-App
 */
function sanitizePath(p) {
  if (!p) return '';
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

/** 某项目的会话目录：~/.claude/projects/<sanitized>。 */
function getProjectSessionDir(cwd) {
  if (!cwd) return null;
  return path.join(getProjectsDir(), sanitizePath(cwd));
}

// ==================== sidecar：收藏 / 标题 ====================

/** 读 JSON 文件，失败/不存在返回 {}（对齐 .cjs 服务的容错行为）。 */
function readJsonObjectSafe(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const data = fs.readFileSync(file, 'utf-8');
    const obj = JSON.parse(data);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

/** 原子写 JSON（先写 .tmp 再 rename，对齐 session-titles-service.cjs 的 saveTitles）。 */
function writeJsonObjectAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 读全部收藏：{ sessionId: { favoritedAt } }。 */
function loadFavorites() {
  return readJsonObjectSafe(getFavoritesFile());
}

/** 读全部自定义标题：{ sessionId: { customTitle, updatedAt } }。 */
function loadTitles() {
  return readJsonObjectSafe(getTitlesFile());
}

/**
 * 切换收藏态并落盘。对齐 favorites-service.cjs toggleFavorite。
 * @returns {{ success: boolean, isFavorited: boolean, error?: string }}
 */
function toggleFavorite(sessionId) {
  if (!isValidSessionId(sessionId)) {
    return { success: false, isFavorited: false, error: 'Invalid session ID' };
  }
  try {
    const favorites = loadFavorites();
    const wasFavorited = !!favorites[sessionId];
    if (wasFavorited) {
      delete favorites[sessionId];
    } else {
      favorites[sessionId] = { favoritedAt: Date.now() };
    }
    writeJsonObjectAtomic(getFavoritesFile(), favorites);
    return { success: true, isFavorited: !wasFavorited };
  } catch (e) {
    return { success: false, isFavorited: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 删除收藏条目（删除会话时清理 sidecar，对齐 Java cleanupSessionMetadata）。 */
function removeFavorite(sessionId) {
  try {
    const favorites = loadFavorites();
    if (!favorites[sessionId]) return true;
    delete favorites[sessionId];
    writeJsonObjectAtomic(getFavoritesFile(), favorites);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 更新自定义标题并落盘。对齐 session-titles-service.cjs updateTitle（最长 50 字符）。
 * @returns {{ success: boolean, title?: string, error?: string }}
 */
function updateTitle(sessionId, customTitle) {
  if (!isValidSessionId(sessionId)) {
    return { success: false, error: 'Invalid session ID' };
  }
  try {
    if (customTitle && customTitle.length > 50) {
      return { success: false, error: 'Title too long (max 50 characters)' };
    }
    const titles = loadTitles();
    titles[sessionId] = { customTitle: customTitle, updatedAt: Date.now() };
    writeJsonObjectAtomic(getTitlesFile(), titles);
    return { success: true, title: customTitle };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 删除自定义标题条目（删除会话时清理 sidecar）。 */
function deleteTitle(sessionId) {
  try {
    const titles = loadTitles();
    if (!titles[sessionId]) return true;
    delete titles[sessionId];
    writeJsonObjectAtomic(getTitlesFile(), titles);
    return true;
  } catch (e) {
    return false;
  }
}

// ==================== 校验 ====================

/** sessionId 安全校验（防路径穿越）：仅 [A-Za-z0-9._-]，对齐 Java HistoryDeleteService。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && SESSION_ID_PATTERN.test(sessionId);
}

/** UUID 文件名校验（会话主文件名 = <uuid>.jsonl），对齐 Java extractSessionId。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ==================== 会话列表（lite 扫描） ====================

/**
 * 从一行 JSONL 提取首条 user 文本（首段提示词），对齐 Java extractFirstPromptFromHead 的语义。
 * content 既可能是字符串，也可能是 content blocks 数组。
 */
function extractTextFromMessageObj(obj) {
  const message = obj && obj.message;
  const content = message ? message.content : null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * 判断某行是否「命令噪声」用户消息（如 <command-name> 等），列表标题应跳过。
 * 对齐 Java MessageParser.shouldFilterCommandMessage（允许含 <command-message> 的真实用户输入）。
 */
function isCommandNoiseText(text) {
  if (!text) return false;
  const hasCommandMessage = text.indexOf('<command-message>') !== -1 && text.indexOf('</command-message>') !== -1;
  if (hasCommandMessage) return false;
  return text.indexOf('<command-name>') !== -1
    || text.indexOf('<local-command-stdout>') !== -1
    || text.indexOf('<local-command-stderr>') !== -1
    || text.indexOf('<command-args>') !== -1;
}

/**
 * 标题/摘要是否为无效会话（agent/warmup/no prompt），对齐 Java isValidSession。
 */
function isInvalidSummary(summary) {
  if (!summary) return true;
  const lower = summary.toLowerCase();
  return lower === 'warmup' || lower === 'no prompt'
    || lower.startsWith('warmup') || lower.startsWith('no prompt');
}

/**
 * 读取并解析一个会话 JSONL 文件，提取列表元数据。
 * 注意：HBuilderX 内置 Node 无 Java 版的 head/tail lite-read 优化，这里整文件逐行读，
 * 但只在内存里做轻量字段提取（不构造前端消息），对中小型历史足够。
 *
 * @returns {object|null} SessionInfo 或 null（应过滤：sidechain / 无摘要 / 无效）
 */
function readSessionInfo(sessionFile, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(sessionFile, 'utf-8');
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  const lines = raw.split(/\r?\n/);
  let firstPrompt = null; // 首条非命令噪声的 user 文本
  let customTitle = null; // JSONL 内嵌 customTitle（CLI 可能写入）
  let aiTitle = null;
  let lastPrompt = null;
  let summaryLine = null; // type=summary 行的 summary 字段
  let entrypoint = null;
  let firstTimestamp = null;
  let isSidechain = false;
  let messageCount = 0;

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      continue; // 跳过坏行
    }
    if (!obj || typeof obj !== 'object') continue;

    // sidechain 会话整体跳过（与 Java 一致：不在历史列表展示）
    if (obj.isSidechain === true) isSidechain = true;

    // 内嵌标题字段（CLI 有时把 customTitle/aiTitle 写进 JSONL）
    if (customTitle == null && typeof obj.customTitle === 'string' && obj.customTitle) customTitle = obj.customTitle;
    if (aiTitle == null && typeof obj.aiTitle === 'string' && obj.aiTitle) aiTitle = obj.aiTitle;
    if (typeof obj.lastPrompt === 'string' && obj.lastPrompt) lastPrompt = obj.lastPrompt;
    if (entrypoint == null && typeof obj.entrypoint === 'string' && obj.entrypoint) entrypoint = obj.entrypoint;
    if (firstTimestamp == null && typeof obj.timestamp === 'string' && obj.timestamp) firstTimestamp = obj.timestamp;

    // type=summary 行（CLI 压缩/摘要）
    if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary && summaryLine == null) {
      summaryLine = obj.summary;
    }

    // 统计可见消息数（user/assistant），并取首条有效 user 文本作为标题候选
    if (obj.type === 'user' || obj.type === 'assistant') {
      if (obj.isMeta === true) continue; // 元消息不计入
      messageCount++;
      if (obj.type === 'user' && firstPrompt == null) {
        const text = extractTextFromMessageObj(obj);
        if (text && text.trim() && !isCommandNoiseText(text)) {
          firstPrompt = text.trim();
        }
      }
    }
  }

  if (isSidechain) return null;
  if (sessionId && sessionId.startsWith('agent-')) return null;

  // 摘要/标题优先级（对齐 Java parseSessionInfoFromLite）：
  //   userTitle(customTitle>aiTitle) > lastPrompt > summary(行) > firstPrompt
  let userTitle = customTitle != null ? customTitle : aiTitle;
  let summary = userTitle;
  if (summary == null) summary = lastPrompt;
  if (summary == null) summary = summaryLine;
  if (summary == null) summary = firstPrompt;

  if (summary == null || summary === '') return null; // metadata-only 会话跳过
  if (isInvalidSummary(summary)) return null;

  let createdAt = 0;
  if (firstTimestamp) {
    const t = Date.parse(firstTimestamp);
    if (!Number.isNaN(t)) createdAt = t;
  }

  let stat;
  try {
    stat = fs.statSync(sessionFile);
  } catch (e) {
    stat = null;
  }
  const lastTimestamp = stat ? stat.mtimeMs : 0;
  const fileSize = stat ? stat.size : 0;

  return {
    sessionId: sessionId,
    title: summary,
    messageCount: messageCount,
    lastTimestamp: lastTimestamp,
    firstTimestamp: createdAt,
    fileSize: fileSize,
    entrypoint: entrypoint || null,
    createdAt: createdAt || undefined,
  };
}

/**
 * 扫描某项目的全部 Claude 会话，按 lastTimestamp 倒序。
 * @returns {object[]} SessionInfo 列表
 */
function scanProjectSessions(cwd) {
  const dir = getProjectSessionDir(cwd);
  if (!dir || !fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() && !(entry.isSymbolicLink && entry.isSymbolicLink())) continue;
    const name = entry.name;
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (!UUID_PATTERN.test(sessionId)) continue; // 仅纯 uuid 会话文件（排除 agent-*.jsonl 等）

    const full = path.join(dir, name);
    const info = readSessionInfo(full, sessionId.toLowerCase());
    if (info) sessions.push(info);
  }

  sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return sessions;
}

/**
 * 加载历史数据（列表 + 收藏 + 自定义标题增强），形态对齐前端 HistoryData。
 * 仅支持 claude provider（HBuilderX 移植聚焦 Claude）；其它 provider 回空列表但 success:true。
 *
 * @param {string} cwd 当前工作区根
 * @param {string} provider provider 标识（默认 claude）
 * @returns {object} HistoryData：{ success, sessions, total, favorites, currentProject, sessionCount }
 */
function loadHistoryData(cwd, provider) {
  const prov = provider || 'claude';
  try {
    if (prov !== 'claude') {
      // Codex 等暂不支持：回空但不报错，避免前端卡 loading
      return { success: true, sessions: [], total: 0, favorites: {}, currentProject: cwd || '', sessionCount: 0 };
    }

    const sessions = scanProjectSessions(cwd);
    const favorites = loadFavorites();
    const titles = loadTitles();

    let total = 0;
    for (const s of sessions) {
      total += s.messageCount || 0;

      // provider 标记
      s.provider = prov;

      // 收藏增强
      const fav = favorites[s.sessionId];
      if (fav && typeof fav.favoritedAt !== 'undefined') {
        s.isFavorited = true;
        s.favoritedAt = fav.favoritedAt;
      } else {
        s.isFavorited = false;
      }

      // 自定义标题增强（覆盖原 title）
      const titleInfo = titles[s.sessionId];
      if (titleInfo && typeof titleInfo.customTitle === 'string') {
        s.title = titleInfo.customTitle;
        s.hasCustomTitle = true;
      }
    }

    return {
      success: true,
      sessions: sessions,
      total: total,
      favorites: favorites,
      currentProject: cwd || '',
      sessionCount: sessions.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e), sessions: [], total: 0, favorites: {} };
  }
}

// ==================== 会话消息读取（重放 / 导出共用） ====================

/**
 * 读取某会话 JSONL 全部原始行（解析为对象数组）。导出用原始行；重放再转 ClaudeMessage。
 * @returns {object[]} 原始 JSONL 对象数组（按文件顺序）
 */
function readSessionRawMessages(cwd, sessionId) {
  if (!isValidSessionId(sessionId)) return [];
  const dir = getProjectSessionDir(cwd);
  if (!dir) return [];
  const sessionFile = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(sessionFile)) return [];

  let raw;
  try {
    raw = fs.readFileSync(sessionFile, 'utf-8');
  } catch (e) {
    return [];
  }

  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (e) { /* 跳过坏行 */ }
  }
  return out;
}

/** content blocks 是否包含某类型块。 */
function contentHasBlockType(obj, blockType) {
  const tryArr = (arr) => Array.isArray(arr) && arr.some((b) => b && b.type === blockType);
  if (tryArr(obj && obj.content)) return true;
  if (obj && obj.message && tryArr(obj.message.content)) return true;
  return false;
}

/**
 * 从 JSONL 原始行中找出最后一条 assistant 消息的 usage 对象。
 * 对齐 Java TokenUsageUtils.findLastUsageFromRawMessages：
 * 从尾部向头部扫描，找最后一条 type=assistant 且携带 message.usage 的行。
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {object|null} { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } 或 null
 */
function findLastUsageFromRawMessages(cwd, sessionId) {
  const raws = readSessionRawMessages(cwd, sessionId);
  for (let i = raws.length - 1; i >= 0; i--) {
    const obj = raws[i];
    if (obj.type !== 'assistant') continue;
    const usage = obj.message && obj.message.usage;
    if (usage && typeof usage === 'object') {
      return {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      };
    }
  }
  return null;
}

/**
 * 把一条 JSONL 原始行转换为前端 ClaudeMessage（或 null 表示过滤）。
 * 严格对齐 Java MessageParser.parseServerMessage 的取舍：
 *   - 过滤 isMeta
 *   - 过滤 user 命令噪声消息
 *   - user：有文本 -> {type:user, content, raw}；无文本但含 tool_result -> content '[tool_result]'；
 *     无文本但含 image -> content ''；否则 null
 *   - assistant：{type:assistant, content(纯文本拼接), raw}
 *   - 其它 type（system/summary/result 等）-> null（不在聊天区重放）
 *
 * raw 形态对齐 _trimRaw / MessageJsonConverter.buildTransportRaw：保留 message.content 块 + uuid 等。
 */
function jsonlLineToClaudeMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const type = obj.type;

  if (obj.isMeta === true) return null;

  const text = extractTextFromMessageObj(obj);

  if (type === 'user') {
    if (isCommandNoiseText(text)) return null;
    const raw = buildTransportRaw(obj);
    if (!text || !text.trim()) {
      if (contentHasBlockType(obj, 'tool_result')) {
        return { type: 'user', content: '[tool_result]', raw: raw, timestamp: obj.timestamp || isoNow() };
      }
      if (contentHasBlockType(obj, 'image')) {
        return { type: 'user', content: '', raw: raw, timestamp: obj.timestamp || isoNow() };
      }
      return null;
    }
    return { type: 'user', content: text, raw: raw, timestamp: obj.timestamp || isoNow() };
  }

  if (type === 'assistant') {
    const raw = buildTransportRaw(obj);
    return { type: 'assistant', content: text || '', raw: raw, timestamp: obj.timestamp || isoNow() };
  }

  return null;
}

function isoNow() {
  return new Date().toISOString();
}

/**
 * 构建前端 transport raw：仅保留前端需要的字段，避免把整条 JSONL（含 cwd/gitBranch 等）发给前端。
 * 对齐 claude-session.js 的 _trimRaw 与 Java MessageJsonConverter.buildTransportRaw。
 */
function buildTransportRaw(obj) {
  const t = {};
  for (const k of ['uuid', 'type', 'isMeta', 'text', 'origin', 'turnUsage']) {
    if (obj[k] !== undefined) t[k] = obj[k];
  }
  if (obj.content !== undefined) t.content = obj.content;
  if (obj.message && typeof obj.message === 'object' && obj.message.content !== undefined) {
    t.message = { content: obj.message.content };
  }
  return t;
}

/**
 * 读取并转换某会话的全部可重放消息（ClaudeMessage 列表）。
 * @returns {object[]} ClaudeMessage 列表（重放顺序）
 */
function loadSessionMessages(cwd, sessionId) {
  const raws = readSessionRawMessages(cwd, sessionId);
  const out = [];
  for (const obj of raws) {
    const msg = jsonlLineToClaudeMessage(obj);
    if (msg) out.push(msg);
  }
  return out;
}

// ==================== 删除 ====================

/**
 * 删除单个会话：删除 <sessionId>.jsonl 及其关联 agent-*.jsonl（前 20 行含该 sessionId）。
 * 对齐 Java HistoryDeleteService.deleteClaudeSession + cleanupSessionMetadata。
 * @returns {{ success: boolean, mainDeleted: boolean, agentFilesDeleted: number, error?: string }}
 */
function deleteSession(cwd, sessionId) {
  if (!isValidSessionId(sessionId)) {
    return { success: false, mainDeleted: false, agentFilesDeleted: 0, error: 'Invalid session ID' };
  }
  const dir = getProjectSessionDir(cwd);
  if (!dir || !fs.existsSync(dir)) {
    return { success: false, mainDeleted: false, agentFilesDeleted: 0, error: 'Project session dir not found' };
  }

  let mainDeleted = false;
  let agentFilesDeleted = 0;
  try {
    const dirResolved = path.resolve(dir);
    const mainFile = path.resolve(path.join(dir, sessionId + '.jsonl'));
    // 越界保护：删除目标必须仍在项目会话目录之下
    if (!mainFile.startsWith(dirResolved + path.sep) && mainFile !== dirResolved) {
      return { success: false, mainDeleted: false, agentFilesDeleted: 0, error: 'Refused out-of-bounds path' };
    }
    if (fs.existsSync(mainFile)) {
      fs.unlinkSync(mainFile);
      mainDeleted = true;
    }

    // 关联 agent 文件：agent-*.jsonl 且前 20 行含 sessionId / parentSessionId
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) { entries = []; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      const agentFile = path.join(dir, name);
      if (agentFileBelongsToSession(agentFile, sessionId)) {
        try {
          fs.unlinkSync(agentFile);
          agentFilesDeleted++;
        } catch (e) { /* 单个 agent 文件删失败不影响整体 */ }
      }
    }

    // 删除主文件成功才清理 sidecar（对齐 Java：仅在 mainDeleted 时清理元数据）
    if (mainDeleted) {
      removeFavorite(sessionId);
      deleteTitle(sessionId);
    }

    return { success: mainDeleted, mainDeleted: mainDeleted, agentFilesDeleted: agentFilesDeleted };
  } catch (e) {
    return { success: false, mainDeleted: mainDeleted, agentFilesDeleted: agentFilesDeleted, error: e && e.message ? e.message : String(e) };
  }
}

/** 读 agent 文件前 20 行判断是否属于该 session（对齐 Java isAgentFileRelatedToSession）。 */
function agentFileBelongsToSession(agentFile, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(agentFile, 'utf-8');
  } catch (e) {
    return false;
  }
  const lines = raw.split(/\r?\n/);
  const limit = Math.min(20, lines.length);
  const needleA = '"sessionId":"' + sessionId + '"';
  const needleB = '"parentSessionId":"' + sessionId + '"';
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (line && (line.indexOf(needleA) !== -1 || line.indexOf(needleB) !== -1)) return true;
  }
  return false;
}

/**
 * 批量删除会话。content 为 JSON 数组字符串或 { sessionIds: [...] }。
 * @returns {{ success: boolean, mainDeletedCount: number, total: number }}
 */
function deleteSessions(cwd, sessionIds) {
  const ids = parseSessionIds(sessionIds);
  let mainDeletedCount = 0;
  for (const id of ids) {
    try {
      const r = deleteSession(cwd, id);
      if (r.mainDeleted) mainDeletedCount++;
    } catch (e) { /* 单个失败不影响其余 */ }
  }
  return { success: true, mainDeletedCount: mainDeletedCount, total: ids.length };
}

/** 解析批量删除的 sessionId 列表（去重、去非法），对齐 Java parseSessionIds。 */
function parseSessionIds(content) {
  const result = [];
  const seen = new Set();
  const pushId = (v) => {
    if (typeof v !== 'string') return;
    const id = v.trim();
    if (!id || seen.has(id) || !isValidSessionId(id)) return;
    seen.add(id);
    result.push(id);
  };

  if (Array.isArray(content)) {
    for (const v of content) pushId(v);
    return result;
  }
  if (typeof content === 'string') {
    const s = content.trim();
    if (!s) return result;
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        for (const v of parsed) pushId(v);
      } else if (parsed && Array.isArray(parsed.sessionIds)) {
        for (const v of parsed.sessionIds) pushId(v);
      }
    } catch (e) { /* 非 JSON 忽略 */ }
  }
  return result;
}

// ==================== 导出 ====================

/**
 * 导出会话：读取全部原始消息行，包成前端 onExportSessionData 期望的结构。
 * 前端期望 { sessionId, title, messages }（messages 为原始 JSONL 行数组），见 sessionCallbacks.ts。
 * @returns {object} { sessionId, title, messages } 或 { error }
 */
function exportSession(cwd, sessionId, title) {
  try {
    if (!isValidSessionId(sessionId)) {
      return { error: 'Invalid session ID' };
    }
    const messages = readSessionRawMessages(cwd, sessionId);
    return { sessionId: sessionId, title: title || '', messages: messages };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  loadHistoryData,
  loadSessionMessages,
  deleteSession,
  deleteSessions,
  exportSession,
  toggleFavorite,
  updateTitle,
  deleteTitle,
  removeFavorite,
  // 导出辅助便于复用/测试
  sanitizePath,
  getProjectSessionDir,
  readSessionRawMessages,
  findLastUsageFromRawMessages,
  jsonlLineToClaudeMessage,
  parseSessionIds,
  isValidSessionId,
  loadFavorites,
  loadTitles,
};
