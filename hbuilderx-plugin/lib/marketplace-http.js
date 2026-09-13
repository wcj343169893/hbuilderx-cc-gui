'use strict';

/**
 * MCP Marketplace 的 HTTP 取数 + 磁盘缓存层（B2 / 上游 v0.4.7）。
 *
 * 对应上游 `mcp/marketplace/McpMarketplaceHttpClient.java`。里面每一条约束都是安全加固，
 * 逐条照搬，不要「简化」：
 *
 * - **不跟随重定向**：上游显式 setInstanceFollowRedirects(false) 防 SSRF、防跨域重定向把
 *   GitHub token 泄漏出去。Node 的 https.get 本身就不跟随重定向，这里把任何非 2xx（含 3xx）
 *   一律当错误，语义等价。
 * - **GITHUB_TOKEN 只发给精确白名单 host**，不是「域名以 github.com 结尾」这种前缀匹配。
 * - **响应体 10 MB 上限**：超了立刻 destroy，别把一个坏源的无限响应读进内存。
 * - **磁盘缓存 TTL 1 小时 + 过期兜底**：网络失败但有旧缓存时回落到旧缓存（stale fallback），
 *   只 warn 不抛——离线环境下 marketplace 仍然可用。
 * - **原子写缓存**：临时文件 + rename，避免并发半写留下坏 JSON（下次读会直接抛）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CACHE_TTL_MS = 60 * 60 * 1000;          // 1 小时
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;  // 10 MB
const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 20_000;
const USER_AGENT = 'CoDriver-MCP-Marketplace';

// 只有这三个 host 会收到 GITHUB_TOKEN。精确相等，不做后缀匹配。
const GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'api.mcp.github.com']);

/** 缓存目录：沿用 prefs 的 ${hx.env.appData}/extensions/ccgui 约定。 */
function cacheDir(prefDirPath) {
  return path.join(prefDirPath || path.join(os.homedir(), '.ccgui'), 'mcp-marketplace-cache');
}

/**
 * 缓存文件名：把 key 里的非法字符换掉，避免路径穿越。
 *
 * 光替换分隔符不够：key 恰好是 `.` 或 `..` 时，清洗后仍是 `.`/`..`，
 * `path.join(dir, '..')` 会直接跳到父目录。所以还要把「只由点构成」的结果换掉。
 * cacheKey 目前都是内部拼的（sourceId + 页码 + cursor 哈希），但这是防御性写法——
 * 缓存 key 一旦哪天掺进外部输入，这里就是唯一一道闸。
 */
function cacheFile(prefDirPath, key) {
  let safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  if (!safe || /^\.+$/.test(safe)) safe = '_' + Buffer.from(String(key)).toString('hex').slice(0, 32);
  return path.join(cacheDir(prefDirPath), safe + '.json');
}

function readCache(prefDirPath, key) {
  try {
    const file = cacheFile(prefDirPath, key);
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf-8');
    return { data: JSON.parse(text), ageMs: Date.now() - st.mtimeMs };
  } catch (e) {
    return null;
  }
}

/** 临时文件 + rename 原子落盘。同目录内 rename 才是原子的，所以临时文件放同目录。 */
function writeCacheAtomically(prefDirPath, key, data) {
  try {
    const dir = cacheDir(prefDirPath);
    fs.mkdirSync(dir, { recursive: true });
    const file = cacheFile(prefDirPath, key);
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) {
    // 缓存写失败不影响本次取数结果
  }
}

/**
 * 发一个 GET 并解析 JSON。不跟随重定向、限大小、限时。
 * @param {string} url
 * @param {string|null} githubToken
 * @returns {Promise<any>}
 */
function fetchJson(url, githubToken) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error('非法 URL: ' + url));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('仅支持 http/https: ' + url));
      return;
    }
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (githubToken && GITHUB_HOSTS.has(parsed.hostname)) {
      headers.Authorization = 'Bearer ' + githubToken;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers, timeout: CONNECT_TIMEOUT_MS }, (res) => {
      const status = res.statusCode || 0;
      // 3xx 也算错误：不跟随重定向是刻意的（防 SSRF / token 泄漏）
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error('HTTP ' + status + ' ' + url));
        return;
      }
      let size = 0;
      const chunks = [];
      res.setTimeout(READ_TIMEOUT_MS, () => {
        req.destroy(new Error('读取超时: ' + url));
      });
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('响应体超过 10MB 上限: ' + url));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(new Error('响应不是合法 JSON: ' + url));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时: ' + url)));
    req.on('error', (e) => reject(e));
  });
}

/**
 * 带缓存的取数：命中未过期缓存直接返回；网络失败时回落到过期缓存。
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.cacheKey
 * @param {string} opts.prefDirPath
 * @param {boolean} [opts.forceRefresh] 跳过「未过期」判断，但仍保留失败兜底
 * @param {string|null} [opts.githubToken]
 * @param {(msg:string)=>void} [opts.warn]
 */
async function fetchJsonCached(opts) {
  const { url, cacheKey, prefDirPath, forceRefresh, githubToken, warn } = opts;
  const cached = readCache(prefDirPath, cacheKey);
  if (cached && !forceRefresh && cached.ageMs < CACHE_TTL_MS) return cached.data;

  try {
    const data = await fetchJson(url, githubToken || null);
    writeCacheAtomically(prefDirPath, cacheKey, data);
    return data;
  } catch (e) {
    if (cached) {
      // 有旧缓存就用旧的：离线/被墙时 marketplace 仍然能用，这是刻意的降级
      if (warn) warn(`[marketplace] ${url} 取数失败，回落到过期缓存: ${e && e.message}`);
      return cached.data;
    }
    throw e;
  }
}

module.exports = {
  fetchJson,
  fetchJsonCached,
  cacheDir,
  cacheFile,
  readCache,
  writeCacheAtomically,
  GITHUB_HOSTS,
  CACHE_TTL_MS,
  MAX_RESPONSE_BYTES,
};
