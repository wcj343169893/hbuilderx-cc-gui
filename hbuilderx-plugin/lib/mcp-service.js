'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * MCP 服务器配置服务（Claude + Codex 列表/CRUD/启停的纯数据层）。
 *
 * 移植自 JetBrains(Java) 权威实现（务必逐字段对齐，否则与 Claude CLI / JetBrains 不一致）：
 *   - src/.../settings/McpServerManager.java（Claude：~/.claude.json 读写/合并/禁用）
 *   - src/.../handler/McpServerHandler.java（事件 → 回调编排）
 *   - src/.../settings/CodexMcpServerManager.java（Codex：~/.codex/config.toml）
 *
 * 关键对齐点（以 Java + ai-bridge mcp-status/config-loader.js 为双重权威）：
 *
 *   1. Claude 存储位置：**~/.claude.json**（Claude CLI 标准位置，**不是** ~/.claude/settings.json）。
 *      - 全局服务器：根级 `mcpServers`（object，key = serverId，value = 存储形状 {type,command,args,env,url,headers}）。
 *      - 项目级服务器：`projects[<规范化 cwd>].mcpServers`（同形状）。
 *      - 禁用列表：根级 `disabledMcpServers`（string[] of serverId）；项目级 `projects[cwd].disabledMcpServers`。
 *      - **合并规则**（对齐 config-loader.js parseMcpConfig）：若项目配置存在且其 mcpServers 非空 →
 *        用项目 mcpServers + 项目 disabled；否则用全局 mcpServers + （全局∪项目）disabled。
 *        loadAllMcpServersInfo 还会把「仅存在于全局、未被项目覆盖」的服务器补进来。
 *      - **项目路径规范化**：cwd 反斜杠转正斜杠 + 去尾部斜杠（对齐 config-loader.js 第 95-99 行），
 *        匹配/写入 projects 的 key 都用此规范化值，保证 daemon（读）与本模块（写）命中同一项。
 *
 *   2. **禁用机制（toggle）**：不是给 server 设 enabled:false 字段，而是把 serverId 放进/移出
 *      `disabledMcpServers` 数组（与 Java upsertMcpServer + config-loader 的 disabledServers 一致）。
 *      读出时 enabled = !disabledMcpServers.includes(id)。
 *
 *   3. **读-改-写整份 JSON**：~/.claude.json 含大量其它字段（projects 里的会话历史、numStartups 等），
 *      写回时必须保留所有未触及字段，只动 mcpServers / disabledMcpServers / projects[cwd].* 。
 *
 *   4. home 目录解析：用 fs.realpathSync(os.homedir())（对齐 ai-bridge path-utils.getRealHomeDir，
 *      解析 Windows junction / symlink），失败回退 os.homedir()，保证写入与 daemon 读取同一物理文件。
 *
 *   5. Codex 存储：~/.codex/config.toml（TOML）。本模块提供极简 TOML 读写（仅 [mcp_servers.<id>] 段），
 *      禁用机制是每个 server 段的 enabled = true/false 字段（无单独禁用列表）。
 *
 * 设计：纯数据/文件逻辑放本模块（无 hbuilderx 依赖，便于 node --check）；
 * router 只负责取 cwd、调用本模块、把结果 callJs 回前端，并保证出错也回对应回调。
 */

// ==================== 路径解析 ====================

/** 真实 home 目录（解析 symlink/junction，对齐 ai-bridge getRealHomeDir）。 */
function getRealHomeDir() {
  const raw = os.homedir();
  try {
    return fs.realpathSync(raw);
  } catch (e) {
    return raw;
  }
}

/** ~/.claude.json 路径（Claude MCP 标准存储位置；区别于 ~/.claude/settings.json）。 */
function getClaudeJsonPath() {
  return path.join(getRealHomeDir(), '.claude.json');
}

/** ~/.codex/config.toml 路径（Codex MCP 存储）。 */
function getCodexConfigPath() {
  return path.join(getRealHomeDir(), '.codex', 'config.toml');
}

