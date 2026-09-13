'use strict';

/**
 * Codex 发送链路的宿主侧工具（移植自 IDEA 版 CodexSDKBridge.sendMessage / SessionSendService.sendToCodex）。
 *
 * 背景：此前 message-router._handleSend 无论当前 provider 是什么都走 claude.send，
 * 只配置了 Codex 的用户会命中 Claude 的「API Key not configured」→ 前端显示「供应商未配置」，
 * 选中的 GPT 模型也被原样发给了 Claude 端点。本模块提供改走 codex.send 所需的全部宿主侧逻辑：
 *
 *   - buildCodexCredentials：受管供应商（configToml/authJson）→ codex.send 的 configOverrides/apiKey/env。
 *     IDEA 版切换供应商时直接覆写 ~/.codex/{config.toml,auth.json}；本移植刻意不碰用户 ~/.codex
 *    （见 message-router 的 Codex 供应商管理说明），改为每次发送时经 SDK 的 --config 覆盖 + CODEX_API_KEY 生效。
 *   - parseToml：config.toml 的精简解析器（覆盖供应商配置常见语法）。
 *   - saveImageAttachments：Codex SDK 只接受本地图片路径，base64 图片落临时文件，发送后清理。
 *   - processCodexOutputLine：Codex 输出标记（[THREAD_ID] / status / usage）到装配器事件的适配。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { processOutputLine } = require('./stream-adapter');

/** 未授权任何 Codex 访问方式时的提示（对齐 IDEA error.codexLocalAccessNotAuthorized）。 */
const CODEX_ACCESS_NOT_AUTHORIZED_MESSAGE =
  'Codex 本地配置读取未获授权。请先在「设置 → 供应商 → Codex」中启用「Codex CLI 登录」，或启用一个 Codex 供应商。';

/** 自定义环境变量不得覆盖的内置变量（对齐 CodexSDKBridge.PROTECTED_ENV_KEYS / 前端 CODEX_PROTECTED_ENV_KEYS）。 */
const PROTECTED_ENV_KEYS = new Set([
  'CODEX_USE_STDIN', 'CODEX_MODEL', 'CODEX_SANDBOX_MODE', 'CODEX_SANDBOX', 'CODEX_APPROVAL_POLICY',
  'CODEX_CI', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_HOME', 'CLAUDE_SESSION_ID', 'CLAUDE_PERMISSION_DIR',
  'HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'IDEA_PROJECT_PATH', 'PROJECT_PATH', 'CLAUDE_USE_STDIN',
]);
const MAX_ENV_VAR_VALUE_LENGTH = 16 * 1024;

/** 可安全作为 --config 点分路径一段的键（codex CLI 按 '.' 切分路径，含点/空格的键无法表达）。 */
const SAFE_CONFIG_KEY = /^[A-Za-z0-9_-]+$/;

// ===================== TOML 精简解析 =====================

class TomlParseError extends Error {}

/**
 * 解析 TOML 文本为普通对象。支持：注释、[表] / [[表数组]]、点分与带引号的键、
 * 基本/字面量字符串（含多行）、整数/浮点（含下划线、0x/0o/0b、inf/nan）、布尔、数组（可跨行、嵌套）、内联表。
 * 日期时间按原文字符串保留。语法错误抛 TomlParseError（含行号）。
 * @param {string} text
 * @returns {object}
 */
