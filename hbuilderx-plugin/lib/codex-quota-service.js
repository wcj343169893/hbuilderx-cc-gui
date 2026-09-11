'use strict';

/**
 * Codex 订阅配额快照（移植自 IDEA 版 CodexSubscriptionQuotaService 的精简子集）。
 *
 * 背景：前端 ProviderSelect 打开「Codex 配额」子菜单即发 get_codex_subscription_quota，
 * 此前 message-router 无对应 case → 消息落 default 被静默丢弃 → 永不回 updateCodexSubscriptionQuota
 * → 前端永远停在「正在加载配额...」（与中转/直连无关，所有用户都会卡住）。
 *
 * 数据来源（优先级同 IDEA 版）：
 *   1) ~/.codex/sessions 下最近会话 JSONL 里 event_msg/token_count 事件携带的 rate_limits（60s 内视为新鲜）
 *   2) chatgpt.com wham/usage 接口（需 ~/.codex/auth.json 的 OAuth access_token）
 *   3) 以上都失败：回退到最近一次成功快照（标 stale），否则返回 unavailable + 原因
 * 运行模式读自 ~/.codemoss/config.json 的 codex 段（与 ai-bridge getCodexRuntimeState 一致）：
 *   managed（API Key 供应商）无订阅配额，直接返回 api_key_mode；inactive 返回 unavailable。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CODEX_CLI_LOGIN_PROVIDER_ID = '__codex_cli_login__';
const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const HTTP_TIMEOUT_MS = 12000;
const SESSION_FRESH_MS = 60 * 1000;   // 会话事件 60s 内视为新鲜（对齐 SESSION_FALLBACK_TIMEOUT）
const API_CACHE_MS = 60 * 1000;       // wham/usage 结果缓存 60s（对齐 API_UPDATE_TIMEOUT）
const MAX_SESSION_FILES = 10;         // 只扫最近修改的若干个会话文件，避免大目录全量读

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    return null;
  }
}

/**
 * 解析 codex 运行模式：cli_login / managed / inactive（与 ai-bridge api-config.getCodexRuntimeState 同语义）。
 * managed 时附带当前供应商对象（发送时据此取 configToml/authJson），其余模式 provider 为 null。
 */
function resolveAccessMode(homeDir) {
  const config = readJson(path.join(homeDir, '.codemoss', 'config.json'));
  const codex = config && typeof config.codex === 'object' ? config.codex : null;
  const providers = codex && codex.providers && typeof codex.providers === 'object' ? codex.providers : {};
  const currentId = codex && codex.current != null ? String(codex.current).trim() : '';
  if (currentId === CODEX_CLI_LOGIN_PROVIDER_ID) return { access: 'cli_login', currentId, provider: null };
  if (currentId && Object.prototype.hasOwnProperty.call(providers, currentId)) {
    return { access: 'managed', currentId, provider: providers[currentId] || null };
  }
  return { access: 'inactive', currentId, provider: null };
}

function readNumber(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickObject(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === 'object') return obj[k];
  }
  return null;
}

/** 秒/毫秒时间戳或 ISO 字符串 → 毫秒（无法识别返回 null）。 */
function readEpochMillis(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number') {
      if (v > 1e12) return v;
      if (v > 1e9) return v * 1000;
    } else if (typeof v === 'string' && v.trim()) {
      const t = Date.parse(v.trim());
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

function toWindow(label, defaultHours, src, source, now) {
  let minutes = readNumber(src, 'window_duration_mins', 'window_minutes') || 0;
  if (minutes <= 0) {
    const secs = readNumber(src, 'limit_window_seconds') || 0;
    minutes = secs > 0 ? Math.max(1, Math.floor(secs / 60)) : 0;
  }
  const usedPercent = readNumber(src, 'used_percent');
  return {
    windowLabel: label,
    windowHours: minutes > 0 ? Math.max(1, Math.floor(minutes / 60)) : defaultHours,
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    resetsAt: readEpochMillis(src, 'reset_at', 'resets_at'),
    usedTokens: 0,
    limitTokens: null,
    remainingTokens: null,
    usedCost: null,
    sessionCount: 0,
    lastUpdated: now,
    source,
  };
}

function buildPayloadFromRateLimit(rateLimit, now, source) {
  return {
    status: 'ok',
    fetchedAt: now,
    source,
    windows: {
      fiveHour: toWindow('5h', 5, pickObject(rateLimit, 'primary_window', 'primary'), source, now),
      weekly: toWindow('weekly', 7 * 24, pickObject(rateLimit, 'secondary_window', 'secondary'), source, now),
    },
  };
}

function buildUnavailablePayload(reason, now) {
  return {
    status: 'unavailable',
    fetchedAt: now,
    source: 'none',
    error: reason || 'unavailable',
    windows: {
      fiveHour: toWindow('5h', 5, null, 'none', now),
      weekly: toWindow('weekly', 7 * 24, null, 'none', now),
    },
  };
}

function buildApiKeyModePayload(now) {
  const payload = buildUnavailablePayload('API key mode has no subscription quota', now);
  payload.reasonCode = 'api_key_mode';
  return payload;
}

/** 递归收集 sessions 目录下的 .jsonl 及其 mtime（目录结构 YYYY/MM/DD/*.jsonl，深度有限）。 */
async function listSessionFiles(dir, depth = 0, acc = []) {
  if (depth > 5) return acc;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await listSessionFiles(p, depth + 1, acc);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      try {
        const st = await fs.promises.stat(p);
        acc.push({ file: p, mtimeMs: st.mtimeMs });
      } catch (e) { /* 文件并发删除等：跳过 */ }
    }
  }
  return acc;
}