/**
 * 把 cwd 规范化为 ~/.claude.json projects 的 key 形式。
 * 对齐 ai-bridge config-loader.js：反斜杠转正斜杠 + 去尾部斜杠。
 * 注意 daemon 端匹配项目配置时还会尝试 normalizedCwd / 反斜杠变体 / 前缀斜杠变体，
 * 但写入时我们只用正斜杠规范形式（最稳定，且与 Java getMcpServersWithProjectPath 落盘形式一致）。
 */
function normalizeProjectPath(cwd) {
  if (!cwd) return '';
  let p = String(cwd).replace(/\\/g, '/');
  p = p.replace(/\/+$/, '');
  return p;
}

// ==================== ~/.claude.json 读写（读-改-写，保留其它字段）====================

/**
 * 读取整份 ~/.claude.json。不存在/解析失败返回 {}（不抛，调用方按空配置处理）。
 * @returns {object}
 */
function readClaudeJson() {
  const file = getClaudeJsonPath();
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw || !raw.trim()) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    // 解析失败：返回空对象。注意——此时若执行写操作会覆盖坏文件，
    // 故写路径里对「文件存在但解析失败」会抛错保护（见 writeClaudeJsonMcp）。
    return {};
  }
}

/**
 * 安全写回 ~/.claude.json（保留其它字段）。
 * @param {(config:object)=>void} mutate 在读出的整份 config 上原地修改（只动 mcp 相关字段）。
 * @throws 文件已存在但无法解析为 JSON 时抛错，避免覆盖用户数据。
 */
function writeClaudeJsonMcp(mutate) {
  const file = getClaudeJsonPath();
  let config = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf-8');
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          config = parsed;
        } else {
          throw new Error('~/.claude.json 内容不是 JSON 对象');
        }
      } catch (e) {
        // 不能覆盖一个无法解析的现有文件（可能是用户重要数据），直接抛错让上层降级。
        throw new Error('~/.claude.json 解析失败，拒绝覆盖: ' + (e && e.message ? e.message : String(e)));
      }
    }
  }
  mutate(config);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

// ==================== Claude 列表（合并全局 + 项目级）====================

/**
 * 取出合并后的 { mcpServers, disabledServers } —— 对齐 config-loader.js parseMcpConfig 的合并语义。
 * @param {object} config 整份 ~/.claude.json
 * @param {string} cwd 当前工作区（用于项目级配置查找）
 * @returns {{ servers: object, disabled: Set<string>, scopeOf: (id:string)=>string }}
 *   servers: 合并后的 id->存储形状；disabled: 禁用 id 集合；scopeOf: 该 id 来自 'project' 还是 'global'。
 */