function parseToml(text) {
  const src = String(text || '').replace(/^﻿/, '');
  let i = 0;
  let line = 1;
  const root = {};
  let current = root;

  const fail = (msg) => { throw new TomlParseError(`config.toml 第 ${line} 行: ${msg}`); };
  const peek = () => src[i];
  const next = () => { const c = src[i++]; if (c === '\n') line++; return c; };
  const skipWs = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };
  const skipComment = () => { if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; } };
  // 跳过空白、换行与注释（数组/内联表内部及语句之间使用）
  const skipAll = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (src[i] === '\r' || src[i] === '\n') { next(); continue; }
      break;
    }
  };
  const expectLineEnd = () => {
    skipWs();
    skipComment();
    if (src[i] === '\r') i++;
    if (i < src.length && src[i] !== '\n') fail(`多余的内容「${src.slice(i, i + 20)}」`);
    if (src[i] === '\n') next();
  };

  const parseBasicString = () => {
    // 调用时 src[i] === '"'
    if (src.startsWith('"""', i)) {
      i += 3;
      if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; line++; } else if (src[i] === '\n') next();
      let out = '';
      for (;;) {
        if (i >= src.length) fail('多行字符串未闭合');
        if (src.startsWith('"""', i)) {
          // 结束分隔符前允许紧跟最多两个属于内容的引号（TOML 规范：""""" 结尾 = 内容以 "" 结束）
          let run = 3;
          while (run < 5 && src[i + run] === '"') run++;
          out += '"'.repeat(run - 3);
          i += run;
          return out;
        }
        if (src[i] === '\\') {
          // 行尾反斜杠：吞掉后续空白与换行
          let j = i + 1;
          while (src[j] === ' ' || src[j] === '\t') j++;
          if (src[j] === '\n' || (src[j] === '\r' && src[j + 1] === '\n')) {
            i = j;
            while (i < src.length && /[\s]/.test(src[i])) next();
            continue;
          }
          out += parseEscape();
          continue;
        }
        out += next();
      }
    }
    i++;
    let out = '';
    for (;;) {
      if (i >= src.length || src[i] === '\n') fail('字符串未闭合');
      const c = src[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') { out += parseEscape(); continue; }
      out += c;
      i++;
    }
  };

  const parseEscape = () => {
    i++; // 跳过反斜杠
    const c = src[i++];
    switch (c) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case 'e': return '\x1b';
      case '"': return '"';
      case '\\': return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = src.slice(i, i + len);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail('非法的 \\u 转义');
        i += len;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        return fail(`非法转义 \\${c}`);
    }
  };

  const parseLiteralString = () => {
    if (src.startsWith("'''", i)) {
      i += 3;
      if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; line++; } else if (src[i] === '\n') next();
      const end = src.indexOf("'''", i);
      if (end < 0) fail('多行字面量字符串未闭合');
      let run = 3;
      while (run < 5 && src[end + run] === "'") run++;
      const out = src.slice(i, end) + "'".repeat(run - 3);
      for (const ch of out) if (ch === '\n') line++;
      i = end + run;
      return out;
    }
    i++;
    const start = i;
    while (i < src.length && src[i] !== "'" && src[i] !== '\n') i++;
    if (src[i] !== "'") fail('字面量字符串未闭合');
    const out = src.slice(start, i);
    i++;
    return out;
  };

  const parseKeyPart = () => {
    skipWs();
    const c = peek();
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    const start = i;
    while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) i++;
    if (i === start) fail('缺少键名');
    return src.slice(start, i);
  };

  const parseKeyPath = () => {
    const parts = [parseKeyPart()];
    for (;;) {
      skipWs();
      if (peek() !== '.') break;
      i++;
      parts.push(parseKeyPart());
    }
    return parts;
  };

  const parseArray = () => {
    i++; // [
    const arr = [];
    for (;;) {
      skipAll();
      if (peek() === ']') { i++; return arr; }
      arr.push(parseValue());
      skipAll();
      if (peek() === ',') { i++; continue; }
      skipAll();
      if (peek() === ']') { i++; return arr; }
      fail('数组缺少 , 或 ]');
    }
  };

  const parseInlineTable = () => {
    i++; // {
    const obj = {};
    skipWs();
    if (peek() === '}') { i++; return obj; }
    for (;;) {
      skipAll();
      const keys = parseKeyPath();
      skipWs();
      if (peek() !== '=') fail('内联表缺少 =');
      i++;
      skipWs();
      assignPath(obj, keys, parseValue());
      skipAll();
      if (peek() === ',') { i++; continue; }
      if (peek() === '}') { i++; return obj; }
      fail('内联表缺少 , 或 }');
    }
  };

  const parseScalar = () => {
    const start = i;
    // 读到值结束：逗号、右括号、注释、换行
    while (i < src.length && !/[,\]}\n#\r]/.test(src[i])) i++;
    const raw = src.slice(start, i).trim();
    // 回退尾部空白，交给调用方的 skipWs 处理
    i = start + src.slice(start, i).replace(/\s+$/, '').length;
    if (!raw) fail('缺少值');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : (raw.startsWith('-') ? -Infinity : Infinity);
    const compact = raw.replace(/_/g, '');
    if (/^0x[0-9A-Fa-f]+$/.test(compact)) return parseInt(compact.slice(2), 16);
    if (/^0o[0-7]+$/.test(compact)) return parseInt(compact.slice(2), 8);
    if (/^0b[01]+$/.test(compact)) return parseInt(compact.slice(2), 2);
    if (/^[+-]?\d+$/.test(compact)) return Number(compact);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(compact)) return Number(compact);
    // 日期/时间：原文保留为字符串
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
    return fail(`无法识别的值「${raw}」`);
  };

  const parseValue = () => {
    skipWs();
    const c = peek();
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') return parseArray();
    if (c === '{') return parseInlineTable();
    return parseScalar();
  };

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function assignPath(target, keys, value) {
    let obj = target;
    for (let k = 0; k < keys.length - 1; k++) {
      const key = keys[k];
      if (obj[key] === undefined) obj[key] = {};
      if (!isPlainObject(obj[key])) fail(`键「${keys.slice(0, k + 1).join('.')}」已定义为非表类型`);
      obj = obj[key];
    }
    const last = keys[keys.length - 1];
    if (Object.prototype.hasOwnProperty.call(obj, last)) fail(`重复定义键「${keys.join('.')}」`);
    obj[last] = value;
  }

  function resolveTable(keys, isArrayTable) {
    let obj = root;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const isLast = k === keys.length - 1;
      if (isLast && isArrayTable) {
        if (obj[key] === undefined) obj[key] = [];
        if (!Array.isArray(obj[key])) fail(`「${keys.join('.')}」不是表数组`);
        const entry = {};
        obj[key].push(entry);
        return entry;
      }
      if (obj[key] === undefined) obj[key] = {};
      let child = obj[key];
      if (Array.isArray(child)) child = child[child.length - 1]; // [[a]] 之后的 [a.b] 指向最后一项
      if (!isPlainObject(child)) fail(`「${keys.slice(0, k + 1).join('.')}」不是表`);
      obj = child;
    }
    return obj;
  }

  while (i < src.length) {
    skipAll();
    if (i >= src.length) break;
    if (peek() === '[') {
      const isArrayTable = src[i + 1] === '[';
      i += isArrayTable ? 2 : 1;
      const keys = parseKeyPath();
      skipWs();
      if (isArrayTable) {
        if (!src.startsWith(']]', i)) fail('表数组头缺少 ]]');
        i += 2;
      } else {
        if (peek() !== ']') fail('表头缺少 ]');
        i++;
      }
      current = resolveTable(keys, isArrayTable);
      expectLineEnd();
      continue;
    }
    const keys = parseKeyPath();
    skipWs();
    if (peek() !== '=') fail(`键「${keys.join('.')}」缺少 =`);
    i++;
    const value = parseValue();
    assignPath(current, keys, value);
    expectLineEnd();
  }
  return root;
}

