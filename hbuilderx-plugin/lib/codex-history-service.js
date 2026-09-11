'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Codex 历史会话服务（读取 Codex CLI 写在 ~/.codex/sessions 下的 rollout JSONL）。
 *
 * 移植自 JetBrains(Java) 版：
 *   - provider/codex/CodexHistoryReader + CodexHistoryParser + CodexSessionLiteReader + CodexHistoryIndexService
 *     （会话列表：按项目 cwd 过滤、标题取首条 user_message、session_meta.id 作为会话 ID）
 *   - handler/history/HistoryMessageInjector + handler/CodexMessageConverter（rollout 行 → 前端 ClaudeMessage）
 *   - handler/history/HistoryDeleteService.deleteCodexSession（按 "-<sessionId>.jsonl" 后缀删文件）
 *
 * 文件布局：<CODEX_HOME 或 ~/.codex>/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl
 *   - 首行 {type:"session_meta", payload:{id, cwd, timestamp, ...}}；payload.id 即 SDK 的 thread_id（续聊用）
 *   - event_msg/user_message：用户原话（含 local_images）；response_item/message：模型收发的消息
 *   - response_item/function_call(_output)、custom_tool_call(_output)、reasoning：工具调用与推理摘要
 * 另有 <codex home>/session_index.jsonl：{id, thread_name, updated_at}，Codex 自动生成的会话名（优先作为标题）。
 *
 * 与上游的差异（均为增强，不改变语义）：
 *   - 标题优先用 session_index.jsonl 的 thread_name（与 Codex 桌面端一致），无则回退首条用户消息。
 *   - 补齐 custom_tool_call_output → tool_result（上游漏转，apply_patch/exec 会一直显示为未完成）。
 *   - reasoning 的 summary 文本转为 thinking 块（与实时流一致）。
 *   - 列表扫描带 mtime+size 索引缓存：只读首行判断 cwd，项目不匹配的文件不做整文件解析。
 *
 * 设计：纯文件逻辑，无 hbuilderx 依赖；绝不写 Codex 自己的文件（删除会话除外，与上游一致由用户显式触发）。
 */

// ==================== 路径 ====================

/** Codex 数据根：CODEX_HOME（Codex CLI 同款环境变量）优先，否则 ~/.codex。 */
function getCodexHome() {
  const env = process.env.CODEX_HOME;
  if (env && path.isAbsolute(env)) return env;
  return path.join(os.homedir(), '.codex');
}

function getSessionsDir() {
  return path.join(getCodexHome(), 'sessions');
}

function getSessionIndexFile() {
  return path.join(getCodexHome(), 'session_index.jsonl');
}

/** 本插件自己的列表索引缓存（与 Claude 的 history-index.json 分开，删了会自动重建）。 */
function getListIndexFile() {
  return path.join(os.homedir(), '.codemoss', 'codex-history-index.json');
}

// ==================== 列表索引缓存 ====================

// 标题/解析规则变化时递增，旧缓存整体作废重建（2：兼容 0.149+ 不再写 user_message 的新格式）
const LIST_INDEX_VERSION = 2;
let _listIndexCache = null;

/** 结构 { version, entries: { <absFile>: { mtimeMs, size, meta:{id,cwd,createdAt}|null, parsed, info } } }。 */
function loadListIndex() {
  if (_listIndexCache) return _listIndexCache;
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(getListIndexFile(), 'utf-8'));
  } catch (e) { obj = null; }
  if (obj && obj.version === LIST_INDEX_VERSION && obj.entries && typeof obj.entries === 'object') {
    _listIndexCache = obj;
  } else {
    _listIndexCache = { version: LIST_INDEX_VERSION, entries: {} };
  }
  return _listIndexCache;
}

function saveListIndex(index) {
  try {
    const file = getListIndexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) { /* 仅为加速缓存，写失败退化为下次重新解析 */ }
}

/** 深度搜索：清空内存 + 磁盘索引，下次全量重建（对齐 Java clearAllCodexCache/clearAllCodexIndex）。 */
function clearListIndex() {
  _listIndexCache = { version: LIST_INDEX_VERSION, entries: {} };
  try { fs.unlinkSync(getListIndexFile()); } catch (e) { /* 不存在即可 */ }
}

// ==================== 文本清洗（对齐 UserMessageSanitizer / TagExtractor / TextSanitizer） ====================

