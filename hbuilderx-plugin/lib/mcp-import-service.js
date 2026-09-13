'use strict';

/**
 * 从 Copilot / VS Code 的 MCP 配置文本解析出本仓库的 MCP server 预览列表（B2 / 上游 v0.4.7）。
 *
 * 对应上游 `mcp/importer/McpServerImportService.java`。纯内存 JSON 变换：不写文件、不发网络。
 * 用户在预览里确认后，前端逐条发 `add_mcp_server` / `add_codex_mcp_server`，走宿主已有的
 * `_handleUpsertMcpServer` 落盘——本模块只负责「解析成预览」。
 *
 * 格式差异：Claude 原生用 `mcpServers`，Copilot 用 `servers`。这里只认 `servers`
 * （与上游一致；导入 Claude 原生格式走的是另一条路径）。
 */

// 直接透传的字段（null 值跳过，避免把 null 写进最终配置）
const PASS_THROUGH_FIELDS = ['command', 'args', 'env', 'url', 'type', 'x-metadata'];

/**
 * Codex 模式下不能透传的字段。
 *
 * 原因：Codex 的配置落盘走 `mcp-service.js` 的 `serializeCodexServers`，它把 spec 的**每一个
 * key** 原样写成 `[mcp_servers.<id>]` 段下的一行 TOML。而 Codex 的 config.toml 在该段下只认
 * command/args/env —— `type` 和 `x-metadata` 写进去是 Codex 不认识的键。
 * 这是 B2 新引入的风险（上游 Codex MCP 走的是另一套 CodexMcpServerSpec，字段名都不一样），
 * 所以在产出预览时就按目标过滤，而不是等到落盘那一步再补救。
 */
const CODEX_DROPPED_FIELDS = new Set(['type', 'x-metadata']);

/** 只拷贝非 null/undefined 的键。 */
function copyNonNull(target, source, keys) {
  if (!source || typeof source !== 'object') return target;
  for (const key of keys) {
    const v = source[key];
    if (v !== null && v !== undefined) target[key] = v;
  }
  return target;
}

/**
 * headers 合并：`requestInit.headers` 打底，顶层 `headers` 覆盖，丢弃 null 值。
 * @returns {Record<string,any>|null} 没有任何 header 时返回 null（不产出空对象）
 */
function collectHeaders(source) {
  const merged = {};
  const bases = [
    source && source.requestInit && source.requestInit.headers,
    source && source.headers,
  ];
  for (const h of bases) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    for (const [k, v] of Object.entries(h)) {
      if (v !== null && v !== undefined) merged[k] = v;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

/**
 * 源里没写 type 时推断传输类型。顺序照抄上游 inferType：
 * 有 command → stdio；url 含 /sse → sse；其他有 url → http；都没有 → stdio。
 */
function inferType(source) {
  if (source && typeof source.command === 'string' && source.command) return 'stdio';
  const url = source && typeof source.url === 'string' ? source.url : '';
  if (url.includes('/sse')) return 'sse';
  if (url) return 'http';
  return 'stdio';
}

/**
 * 解析一段 Copilot 配置文本。
 *
 * @param {string} json 用户粘贴的整段配置
 * @param {boolean} isCodexMode 目标是 Codex 还是 Claude（决定 apps 标记）
 * @returns {{ servers: Array<{id:string,name:string,server:object,apps:object,enabled:boolean}> }}
 * @throws {Error} 根对象缺 `servers`、或解析后一个 server 都没有
 */
function parseCopilotConfig(json, isCodexMode) {
  let root;
  try {
    root = JSON.parse(json);
  } catch (e) {
    throw new Error('配置不是合法 JSON: ' + (e && e.message ? e.message : String(e)));
  }
  const servers = root && typeof root === 'object' ? root.servers : null;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Configuration must contain a "servers" object.');
  }

  const out = [];
  for (const [key, source] of Object.entries(servers)) {
    // 非对象条目直接跳过，而不是报错——一份配置里有一条写坏了不该让整次导入失败
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    const fields = isCodexMode
      ? PASS_THROUGH_FIELDS.filter((f) => !CODEX_DROPPED_FIELDS.has(f))
      : PASS_THROUGH_FIELDS;
    const spec = {};
    copyNonNull(spec, source, fields);
    const headers = collectHeaders(source);
    if (headers) spec.headers = headers;
    // type 只对 Claude 侧有意义（见 CODEX_DROPPED_FIELDS）
    if (!isCodexMode && !spec.type) spec.type = inferType(source);

    out.push({
      id: key,
      name: typeof source.name === 'string' && source.name ? source.name : key,
      server: spec,
      apps: { claude: !isCodexMode, codex: !!isCodexMode, gemini: false },
      enabled: true,
    });
  }

  if (!out.length) throw new Error('No servers found in the configuration.');
  return { servers: out };
}

module.exports = { parseCopilotConfig, inferType, collectHeaders, PASS_THROUGH_FIELDS, CODEX_DROPPED_FIELDS };