// ===================== 受管供应商凭据 =====================

/**
 * 过滤掉无法经 --config 表达的键/值（含点或空格的键、NaN/Infinity），返回可交给 SDK 的覆盖对象。
 * @returns {{ value: any, dropped: string[] }}
 */
function sanitizeConfigOverrides(value, prefix = '', dropped = []) {
  if (Array.isArray(value)) {
    const arr = [];
    value.forEach((item, idx) => {
      const r = sanitizeConfigOverrides(item, `${prefix}[${idx}]`, dropped);
      if (r.value !== undefined) arr.push(r.value);
    });
    return { value: arr, dropped };
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (!SAFE_CONFIG_KEY.test(key)) { dropped.push(p); continue; }
      const r = sanitizeConfigOverrides(child, p, dropped);
      if (r.value !== undefined) out[key] = r.value;
    }
    return { value: out, dropped };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    dropped.push(prefix);
    return { value: undefined, dropped };
  }
  return { value, dropped };
}

/**
 * 受管供应商 → codex.send 所需凭据。
 * - configToml 解析为 configOverrides（SDK 转为 --config，叠加在用户 ~/.codex/config.toml 之上，不落盘）。
 * - authJson.OPENAI_API_KEY → apiKey（SDK 以 CODEX_API_KEY 环境变量传给 codex exec）。
 *   若所选 model_provider 声明了 env_key，同时把 key 注入该环境变量（env_key 型供应商从环境变量取 key）。
 * - messageEnvVars → env（跳过受保护变量与超长值，对齐 CodexSDKBridge.injectCustomEnvVars）。
 * @param {object} provider ~/.codemoss/config.json codex.providers[current]
 * @returns {{ configOverrides: object|null, apiKey: string, env: object, warnings: string[] }}
 */