function resolveMergedServers(config, cwd) {
  const globalServers = (config.mcpServers && typeof config.mcpServers === 'object') ? config.mcpServers : {};
  const globalDisabled = Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : [];

  const norm = normalizeProjectPath(cwd);
  let projectConfig = null;
  if (norm && config.projects && typeof config.projects === 'object') {
    // 先精确命中，再按 daemon 的变体（反斜杠 / 前缀斜杠）兜底匹配
    if (config.projects[norm]) {
      projectConfig = config.projects[norm];
    } else {
      const variants = [norm, norm.replace(/\//g, '\\'), '/' + norm];
      for (const key of Object.keys(config.projects)) {
        const nk = String(key).replace(/\\/g, '/');
        if (variants.includes(nk)) { projectConfig = config.projects[key]; break; }
      }
    }
  }

  const result = { servers: {}, disabled: new Set(), scope: {} };

  const projectServers = (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object')
    ? projectConfig.mcpServers : {};
  const projectDisabled = (projectConfig && Array.isArray(projectConfig.disabledMcpServers))
    ? projectConfig.disabledMcpServers : [];

  if (projectConfig && Object.keys(projectServers).length > 0) {
    // 项目优先：用项目 mcpServers + 项目 disabled
    for (const id of Object.keys(projectServers)) {
      result.servers[id] = projectServers[id];
      result.scope[id] = 'project';
    }
    for (const id of projectDisabled) result.disabled.add(id);
    // 补充仅存在于全局、未被项目覆盖的服务器（对齐 loadAllMcpServersInfo 的二次扫描）
    for (const id of Object.keys(globalServers)) {
      if (Object.prototype.hasOwnProperty.call(result.servers, id)) continue;
      result.servers[id] = globalServers[id];
      result.scope[id] = 'global';
    }
    for (const id of globalDisabled) result.disabled.add(id);
  } else {
    // 无项目级 mcpServers：用全局 + （全局∪项目）disabled
    for (const id of Object.keys(globalServers)) {
      result.servers[id] = globalServers[id];
      result.scope[id] = 'global';
    }
    for (const id of globalDisabled) result.disabled.add(id);
    for (const id of projectDisabled) result.disabled.add(id);
  }

  return {
    servers: result.servers,
    disabled: result.disabled,
    scopeOf: (id) => result.scope[id] || 'global',
  };
}

/**
 * 把存储形状（{type,command,args,env,url,headers,...}）转成前端 McpServer UI 形状。
 * 对齐 Java McpServerManager 第 137-172 行的 UI 映射。
 * @param {string} id serverId
 * @param {object} spec 存储形状
 * @param {boolean} enabled
 * @param {string} scope 'global' | 'project'
 * @returns {object} UI 形状 McpServer
 */
function toUiServer(id, spec, enabled, scope) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  // server 子对象按存储形状原样透传（前端 McpServerSpec 允许 [key:string]:any）
  const server = Object.assign({}, s);
  // type 兜底：有 url 视为 http，否则 stdio（与 config-loader isValidServerConfig 判定一致）
  if (!server.type) {
    server.type = (typeof s.url === 'string' && s.url) ? 'http' : 'stdio';
  }
  return {
    id,
    name: id,
    server,
    enabled,
    scope,
    // apps：前端 toggle 时会按 provider 维护；列表态给出一个与 enabled 一致的默认，避免 undefined。
    apps: { claude: enabled, codex: false, gemini: false },
  };
}

/**
 * 取 Claude 全部 MCP 服务器（合并全局+项目，含禁用），返回前端 McpServer[] UI 形状。
 * 对齐 Java getMcpServersWithProjectPath。出错由上层兜底（本函数不抛，读失败按空配置）。
 * @param {string} cwd
 * @returns {Array<object>}
 */
function getClaudeServers(cwd) {
  const config = readClaudeJson();
  const merged = resolveMergedServers(config, cwd);
  const list = [];
  for (const id of Object.keys(merged.servers)) {
    const enabled = !merged.disabled.has(id);
    list.push(toUiServer(id, merged.servers[id], enabled, merged.scopeOf(id)));
  }
  return list;
}

// ==================== Claude CRUD / toggle ====================

/**
 * 从前端发来的 UI 形状 McpServer 提取「存储形状」。
 * 优先用 server 子对象；兼容旧格式（字段散在顶层时按白名单收集）。
 */
function extractSpec(uiServer) {
  if (!uiServer || typeof uiServer !== 'object') return {};
  if (uiServer.server && typeof uiServer.server === 'object') {
    // 拷贝，剔除明显不属于存储形状的 UI 字段（防御性；正常 server 子对象本就干净）
    const spec = Object.assign({}, uiServer.server);
    return spec;
  }
  // 旧格式兜底：从顶层收集存储字段
  const spec = {};
  for (const k of ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers']) {
    if (uiServer[k] !== undefined) spec[k] = uiServer[k];
  }
  return spec;
}

/**
 * 确保 config.projects[normKey] 节点存在并返回它（用于项目级写入）。
 */
function ensureProjectNode(config, normKey) {
  if (!config.projects || typeof config.projects !== 'object') config.projects = {};
  if (!config.projects[normKey] || typeof config.projects[normKey] !== 'object') {
    config.projects[normKey] = {};
  }
  return config.projects[normKey];
}

/**
 * 新增/更新一个 Claude MCP 服务器（upsert）。对齐 Java upsertMcpServer。
 * - scope='project' 且有 cwd：写入 projects[cwd].mcpServers / disabledMcpServers；否则写全局。
 * - enabled=false：把 id 加入对应作用域的 disabledMcpServers；enabled=true：移除。
 * @param {object} uiServer 前端 UI 形状（含 id / server / enabled / scope）
 * @param {string} cwd
 */
function upsertClaudeServer(uiServer, cwd) {
  const id = uiServer && uiServer.id != null ? String(uiServer.id) : '';
  if (!id) throw new Error('Missing required field: id');
  const spec = extractSpec(uiServer);
  const enabled = uiServer.enabled !== false; // 缺省视为启用
  const scope = uiServer.scope === 'project' ? 'project' : 'global';

  writeClaudeJsonMcp((config) => {
    if (scope === 'project') {
      const norm = normalizeProjectPath(cwd);
      if (!norm) throw new Error('项目级 MCP 服务器需要已打开的工作区（cwd 为空）');
      const node = ensureProjectNode(config, norm);
      if (!node.mcpServers || typeof node.mcpServers !== 'object') node.mcpServers = {};
      node.mcpServers[id] = spec;
      node.disabledMcpServers = updateDisabledList(node.disabledMcpServers, id, enabled);
    } else {
      if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
      config.mcpServers[id] = spec;
      config.disabledMcpServers = updateDisabledList(config.disabledMcpServers, id, enabled);
    }
  });
}

/**
 * 删除一个 Claude MCP 服务器。对齐 Java deleteMcpServer：
 * 从全局与所有项目的 mcpServers 中删除该 id，并清理其在各 disabledMcpServers 中的残留。
 * （前端 delete 只发 {id}，不带 scope，故全作用域清理最稳妥。）
 * @param {string} id
 */
function deleteClaudeServer(id) {
  const sid = id != null ? String(id) : '';
  if (!sid) throw new Error('Missing required field: id');
  writeClaudeJsonMcp((config) => {
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      delete config.mcpServers[sid];
    }
    config.disabledMcpServers = removeFromList(config.disabledMcpServers, sid);
    if (config.projects && typeof config.projects === 'object') {
      for (const key of Object.keys(config.projects)) {
        const node = config.projects[key];
        if (!node || typeof node !== 'object') continue;
        if (node.mcpServers && typeof node.mcpServers === 'object') delete node.mcpServers[sid];
        if (Array.isArray(node.disabledMcpServers)) {
          node.disabledMcpServers = removeFromList(node.disabledMcpServers, sid);
        }
      }
    }
  });
}

/**
 * 切换 Claude MCP 服务器启停。前端发整个 server 对象（带新 enabled）。
 * 对齐 Java toggle：仅维护 disabledMcpServers，不改 mcpServers 内容。
 * 但因前端 toggle 不一定带 scope，这里按「id 当前实际所在作用域」决定改哪个 disabled 列表：
 *   - 若该 id 存在于某项目的 mcpServers → 改该项目的 disabledMcpServers；
 *   - 否则改全局 disabledMcpServers。
 * @param {object} uiServer
 * @param {string} cwd
 */
function toggleClaudeServer(uiServer, cwd) {
  const id = uiServer && uiServer.id != null ? String(uiServer.id) : '';
  if (!id) throw new Error('Missing required field: id');
  const enabled = uiServer.enabled !== false;

  writeClaudeJsonMcp((config) => {
    // 判定 id 当前作用域：优先看是否定义在当前 cwd 项目的 mcpServers
    const norm = normalizeProjectPath(cwd);
    const projNode = (norm && config.projects && config.projects[norm] && typeof config.projects[norm] === 'object')
      ? config.projects[norm] : null;
    const inProject = !!(projNode && projNode.mcpServers && typeof projNode.mcpServers === 'object'
      && Object.prototype.hasOwnProperty.call(projNode.mcpServers, id));

    if (inProject) {
      projNode.disabledMcpServers = updateDisabledList(projNode.disabledMcpServers, id, enabled);
    } else {
      config.disabledMcpServers = updateDisabledList(config.disabledMcpServers, id, enabled);
    }
  });
}

/** enabled=true → 从 disabled 列表移除 id；enabled=false → 加入（去重）。返回新数组。 */
function updateDisabledList(list, id, enabled) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const idx = arr.indexOf(id);
  if (enabled) {
    if (idx !== -1) arr.splice(idx, 1);
  } else if (idx === -1) {
    arr.push(id);
  }
  return arr;
}