const SYSTEM_TAG_NAMES = ['agents-instructions', 'system-reminder', 'system-prompt'];

// 发送给模型前追加到用户消息尾部的上下文段落；历史重放/标题只展示用户原话。
const APPENDED_CONTEXT_MARKERS = [
  '\n\n## Agent Role and Instructions\n\n',
  '\n\n## Workspace Context\n\n',
  '\n\n## Project Modules\n\nThis project contains multiple modules:\n',
  '\n\n## Active Terminal Session\n\nThe user is working in the following terminal context:\n\n',
  '\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n',
  '\n\n## IDE Context\n\n',
  '\n\n## User\'s Current IDE Context\n\nThe user is viewing this file in their IDE.',
  '\n\n## User\'s Current IDE Context\n\nThe user is working in an IDE.',
  '\n\n### Multi-Project Workspace Structure\n\n',
  '\n\n### Project Module Structure\n\nThis project contains multiple modules:\n',
];

function removeTagBlocks(text, tagName) {
  const open = '<' + tagName + '>';
  const close = '</' + tagName + '>';
  let result = text;
  let start = result.indexOf(open);
  while (start >= 0) {
    const end = result.indexOf(close, start);
    if (end < 0) break;
    result = result.slice(0, start) + result.slice(end + close.length);
    start = result.indexOf(open);
  }
  return result;
}

/** 去掉系统标签块与尾部追加的上下文段落，只留用户可见原话。 */
function sanitizeUserFacingText(text) {
  if (typeof text !== 'string' || !text) return '';
  let s = text.replace(/\r\n?/g, '\n');
  for (const tag of SYSTEM_TAG_NAMES) s = removeTagBlocks(s, tag);
  let cut = -1;
  for (const marker of APPENDED_CONTEXT_MARKERS) {
    const idx = s.indexOf(marker);
    if (idx <= 0 || !s.slice(0, idx).trim()) continue;
    if (cut === -1 || idx < cut) cut = idx;
  }
  if (cut >= 0) s = s.slice(0, cut);
  return s.trim();
}

function extractTagContent(text, tag) {
  const m = text.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

/** 斜杠命令消息（<command-message>init</command-message>…）取命令名 + 参数作为标题。 */
function extractCommandMessageContent(text) {
  const message = extractTagContent(text, 'command-message');
  const args = extractTagContent(text, 'command-args');
  if (!message && !args) return text;
  return [message, args].filter(Boolean).join(' ');
}

const TITLE_MAX_LENGTH = 45;

/** 是否斜杠命令消息（/clear、/model、/init 等；从 Claude 导入的会话常以它开头）。 */
function isSlashCommandMessage(text) {
  return typeof text === 'string' && (text.indexOf('<command-message>') !== -1 || text.indexOf('<command-name>') !== -1);
}

/** 从一条 user_message 文本生成标题；自动生成的标签消息返回 null（继续找下一条）。 */
function titleFromUserMessage(text) {
  let s = sanitizeUserFacingText(text);
  if (!s) return null;
  s = extractCommandMessageContent(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^<[a-z]/.test(s)) return null;
  if (s.length > TITLE_MAX_LENGTH) s = s.slice(0, TITLE_MAX_LENGTH).trim() + '…';
  return s;
}

/** Codex 注入的环境/指令类 user 消息，不在聊天区重放（对齐 CodexMessageConverter.isSystemMessage）。 */
function isSystemMessage(text) {
  return text.startsWith('Warning:')
    || text.startsWith('Tool result:')
    || text.startsWith('Exit code:')
    || text.startsWith('# AGENTS.md instructions')
    || text.startsWith('<agents-instructions>')
    || text.startsWith('<INSTRUCTIONS>')
    || text.startsWith('<environment_context>')
    || text.startsWith('<user_instructions>');
}

// ==================== 路径匹配 ====================

/** 统一分隔符、去尾部斜杠；Windows 下大小写不敏感。 */
function normalizePathForCompare(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** 会话 cwd 等于项目路径或位于其子目录（对齐 getSessionsForProjectAsJson）。 */
function cwdBelongsToProject(sessionCwd, projectPath) {
  const c = normalizePathForCompare(sessionCwd);
  const p = normalizePathForCompare(projectPath);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '/');
}

// ==================== 文件读取 ====================

/** 递归列出 sessions 下全部 .jsonl（目录不存在返回空）。 */
function listSessionFiles() {
  const root = getSessionsDir();
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** 只读到首个换行（session_meta 行含 base_instructions，可能几十 KB），上限 4MB。 */
function readFirstLine(file) {
  const CHUNK = 64 * 1024;
  const MAX = 4 * 1024 * 1024;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const parts = [];
    let total = 0;
    while (total < MAX) {
      const buf = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, buf, 0, CHUNK, total);
      if (n <= 0) break;
      const nl = buf.indexOf(0x0a);
      if (nl >= 0 && nl < n) {
        parts.push(buf.subarray(0, nl));
        break;
      }
      parts.push(buf.subarray(0, n));
      total += n;
    }
    return Buffer.concat(parts).toString('utf-8');
  } catch (e) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
}