function buildCodexCredentials(provider) {
  const warnings = [];
  const env = {};
  let configOverrides = null;
  let apiKey = '';

  const configToml = provider && typeof provider.configToml === 'string' ? provider.configToml : '';
  if (configToml.trim()) {
    // 解析失败直接抛出：静默忽略会让请求打到默认 OpenAI 端点，比明确报错更难排查
    const parsed = parseToml(configToml);
    const { value, dropped } = sanitizeConfigOverrides(parsed);
    if (dropped.length) warnings.push(`config.toml 中以下键无法经 --config 传递，已忽略: ${dropped.join(', ')}`);
    configOverrides = value && Object.keys(value).length ? value : null;
  }

  const authJson = provider && typeof provider.authJson === 'string' ? provider.authJson : '';
  let auth = null;
  if (authJson.trim()) {
    try {
      auth = JSON.parse(authJson.replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(`Codex 供应商的 auth.json 不是合法 JSON: ${e.message}`);
    }
    if (auth && typeof auth.OPENAI_API_KEY === 'string') apiKey = auth.OPENAI_API_KEY.trim();
  }

  // env_key 型供应商：key 从该环境变量读取
  const providerId = configOverrides && typeof configOverrides.model_provider === 'string' ? configOverrides.model_provider : '';
  const providerDef = providerId && configOverrides.model_providers && configOverrides.model_providers[providerId];
  const envKey = providerDef && typeof providerDef.env_key === 'string' ? providerDef.env_key.trim() : '';
  if (envKey && !PROTECTED_ENV_KEYS.has(envKey.toUpperCase())) {
    const fromAuth = auth && typeof auth[envKey] === 'string' ? auth[envKey] : apiKey;
    if (fromAuth) env[envKey] = fromAuth;
  }

  const envVars = provider && Array.isArray(provider.messageEnvVars) ? provider.messageEnvVars : [];
  for (const entry of envVars) {
    if (!entry || typeof entry.key !== 'string' || entry.value == null) continue;
    const key = entry.key.trim();
    const value = String(entry.value);
    if (!key) continue;
    if (PROTECTED_ENV_KEYS.has(key.toUpperCase())) { warnings.push(`跳过受保护环境变量 ${key}`); continue; }
    if (value.length > MAX_ENV_VAR_VALUE_LENGTH) { warnings.push(`环境变量 ${key} 超过 16KB，已跳过`); continue; }
    env[key] = value;
  }

  return { configOverrides, apiKey, env, warnings };
}

// ===================== 图片附件 =====================

const IMAGE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/png': '.png',
};