/** 从单个会话文件末尾往前找最后一条带 rate_limits 的 token_count 事件。 */
async function findLastRateLimits(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"token_count"') < 0 || line.indexOf('"event_msg"') < 0) continue;
    try {
      const msg = JSON.parse(line);
      const payload = msg && msg.payload;
      if (!msg || msg.type !== 'event_msg' || !payload || payload.type !== 'token_count') continue;
      const rateLimits = pickObject(payload, 'rate_limits');
      if (!rateLimits) continue; // API Key / 中转模式下 rate_limits 为 null，继续往前找
      const ts = Date.parse(msg.timestamp);
      return { rateLimits, timestamp: Number.isFinite(ts) ? ts : 0 };
    } catch (e) { /* 坏行：跳过 */ }
  }
  return null;
}

function defaultFetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.get(WHAM_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'hbuilderx-cc-gui-codex-quota',
      },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`wham/usage HTTP ${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          if (!parsed || typeof parsed !== 'object') throw new Error('wham/usage returned non-object JSON');
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('wham/usage request timed out')));
    req.on('error', reject);
  });
}

class CodexQuotaService {
  /**
   * @param {{ homeDir?: string, fetchUsage?: (token: string) => Promise<object>, now?: () => number }} [opts]
   *   依赖注入仅供测试；生产环境全部走默认值。
   */
  constructor(opts = {}) {
    this.homeDir = opts.homeDir || os.homedir();
    this.fetchUsage = opts.fetchUsage || defaultFetchUsage;
    this.now = opts.now || Date.now;
    this._inFlight = null;
    this._apiCache = null;      // { payload, at, accountKey }
    this._lastGood = null;      // { payload, accountKey } 最近一次成功快照，兜底用
  }

  /** 切换 Codex 账号/供应商后调用，避免把上一个账号的配额展示给新账号。 */
  invalidate() {
    this._apiCache = null;
    this._lastGood = null;
    this._inFlight = null;
  }

  /** 获取配额快照；并发请求复用同一次刷新。永不 reject（失败也返回 unavailable 快照）。 */
  getSnapshot() {
    if (this._inFlight) return this._inFlight;
    const p = this._refresh()
      .catch((e) => buildUnavailablePayload(e && e.message, this.now()))
      .finally(() => { if (this._inFlight === p) this._inFlight = null; });
    this._inFlight = p;
    return p;
  }

  async _refresh() {
    const now = this.now();
    const { access, currentId } = resolveAccessMode(this.homeDir);
    // 必须先于缓存判断：避免 cli_login 下缓存的快照在切到 API Key 供应商后仍被展示。
    if (access === 'managed') return buildApiKeyModePayload(now);
    if (access === 'inactive') return buildUnavailablePayload('Codex runtime access is inactive', now);

    const accountKey = `${access}:${currentId}`;
    if (this._lastGood && this._lastGood.accountKey !== accountKey) this.invalidate();

    // 1) 最近会话事件
    const files = (await listSessionFiles(path.join(this.homeDir, '.codex', 'sessions')))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SESSION_FILES);
    let sessionHit = null;
    for (const f of files) {
      sessionHit = await findLastRateLimits(f.file);
      if (sessionHit) break;
    }
    if (sessionHit && sessionHit.timestamp > 0 && now - sessionHit.timestamp <= SESSION_FRESH_MS) {
      const payload = buildPayloadFromRateLimit(sessionHit.rateLimits, now, 'session_event');
      this._lastGood = { payload, accountKey };
      return payload;
    }

    // 2) wham/usage 接口（60s 缓存）
    if (this._apiCache && this._apiCache.accountKey === accountKey && now - this._apiCache.at <= API_CACHE_MS) {
      return this._apiCache.payload;
    }
    let reason;
    const auth = readJson(path.join(this.homeDir, '.codex', 'auth.json'));
    const tokens = pickObject(auth, 'tokens');
    const token = tokens && (tokens.access_token || tokens.accessToken);
    if (token) {
      try {
        const usage = await this.fetchUsage(String(token));
        const payload = buildPayloadFromRateLimit(pickObject(usage, 'rate_limit'), now, 'wham_usage');
        this._apiCache = { payload, at: now, accountKey };
        this._lastGood = { payload, accountKey };
        return payload;
      } catch (e) {
        reason = e && e.message;
      }
    } else {
      reason = 'No access_token in ~/.codex/auth.json';
    }

    // 3) 兜底：最近一次成功快照 → 旧会话事件 → unavailable
    if (this._lastGood) return { ...this._lastGood.payload, stale: true };
    if (sessionHit) return { ...buildPayloadFromRateLimit(sessionHit.rateLimits, now, 'session_event'), stale: true };
    return buildUnavailablePayload(reason, now);
  }
}

module.exports = { CodexQuotaService, resolveAccessMode, buildUnavailablePayload };