function parseTimestampMs(ts) {
  if (typeof ts !== 'string' || !ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** 从首行解析 session_meta 的 {id, cwd, createdAt}；首行不是 session_meta 返回 null。 */
function readSessionMeta(file) {
  const line = readFirstLine(file).trim();
  if (!line) return null;
  try {
    const obj = JSON.parse(line);
    if (!obj || obj.type !== 'session_meta' || !obj.payload) return null;
    const p = obj.payload;
    return {
      id: typeof p.id === 'string' && p.id ? p.id : null,
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      createdAt: parseTimestampMs(p.timestamp),
    };
  } catch (e) {
    return null;
  }
}

/** 逐行解析 JSONL（跳过空行/坏行）。 */
function readJsonlObjects(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
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
    } catch (e) { /* 跳过坏行（可能是正在写入的末行） */ }
  }
  return out;
}

/** 文件名兜底会话 ID：rollout-<时间>-<uuid>.jsonl 取末尾 uuid。 */
const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
function sessionIdFromFileName(file) {
  const m = path.basename(file).match(UUID_TAIL);
  return m ? m[1] : path.basename(file, '.jsonl');
}

/** 内容块数组中的文本拼接（兼容 input_text / text / Text 等写法）。 */
function joinBlockTexts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

/**
 * 从一行 rollout 取「用户输入文本」（非用户消息返回 null）。三种来源按版本不同而存在：
 *   - event_msg/user_message（≤0.148 的主要来源）
 *   - event_msg/item_completed 且 item.type=UserMessage（0.149+ 不再写 user_message，改写这个）
 *   - response_item/message role=user（各版本都有，但混有 <environment_context> / AGENTS.md 注入）
 */
function userTextOfLine(obj) {
  const p = obj && obj.payload;
  if (!p) return null;
  if (obj.type === 'event_msg') {
    if (p.type === 'user_message') return typeof p.message === 'string' ? p.message : null;
    if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage') return joinBlockTexts(p.item.content);
    return null;
  }
  if (obj.type === 'response_item' && p.type === 'message' && p.role === 'user') {
    const text = joinBlockTexts(p.content);
    return isSystemMessage(sanitizeUserFacingText(text)) ? null : text;
  }
  return null;
}

/**
 * 整文件解析列表元数据（对齐 CodexHistoryParser.parseSessionFile）。
 * messageCount 按 response_item 行计数（与上游一致）；无标题或无消息视为无效会话返回 null。
 * 标题取首条非斜杠命令的用户消息（"clear"/"model" 这类标题没有辨识度），全是命令时才用命令名。
 */
function parseSessionInfo(file, stat) {
  const objs = readJsonlObjects(file);
  let sessionId = sessionIdFromFileName(file);
  let cwd = '';
  let createdAt = 0;
  let title = null;
  let commandTitle = null;
  let messageCount = 0;
  for (const obj of objs) {
    const p = obj.payload;
    if (obj.type === 'session_meta' && p) {
      if (typeof p.id === 'string' && p.id) sessionId = p.id;
      if (typeof p.cwd === 'string') cwd = p.cwd;
      createdAt = parseTimestampMs(p.timestamp) || createdAt;
      continue;
    }
    if (obj.type === 'response_item') messageCount++;
    if (title != null) continue;
    const text = userTextOfLine(obj);
    const t = text ? titleFromUserMessage(text) : null;
    if (!t) continue;
    if (!isSlashCommandMessage(text)) title = t;
    else if (commandTitle == null) commandTitle = t;
  }
  if (title == null) title = commandTitle;
  if (!title || messageCount < 1) return null;
  return {
    sessionId,
    title,
    messageCount,
    lastTimestamp: stat.mtimeMs,
    firstTimestamp: createdAt || stat.mtimeMs,
    cwd,
    fileSize: stat.size,
  };
}