/** 从数组移除某 id（返回新数组）。 */
function removeFromList(list, id) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const idx = arr.indexOf(id);
  if (idx !== -1) arr.splice(idx, 1);
  return arr;
}

// ==================== Codex（~/.codex/config.toml）极简实现 ====================
//
// 仅解析/写入 [mcp_servers.<id>] 段（command/args/env/url/headers/type/enabled 及超时/工具过滤字段）。
// 这是 Codex MVP 降级实现：足以读出/增改删/启停服务器，不追求 TOML 全特性。
// 解析失败一律按空配置处理，绝不抛到前端。

/** 朴素 TOML 标量解析（字符串/数字/布尔/简单内联数组）。 */
function parseTomlScalar(raw) {
  const s = String(raw).trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  // 字符串（双引号或单引号）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // 内联数组 ["a","b"]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => parseTomlScalar(x));
  }
  // 数字
  const n = Number(s);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
  return s; // 兜底当裸字符串
}

/**
 * 解析 Codex config.toml，返回 { servers: { id: { ...字段, enabled } } }。
 * 仅处理 [mcp_servers.<id>] 段；env/headers 作为内联表 { k = "v" } 解析。
 */
function parseCodexConfig(text) {
  const servers = {};
  if (!text) return { servers };
  const lines = String(text).split(/\r?\n/);
  let curId = null;
  let curObj = null;
  // 段头形如 [mcp_servers.weather] 或 [mcp_servers."weather"]
  const sectionRe = /^\s*\[mcp_servers\.("?)([^"\]]+)\1\]\s*$/;
  const kvRe = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/;
  // env / headers 内联表：env = { KEY = "v", K2 = "v2" }
  const inlineTableRe = /^\{(.*)\}$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sec = sectionRe.exec(line);
    if (sec) {
      curId = sec[2];
      curObj = {};
      servers[curId] = curObj;
      continue;
    }
    // 其它段（非 mcp_servers）则停止往当前对象写
    if (/^\s*\[/.test(line) && !sectionRe.test(line)) {
      curId = null;
      curObj = null;
      continue;
    }
    if (!curObj) continue;
    const kv = kvRe.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const valRaw = kv[2].trim();
    const it = inlineTableRe.exec(valRaw);
    if (it) {
      // 解析内联表为对象
      const obj = {};
      const body = it[1].trim();
      if (body) {
        for (const pair of body.split(',')) {
          const m = /^\s*("?)([^"=]+)\1\s*=\s*(.+?)\s*$/.exec(pair);
          if (m) obj[m[2].trim()] = parseTomlScalar(m[3]);
        }
      }
      curObj[key] = obj;
    } else {
      curObj[key] = parseTomlScalar(valRaw);
    }
  }
  return { servers };
}