/**
 * 把前端 base64 图片附件写到临时目录，返回 codex.send 的 local_image 条目与待清理文件列表。
 * 非图片附件忽略（Codex 仅支持图片输入，对齐 CodexSDKBridge.buildCodexAttachments）。
 * @param {Array<{ mediaType?: string, data?: string }>} attachments
 * @param {string} [tmpDir]
 * @returns {{ entries: Array<{type:'local_image', path:string}>, files: string[], skipped: number }}
 */
function saveImageAttachments(attachments, tmpDir) {
  const entries = [];
  const files = [];
  let skipped = 0;
  if (!Array.isArray(attachments) || attachments.length === 0) return { entries, files, skipped };
  const dir = tmpDir || path.join(os.tmpdir(), 'codex-images');
  for (const att of attachments) {
    const type = att && typeof att.mediaType === 'string' ? att.mediaType.toLowerCase() : '';
    if (!type.startsWith('image/') || typeof att.data !== 'string' || !att.data) { skipped++; continue; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 兼容 data URL 形式
      const base64 = att.data.replace(/^data:[^;]+;base64,/, '');
      const file = path.join(dir, `codex-img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${IMAGE_EXTENSIONS[type] || '.png'}`);
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      files.push(file);
      entries.push({ type: 'local_image', path: file });
    } catch (e) {
      skipped++;
    }
  }
  return { entries, files, skipped };
}

/** 删除临时图片文件（失败忽略）。 */
function cleanupFiles(files) {
  for (const f of files || []) {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

// ===================== 输出适配 =====================

/**
 * 处理一行 Codex 输出，事件语义对齐 IDEA CodexSDKBridge.processOutputLine：
 *   [THREAD_ID] → session_id；[MESSAGE] status → status；[MESSAGE] result(usage) → codex_usage；
 *   其余（[CONTENT_DELTA] / [THINKING_DELTA] / [MESSAGE] assistant|user / [SEND_ERROR] / STREAM_*）
 *   与 Claude 同形，交给 stream-adapter。
 * @param {string} line
 * @param {(type: string, payload: string) => void} onEvent
 * @param {object} state 同 processOutputLine 的可变状态容器
 */
function processCodexOutputLine(line, onEvent, state) {
  if (line.startsWith('[THREAD_ID]')) {
    const threadId = line.slice('[THREAD_ID]'.length).trim();
    if (threadId) onEvent('session_id', threadId);
    return;
  }
  if (line.startsWith('[MESSAGE]')) {
    const jsonStr = line.slice('[MESSAGE]'.length).trim();
    let msg = null;
    try { msg = JSON.parse(jsonStr); } catch (e) { return; }
    if (msg && msg.type === 'status') {
      const status = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message || '');
      if (status && status.trim()) onEvent('status', status);
      return;
    }
    if (msg && msg.type === 'result') {
      if (msg.usage && typeof msg.usage === 'object') onEvent('codex_usage', JSON.stringify(msg.usage));
      return;
    }
  }
  processOutputLine(line, onEvent, state);
}

/**
 * Codex 用量 → 单轮 turnUsage（Claude 口径：input 不含缓存）。
 * 对齐 IDEA CodexMessageHandler.buildTurnUsage；ai-bridge 上报的 input_tokens 含缓存命中部分。
 */
function buildTurnUsage(usage) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = n(usage && usage.input_tokens);
  const cacheRead = n(usage && usage.cache_read_input_tokens);
  return {
    input_tokens: Math.max(0, input - cacheRead),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
    output_tokens: n(usage && usage.output_tokens),
  };
}