/** 读 session_index.jsonl → { id: thread_name }（同 id 多行取最后一行）。 */
function loadThreadNames() {
  const names = {};
  for (const obj of readJsonlObjects(getSessionIndexFile())) {
    if (typeof obj.id === 'string' && typeof obj.thread_name === 'string' && obj.thread_name.trim()) {
      names[obj.id] = obj.thread_name.trim();
    }
  }
  return names;
}

// ==================== 会话列表 ====================

/**
 * 扫描属于某项目的 Codex 会话（按最后修改时间倒序，同 ID 去重保留最新）。
 * @param {string} projectPath 当前工作区根
 * @returns {object[]} SessionInfo 列表：{ sessionId, title, messageCount, lastTimestamp, firstTimestamp, cwd, fileSize }
 */
function scanProjectSessions(projectPath) {
  if (!projectPath) return [];
  const files = listSessionFiles();
  const index = loadListIndex();
  let dirty = false;
  const seen = new Set();
  const byId = new Map();

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      continue;
    }
    if (stat.size <= 0) continue;
    seen.add(file);

    let entry = index.entries[file];
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      entry = { mtimeMs: stat.mtimeMs, size: stat.size, meta: readSessionMeta(file), parsed: false, info: null };
      index.entries[file] = entry;
      dirty = true;
    }
    // 首行不是 session_meta 的文件无法判断归属：跳过（上游也要求 cwd 非空才匹配）
    if (!entry.meta || !cwdBelongsToProject(entry.meta.cwd, projectPath)) continue;

    if (!entry.parsed) {
      entry.info = parseSessionInfo(file, stat);
      entry.parsed = true;
      dirty = true;
    }
    const info = entry.info;
    if (!info) continue;
    const prev = byId.get(info.sessionId);
    if (!prev || info.lastTimestamp >= prev.lastTimestamp) byId.set(info.sessionId, { ...info });
  }

  // 清理已删除文件的陈旧条目，防止索引无限膨胀
  for (const k of Object.keys(index.entries)) {
    if (!seen.has(k)) {
      delete index.entries[k];
      dirty = true;
    }
  }
  if (dirty) saveListIndex(index);

  const threadNames = loadThreadNames();
  const sessions = Array.from(byId.values());
  for (const s of sessions) {
    const name = threadNames[s.sessionId];
    if (name) s.title = name;
  }
  sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return sessions;
}

// ==================== 会话定位 ====================

/** sessionId 安全校验（防路径穿越），与 history-service 同规则。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && SESSION_ID_PATTERN.test(sessionId);
}

/** 文件名是否对应该会话：rollout-…-<id>.jsonl 或 <id>.jsonl（锚定后缀，避免误删共享子串的相邻会话）。 */
function isSessionFileMatch(file, sessionId) {
  const name = path.basename(file);
  return name === sessionId + '.jsonl' || name.endsWith('-' + sessionId + '.jsonl');
}

/**
 * 找到某会话的全部 rollout 文件。先按文件名匹配；文件名不含该 ID 时（旧版本命名）再用索引里的 session_meta.id 匹配。
 * @returns {string[]}
 */
function findSessionFiles(sessionId) {
  if (!isValidSessionId(sessionId)) return [];
  const files = listSessionFiles();
  const byName = files.filter((f) => isSessionFileMatch(f, sessionId));
  if (byName.length) return byName;
  const index = loadListIndex();
  return files.filter((f) => {
    const entry = index.entries[f];
    const meta = entry && entry.meta ? entry.meta : readSessionMeta(f);
    return !!(meta && meta.id === sessionId);
  });
}

/** 多个匹配时取最新修改的那个（同一 thread 理论上只有一个文件）。 */
function findSessionFile(sessionId) {
  const files = findSessionFiles(sessionId);
  if (files.length <= 1) return files[0] || null;
  let best = null;
  let bestMtime = -1;
  for (const f of files) {
    let m = 0;
    try { m = fs.statSync(f).mtimeMs; } catch (e) { m = 0; }
    if (m > bestMtime) {
      best = f;
      bestMtime = m;
    }
  }
  return best;
}

// ==================== rollout 行 → 前端 ClaudeMessage ====================