/** TOML 标量序列化。 */
function tomlValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => tomlValue(x)).join(', ') + ']';
  if (v && typeof v === 'object') {
    const parts = Object.keys(v).map((k) => `${k} = ${tomlValue(v[k])}`);
    return '{ ' + parts.join(', ') + ' }';
  }
  return JSON.stringify(String(v == null ? '' : v));
}

/** 把内存 servers map 序列化为 [mcp_servers.<id>] 段拼成的 TOML 文本（仅本模块管理的段）。 */
function serializeCodexServers(servers) {
  const out = [];
  for (const id of Object.keys(servers)) {
    out.push(`[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id)}]`);
    const obj = servers[id] || {};
    for (const k of Object.keys(obj)) {
      out.push(`${k} = ${tomlValue(obj[k])}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** 读 Codex config.toml 全文（不存在返回空串）。 */
function readCodexText() {
  const file = getCodexConfigPath();
  try {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf-8');
  } catch (e) {
    return '';
  }
}

/**
 * 取 Codex 全部 MCP 服务器，返回前端 McpServer[] UI 形状。
 * enabled 来自每段的 enabled 字段（缺省视为启用，对齐 CodexMcpServerManager）。
 */
function getCodexServers() {
  const { servers } = parseCodexConfig(readCodexText());
  const list = [];
  for (const id of Object.keys(servers)) {
    const raw = servers[id] || {};
    const enabled = raw.enabled !== false;
    const spec = Object.assign({}, raw);
    delete spec.enabled; // enabled 提到 UI 顶层，不放进 server 子对象
    if (!spec.type) spec.type = (typeof spec.url === 'string' && spec.url) ? 'http' : 'stdio';
    list.push({
      id,
      name: id,
      server: spec,
      enabled,
      scope: 'global',
      apps: { claude: false, codex: enabled, gemini: false },
    });
  }
  return list;
}

/**
 * 重写 Codex config.toml 中本模块管理的 [mcp_servers.*] 段，保留文件中其它（非 mcp_servers）内容。
 * 实现：剥离原文里所有 [mcp_servers.*] 段，保留前缀其它行，再追加新序列化的 mcp_servers 段。
 * @param {(servers:object)=>void} mutate 在解析出的 servers map 上原地修改。
 */
function writeCodexServers(mutate) {
  const text = readCodexText();
  const { servers } = parseCodexConfig(text);
  mutate(servers);

  // 去掉原文里的 mcp_servers 段，保留其它段/行
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  let skipping = false;
  const anySectionRe = /^\s*\[/;
  const mcpSectionRe = /^\s*\[mcp_servers\./;
  for (const line of lines) {
    if (anySectionRe.test(line)) {
      skipping = mcpSectionRe.test(line);
    }
    if (!skipping) kept.push(line);
  }
  // 清理尾部多余空行
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();

  const head = kept.length ? kept.join('\n') + '\n\n' : '';
  const body = serializeCodexServers(servers);
  const finalText = (head + body).replace(/\n{3,}/g, '\n\n');

  const file = getCodexConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, finalText.endsWith('\n') ? finalText : finalText + '\n', 'utf-8');
}

/** upsert 一个 Codex 服务器（UI 形状 → TOML 段）。 */
function upsertCodexServer(uiServer) {
  const id = uiServer && uiServer.id != null ? String(uiServer.id) : '';
  if (!id) throw new Error('Missing required field: id');
  const spec = extractSpec(uiServer);
  const enabled = uiServer.enabled !== false;
  writeCodexServers((servers) => {
    const obj = Object.assign({}, spec);
    obj.enabled = enabled;
    servers[id] = obj;
  });
}

/** 删除一个 Codex 服务器。 */
function deleteCodexServer(id) {
  const sid = id != null ? String(id) : '';
  if (!sid) throw new Error('Missing required field: id');
  writeCodexServers((servers) => { delete servers[sid]; });
}

/** 切换 Codex 服务器启停（改段内 enabled 字段）。 */
function toggleCodexServer(uiServer) {
  const id = uiServer && uiServer.id != null ? String(uiServer.id) : '';
  if (!id) throw new Error('Missing required field: id');
  const enabled = uiServer.enabled !== false;
  writeCodexServers((servers) => {
    if (!servers[id] || typeof servers[id] !== 'object') {
      // 段不存在时，至少落一个带 enabled 的占位（避免静默丢失 toggle 意图）
      const spec = extractSpec(uiServer);
      servers[id] = Object.assign({}, spec, { enabled });
    } else {
      servers[id].enabled = enabled;
    }
  });
}

module.exports = {
  // Claude
  getClaudeServers,
  upsertClaudeServer,
  deleteClaudeServer,
  toggleClaudeServer,
  // Codex
  getCodexServers,
  upsertCodexServer,
  deleteCodexServer,
  toggleCodexServer,
  // 路径 / 工具（供 router 或测试复用）
  getClaudeJsonPath,
  getCodexConfigPath,
  normalizeProjectPath,
  readClaudeJson,
  resolveMergedServers,
  toUiServer,
};