/**
 * 前端 codexFastMode → serviceTier（对齐 SessionSendService.normalizeRequestedCodexServiceTier）：
 * fast/priority → 'fast'；其余（normal/standard/空）→ ''，即沿用 Codex 默认档位。
 */
function resolveServiceTier(mode) {
  const v = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  return v === 'fast' || v === 'priority' ? 'fast' : '';
}

/** 追加 Agent 提示词（Codex 不支持 system prompt，对齐 CodexSDKBridge：拼到用户消息末尾）。 */
function appendAgentPrompt(message, agentPrompt) {
  if (!agentPrompt || !String(agentPrompt).trim()) return message;
  return `${message}\n\n## Agent Role and Instructions\n\n${agentPrompt}`;
}

/**
 * 取发给 Codex 的模型：UI 选中的模型若明显是 Claude 模型（切换 provider 前遗留），交给 Codex 默认模型。
 * 自定义中转模型名千差万别，故只排除 Claude 特征，不做白名单。
 */
function resolveCodexModel(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return '';
  if (/^claude-/i.test(m) || /^(sonnet|opus|haiku)(\[|$)/i.test(m)) return '';
  return m;
}

/**
 * 解析 Codex 的 `[model_aliases]`（B3 / 上游 v0.4.8）。
 *
 * 用户可以在 config.toml 里给模型起别名，UI 上选的是别名、真正要发给 CLI 的是别名指向的真实
 * 模型名。上游 `CodexSettingsManager.resolveModelAlias` 无条件读 `~/.codex/config.toml`。
 *
 * **本仓库必须分两种情况**，混在一起会出错：
 *  - 受管供应商（access === 'managed'）：本移植刻意不碰用户的 ~/.codex，配置来自供应商自带的
 *    configToml（已解析成 configOverrides）。此时若去读用户本地 config.toml，会把受管供应商的
 *    模型名替换成用户本地的别名——发到一个完全不相干的端点上。所以只查 configOverrides。
 *  - 其余（local / cli_login）：用的就是用户自己的 ~/.codex，按上游读盘。
 *
 * 任何一步失败（文件不存在、TOML 解析失败、值不是非空字符串）都原样返回，不抛。
 *
 * @param {string} model UI 选中的模型 id
 * @param {object|null} configOverrides 受管供应商解析出的配置；非受管时传 null
 * @param {{ readUserConfig?: () => string }} [deps] 便于测试注入
 * @returns {string} 解析后的真实模型名；无别名时原样返回
 */
function resolveModelAlias(model, configOverrides, deps) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return model;
  try {
    let aliases = null;
    if (configOverrides && typeof configOverrides === 'object') {
      // 受管供应商：只认供应商自己的表
      aliases = configOverrides.model_aliases;
    } else {
      const read = (deps && deps.readUserConfig) || readUserCodexConfigText;
      const text = read();
      if (!text) return m;
      aliases = parseToml(text).model_aliases;
    }
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return m;
    const target = aliases[m];
    return typeof target === 'string' && target.trim() ? target.trim() : m;
  } catch (e) {
    // 用户的 config.toml 写坏了不该让发送失败——退回原模型名
    return m;
  }
}

/** 读用户 ~/.codex/config.toml 原文（不存在/读不了返回空串）。CODEX_HOME 优先。 */
function readUserCodexConfigText() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    return fs.readFileSync(path.join(home, 'config.toml'), 'utf-8');
  } catch (e) {
    return '';
  }
}

module.exports = {
  CODEX_ACCESS_NOT_AUTHORIZED_MESSAGE,
  TomlParseError,
  parseToml,
  sanitizeConfigOverrides,
  buildCodexCredentials,
  saveImageAttachments,
  cleanupFiles,
  processCodexOutputLine,
  buildTurnUsage,
  resolveServiceTier,
  appendAgentPrompt,
  resolveCodexModel,
  resolveModelAlias,
  readUserCodexConfigText,
};