// 与 history-service 同款：工具输入/输出里的超大字符串入前端前截断，防止大会话重放 OOM。
const MAX_BLOCK_STRING = 20000;
function capString(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_BLOCK_STRING ? s.slice(0, MAX_BLOCK_STRING) + `\n…[内容过长已截断，原 ${s.length} 字符]` : s;
}
function capDeep(value) {
  if (typeof value === 'string') return capString(value);
  if (Array.isArray(value)) return value.map(capDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = capDeep(value[k]);
    return out;
  }
  return value;
}

function makeMessage(type, content, blocks, timestamp) {
  const msg = { type, content, raw: { type, role: type, content: blocks } };
  if (timestamp) msg.timestamp = timestamp;
  return msg;
}

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 本地图片路径 → data URL 图片块；文件已被清理/过大/非图片则跳过。 */
function localImageBlock(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) return null;
  try {
    const stat = fs.statSync(imagePath);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(imagePath).toLowerCase()] || 'image/png';
    const data = fs.readFileSync(imagePath).toString('base64');
    return { type: 'image', src: `data:${mediaType};base64,${data}`, mediaType, alt: path.basename(imagePath) };
  } catch (e) {
    return null;
  }
}

/** data URL / http 图片 → 图片块。 */
function urlImageBlock(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/^data:([^;,]+)[;,]/);
  return { type: 'image', src: url, mediaType: m ? m[1] : 'image/png', alt: 'image' };
}

/** event_msg/user_message → user（对齐 HistoryMessageInjector.convertEventMsgToFrontend）。 */
function convertUserMessageEvent(p, timestamp) {
  const images = [];
  if (Array.isArray(p.local_images)) {
    for (const img of p.local_images) {
      const b = localImageBlock(typeof img === 'string' ? img : img && img.path);
      if (b) images.push(b);
    }
  }
  if (Array.isArray(p.images)) {
    for (const img of p.images) {
      const b = urlImageBlock(typeof img === 'string' ? img : img && (img.image_url || img.url));
      if (b) images.push(b);
    }
  }
  const text = sanitizeUserFacingText(p.message);
  if (!text && !images.length) return null;
  const blocks = images.slice();
  if (text) blocks.push({ type: 'text', text });
  return makeMessage('user', text, blocks, timestamp);
}

/** Codex content（input_text/output_text/input_image…）→ Claude 内容块。 */
function convertContentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text });
    } else if (item.type === 'input_image') {
      const b = urlImageBlock(item.image_url);
      if (b) blocks.push(b);
    } else if (item.type === 'image' && item.src) {
      blocks.push(item);
    }
  }
  return blocks;
}

function joinText(blocks) {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

/** response_item/message → user/assistant（对齐 CodexMessageConverter.convertCodexMessageToFrontend）。 */
function convertResponseMessage(p, timestamp) {
  const role = p.role;
  if (role !== 'user' && role !== 'assistant') return null; // developer/system 不重放
  let blocks = convertContentBlocks(p.content);
  let text = joinText(blocks);
  if (role === 'user') {
    const cleaned = sanitizeUserFacingText(text);
    if (!cleaned && !blocks.some((b) => b.type === 'image')) return null;
    if (cleaned !== text.trim()) {
      blocks = blocks.filter((b) => b.type === 'image');
      if (cleaned) blocks.push({ type: 'text', text: cleaned });
    }
    text = cleaned;
  }
  if (text && isSystemMessage(text)) return null;
  if (!blocks.length) return null;
  return makeMessage(role, text, blocks, timestamp);
}

/** reasoning 摘要 → thinking 块（加密推理内容无法展示，仅用 summary）。 */
function convertReasoning(p, timestamp) {
  const parts = [];
  if (Array.isArray(p.summary)) {
    for (const s of p.summary) {
      if (s && typeof s.text === 'string' && s.text.trim()) parts.push(s.text.trim());
    }
  }
  if (!parts.length) return null;
  const thinking = parts.join('\n\n');
  return makeMessage('assistant', '', [{ type: 'thinking', thinking, text: thinking }], timestamp);
}

function parseArguments(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string' || !args) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

/**
 * 工具名归一（对齐 CodexMessageConverter.convertToolName）：
 * shell_command 按命令改成 read/glob；update_plan → todowrite；write_stdin 过滤（返回 null）。
 */
function convertToolName(name, input) {
  if (name === 'shell_command' && typeof input.command === 'string') {
    const cmd = input.command.trim();
    if (/^(ls|find|tree)\b/.test(cmd)) return 'glob';
    if (/^(pwd|cat|head|tail|file|stat)\b/.test(cmd)) return 'read';
    if (/^(grep|rg|ack|ag)\b/.test(cmd)) return 'glob';
  }
  if (name === 'update_plan' && Array.isArray(input.plan)) return 'todowrite';
  if (name === 'write_stdin') return null;
  return name;
}

/** 工具入参归一：exec_command/shell_command 的 cmd 映射为 command（Bash 块只读 command）；plan → todos。 */
function convertToolInput(name, input) {
  if ((name === 'exec_command' || name === 'shell_command') && typeof input.cmd === 'string' && input.command === undefined) {
    return { ...input, command: input.cmd };
  }
  if (name === 'todowrite' && Array.isArray(input.plan)) {
    return {
      todos: input.plan.filter((it) => it && typeof it === 'object').map((it, i) => ({
        content: typeof it.step === 'string' ? it.step : '',
        activeForm: typeof it.step === 'string' ? it.step : '',
        status: typeof it.status === 'string' ? it.status : 'pending',
        id: String(i),
      })),
    };
  }
  return input;
}

function toolUseMessage(id, name, input, timestamp) {
  return makeMessage('assistant', 'Tool: ' + name,
    [{ type: 'tool_use', id: id || 'unknown', name, input: capDeep(input) }], timestamp);
}

/** function_call → tool_use（对齐 convertFunctionCallToToolUse）。 */
function convertFunctionCall(p, timestamp) {
  const rawName = typeof p.name === 'string' && p.name ? p.name : 'unknown';
  const args = parseArguments(p.arguments);
  const name = convertToolName(rawName, args);
  if (!name) return null;
  return toolUseMessage(p.call_id, name, convertToolInput(name, args), timestamp);
}

/** custom_tool_call → tool_use（apply_patch 附带首个改动文件路径，便于前端展示目标文件）。 */
function convertCustomToolCall(p, timestamp) {
  const name = typeof p.name === 'string' && p.name ? p.name : 'unknown';
  const raw = typeof p.input === 'string' ? p.input : (p.input == null ? '' : JSON.stringify(p.input));
  let input;
  if (name === 'apply_patch') {
    input = { patch: raw };
    const m = raw.match(/^\*\*\* (?:Add|Update) File:\s*(.+)$/m);
    if (m) input.file_path = m[1].trim();
  } else {
    input = { input: raw };
  }
  return toolUseMessage(p.call_id, name, input, timestamp);
}

/** 工具输出统一成字符串：字符串原样；内容块数组拼接文本；{content} 取其 content；其它 JSON 化。 */
function outputToString(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
  }
  if (output && typeof output === 'object') {
    if (typeof output.content === 'string') return output.content;
    if (Array.isArray(output.content)) return outputToString(output.content);
  }
  return output == null ? '' : JSON.stringify(output);
}

// 与实时流 handleFunctionCallOutputPayload / handleCommandExecution 同口径的错误判定
const ERROR_OUTPUT_PATTERN = /^error:|failed to parse|permission denied|command denied/i;
const NONZERO_EXIT_PATTERN = /^Process exited with code [1-9]\d*/m;

/** function_call_output / custom_tool_call_output → user 消息里的 tool_result。 */
function convertToolOutput(p, timestamp) {
  const text = outputToString(p.output);
  const isError = p.status === 'error' || ERROR_OUTPUT_PATTERN.test(text) || NONZERO_EXIT_PATTERN.test(text);
  const block = {
    type: 'tool_result',
    tool_use_id: p.call_id || 'unknown',
    content: capString(text && text.trim() ? text : '(no output)'),
    is_error: isError,
  };
  return makeMessage('user', '[tool_result]', [block], timestamp);
}

/** 单行 rollout → 前端消息（或 null 表示不重放）。 */
function convertRolloutLine(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const p = obj.payload;
  if (!p || typeof p !== 'object') return null;
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

  if (obj.type === 'event_msg') {
    return p.type === 'user_message' ? convertUserMessageEvent(p, ts) : null;
  }
  if (obj.type !== 'response_item') return null;
  switch (p.type) {
    case 'message': return convertResponseMessage(p, ts);
    case 'reasoning': return convertReasoning(p, ts);
    case 'function_call': return convertFunctionCall(p, ts);
    case 'custom_tool_call': return convertCustomToolCall(p, ts);
    case 'function_call_output':
    case 'custom_tool_call_output':
      return convertToolOutput(p, ts);
    default: return null;
  }
}

function normalizeDuplicateUserContent(content) {
  return String(content || '')
    .replace(/^<image[^\r\n]*>\r?\n?/gm, '')
    .replace(/^<\/image>\r?\n?/gm, '')
    .trim();
}

/**
 * 同一条用户输入在 rollout 里会出现两次（event_msg/user_message + response_item/message:user，时间戳相同），
 * 相邻且时间戳+正文一致时合并，保留内容块更多的那条（对齐 HistoryMessageInjector.addCodexFrontendMessage）。
 */
function isDuplicateAdjacentUser(prev, next) {
  if (prev.type !== 'user' || next.type !== 'user') return false;
  if (prev.content === '[tool_result]' || next.content === '[tool_result]') return false;
  if (!prev.timestamp || prev.timestamp !== next.timestamp) return false;
  return normalizeDuplicateUserContent(prev.content) === normalizeDuplicateUserContent(next.content);
}

/** rollout 对象数组 → 前端消息列表。 */
function convertRolloutToMessages(objs) {
  const out = [];
  for (const obj of objs) {
    const msg = convertRolloutLine(obj);
    if (!msg) continue;
    const last = out[out.length - 1];
    if (last && isDuplicateAdjacentUser(last, msg)) {
      if (msg.raw.content.length > last.raw.content.length) out[out.length - 1] = msg;
      continue;
    }
    out.push(msg);
  }
  return out;
}

/**
 * 读取并转换某 Codex 会话的全部可重放消息。
 * @returns {{ found: boolean, threadId: string, cwd: string, messages: object[] }}
 *   threadId 取 session_meta.id（续聊必须用它，而非文件名）
 */
function loadSessionMessages(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { found: false, threadId: sessionId, cwd: '', messages: [] };
  const objs = readJsonlObjects(file);
  let threadId = sessionId;
  let cwd = '';
  const meta = objs.find((o) => o.type === 'session_meta' && o.payload);
  if (meta) {
    if (typeof meta.payload.id === 'string' && meta.payload.id) threadId = meta.payload.id;
    if (typeof meta.payload.cwd === 'string') cwd = meta.payload.cwd;
  }
  return { found: true, threadId, cwd, messages: convertRolloutToMessages(objs) };
}

// ==================== 删除 / 导出 ====================

/**
 * 删除某会话的 rollout 文件（对齐 HistoryDeleteService.deleteCodexSession）。
 * 仅删 sessions 目录下的匹配文件；不改 session_index.jsonl 等 Codex 自有文件。
 * @returns {{ success: boolean, deleted: number, error?: string }}
 */
function deleteSession(sessionId) {
  if (!isValidSessionId(sessionId)) return { success: false, deleted: 0, error: 'Invalid session ID' };
  const root = path.resolve(getSessionsDir()) + path.sep;
  let deleted = 0;
  let lastError = null;
  for (const file of findSessionFiles(sessionId)) {
    // 越界保护：只删 sessions 目录之下的文件
    if (!path.resolve(file).startsWith(root)) continue;
    try {
      fs.unlinkSync(file);
      deleted++;
      if (_listIndexCache) delete _listIndexCache.entries[file];
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }
  const result = { success: deleted > 0, deleted };
  if (!deleted && lastError) result.error = lastError;
  return result;
}

/** 导出：原始 rollout 行数组（前端 onExportSessionData 只做 JSON 下载，格式无关）。 */
function exportSession(sessionId, title) {
  if (!isValidSessionId(sessionId)) return { error: 'Invalid session ID' };
  const file = findSessionFile(sessionId);
  if (!file) return { error: 'Codex session not found' };
  return { sessionId, title: title || '', messages: readJsonlObjects(file) };
}

module.exports = {
  scanProjectSessions,
  loadSessionMessages,
  deleteSession,
  exportSession,
  clearListIndex,
  // 导出辅助便于测试
  getSessionsDir,
  findSessionFile,
  convertRolloutLine,
  convertRolloutToMessages,
  sanitizeUserFacingText,
  titleFromUserMessage,
  cwdBelongsToProject,
  isValidSessionId,
};
