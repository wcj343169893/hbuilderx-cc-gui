'use strict';

/**
 * MCP Marketplace 编排层（B2 / 上游 v0.4.7）。
 *
 * 对应上游 `mcp/marketplace/McpMarketplaceService` + `handler/marketplace/McpMarketplaceHandler`
 * 以及 BuiltIn / Registry / GitHubOrg 三个 client。
 *
 * 设计上最重要的一条：**单个源失败不能中断整体**。内置预设是纯本地的，就算三个网络源全挂
 * （离线、被墙、GitHub 限流），用户也应该照样看到 5 条内置服务器。上游源码在这里专门写了
 * 注释提醒「除 IOException 外还要接住 JSON 解析异常」，本实现用 Promise.allSettled 兜住。
 */

const { fetchJsonCached } = require('./marketplace-http');
const { mapEntry } = require('./mcp-registry-mapper');

const MAX_RESULT_COUNT = 250;
const REGISTRY_PAGE_LIMIT = 100;
const REGISTRY_MAX_PAGES = 20;
const GITHUB_MAX_PAGES = 5;
const GITHUB_PER_PAGE = 100;

// 硬编码的数据源清单（上游 McpMarketplaceSource.defaults()）。
// 注意：前端还有一个伪源 'all'（「All sources」），那个只存在于 UI，宿主不要返回。
const SOURCES = [
  { id: 'built-in', name: 'Built-in Presets', type: 'BUILT_IN', url: 'codriver://built-in-mcp-presets', enabled: true },
  { id: 'official-registry', name: 'Official MCP Registry', type: 'REGISTRY', url: 'https://registry.modelcontextprotocol.io', enabled: true },
  { id: 'github-mcp-registry', name: 'GitHub MCP Registry', type: 'REGISTRY', url: 'https://api.mcp.github.com', enabled: true },
  { id: 'official-github-org', name: 'MCP Official GitHub Org', type: 'GITHUB_ORG', url: 'https://github.com/modelcontextprotocol', enabled: true },
];

// 只有官方 canonical registry 的条目才有资格拿 official 徽章（见 mcp-registry-mapper.isOfficial）
const CANONICAL_REGISTRY_ID = 'official-registry';

// 内置预设（上游 BuiltInMcpMarketplaceClient）：纯本地，零网络，离线也可用。
const BUILT_IN_ENTRIES = [
  {
    name: 'fetch', displayName: 'Fetch',
    description: 'Fetches a URL from the internet and extracts its contents as markdown.',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
    pkg: 'mcp-server-fetch', runner: 'uvx', prefixArgs: [],
  },
  {
    name: 'time', displayName: 'Time',
    description: 'Time and timezone conversion capabilities.',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
    pkg: '@modelcontextprotocol/server-time', runner: 'npx', prefixArgs: ['-y'],
  },
  {
    name: 'memory', displayName: 'Memory',
    description: 'Knowledge graph-based persistent memory system.',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
    pkg: '@modelcontextprotocol/server-memory', runner: 'npx', prefixArgs: ['-y'],
  },
  {
    name: 'sequential-thinking', displayName: 'Sequential Thinking',
    description: 'Dynamic and reflective problem-solving through thought sequences.',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
    pkg: '@modelcontextprotocol/server-sequential-thinking', runner: 'npx', prefixArgs: ['-y'],
  },
  {
    name: 'context7', displayName: 'Context7',
    description: 'Up-to-date code documentation for any library.',
    repositoryUrl: 'https://github.com/upstash/context7',
    pkg: '@upstash/context7-mcp', runner: 'npx', prefixArgs: ['-y'],
  },
];

function getSources() {
  return SOURCES.map((s) => ({ ...s }));
}

function builtInEntries(source) {
  return BUILT_IN_ENTRIES.map((e) => ({
    sourceId: source.id,
    sourceName: source.name,
    name: e.name,
    displayName: e.displayName,
    description: e.description,
    repositoryUrl: e.repositoryUrl,
    version: '',
    tags: [],
    official: true,
    installable: true,
    installOptions: [{
      label: e.runner === 'uvx' ? 'UVX package' : 'NPX package',
      command: e.runner,
      args: [...e.prefixArgs, e.pkg],
      env: {},
      riskLevel: 'local-command',
      transport: 'stdio',
    }],
  }));
}

/** registry 源：cursor 分页，最多 20 页。每页独立缓存。 */
async function registryEntries(source, ctx) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < REGISTRY_MAX_PAGES; page++) {
    const base = source.url.replace(/\/+$/, '');
    const url = `${base}/v0.1/servers?limit=${REGISTRY_PAGE_LIMIT}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const cacheKey = `${source.id}_page_${page}_${cursor ? hashKey(cursor) : 'first'}`;
    const body = await fetchJsonCached({
      url, cacheKey, prefDirPath: ctx.prefDirPath, forceRefresh: ctx.forceRefresh,
      githubToken: ctx.githubToken, warn: ctx.warn,
    });
    const servers = Array.isArray(body && body.servers) ? body.servers : [];
    for (const raw of servers) {
      const entry = mapEntry(raw, {
        sourceId: source.id,
        sourceName: source.name,
        isCanonicalRegistry: source.id === CANONICAL_REGISTRY_ID,
      });
      if (entry) out.push(entry);
    }
    const meta = body && typeof body.metadata === 'object' && body.metadata ? body.metadata : {};
    cursor = meta.next_cursor || meta.nextCursor || '';
    if (!cursor || servers.length === 0) break;
  }
  return out;
}

/** GitHub org 源：页码分页，最多 5 页；空数组或不足一页即停。 */
async function githubOrgEntries(source, ctx) {
  const org = String(source.url).replace(/\/+$/, '').split('/').pop();
  if (!org) return [];
  const out = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/repos`
      + `?type=public&per_page=${GITHUB_PER_PAGE}&sort=stars&direction=desc&page=${page}`;
    const body = await fetchJsonCached({
      url, cacheKey: `${source.id}_page_${page}`, prefDirPath: ctx.prefDirPath,
      forceRefresh: ctx.forceRefresh, githubToken: ctx.githubToken, warn: ctx.warn,
    });
    const repos = Array.isArray(body) ? body : [];
    for (const repo of repos) {
      if (!repo || typeof repo.name !== 'string') continue;
      out.push({
        sourceId: source.id,
        sourceName: source.name,
        name: repo.name,
        displayName: repo.name,
        description: typeof repo.description === 'string' ? repo.description : '',
        repositoryUrl: typeof repo.html_url === 'string' ? repo.html_url : '',
        version: '',
        tags: Array.isArray(repo.topics) ? repo.topics.filter((t) => typeof t === 'string') : [],
        official: false,
        // GitHub 仓库列表不含 package 元数据，给不出可信的安装命令 —— 如实标为不可安装，
        // 不要凭仓库名猜 `npx <repo>`，那是在替用户执行一条没验证过的命令。
        installable: false,
        installOptions: [],
      });
    }
    if (repos.length < GITHUB_PER_PAGE) break;
  }
  return out;
}

function hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}

function matchesRequestedSource(source, sourceId) {
  return !sourceId || sourceId === 'all' || sourceId === source.id;
}

/** query 按空白切词，每个词都要命中（AND 语义）。 */
function matchesQuery(entry, terms) {
  if (!terms.length) return true;
  const hay = [
    entry.name, entry.displayName, entry.description, entry.repositoryUrl,
    ...(entry.tags || []),
  ].join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * 搜索。任一源失败都只记进 errors，不影响其它源。
 *
 * @param {object} req { query, sourceId, forceRefresh }
 * @param {object} ctx { prefDirPath, githubToken, warn }
 * @returns {Promise<{ query, sourceId, entries, error? }>}
 */
async function search(req, ctx) {
  const query = typeof req.query === 'string' ? req.query : '';
  const sourceId = typeof req.sourceId === 'string' ? req.sourceId : 'all';
  const forceRefresh = !!req.forceRefresh;
  const runCtx = { ...ctx, forceRefresh };

  const targets = SOURCES.filter((s) => s.enabled && matchesRequestedSource(s, sourceId));
  const results = await Promise.allSettled(targets.map((s) => {
    if (s.type === 'BUILT_IN') return Promise.resolve(builtInEntries(s));
    if (s.type === 'REGISTRY') return registryEntries(s, runCtx);
    if (s.type === 'GITHUB_ORG') return githubOrgEntries(s, runCtx);
    return Promise.resolve([]);
  }));

  const collected = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') collected.push(...r.value);
    else errors.push(`${targets[i].name}: ${r.reason && r.reason.message ? r.reason.message : r.reason}`);
  });

  // 去重：sourceId + ':' + name，保序取先到者
  const seen = new Set();
  const deduped = [];
  for (const e of collected) {
    const key = e.sourceId + ':' + e.name;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = deduped.filter((e) => matchesQuery(e, terms));

  filtered.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    if (a.installable !== b.installable) return a.installable ? -1 : 1;
    return String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: 'base' });
  });

  const out = { query, sourceId, entries: filtered.slice(0, MAX_RESULT_COUNT) };
  // 部分源失败时如实告诉用户哪个源挂了，但结果照给（内置预设仍在）
  if (errors.length) out.error = errors.join('; ');
  return out;
}

/** 解析前端传来的搜索请求。注意两个默认值不一样，照抄上游 parseSearchRequest。 */
function parseSearchRequest(content) {
  if (!content || !String(content).trim()) {
    return { query: '', sourceId: 'built-in', forceRefresh: false };
  }
  let obj;
  try {
    obj = JSON.parse(content);
  } catch (e) {
    return { query: '', sourceId: 'built-in', forceRefresh: false };
  }
  return {
    query: typeof obj.query === 'string' ? obj.query : '',
    sourceId: typeof obj.sourceId === 'string' && obj.sourceId ? obj.sourceId : 'all',
    forceRefresh: !!obj.forceRefresh,
  };
}

module.exports = {
  getSources, search, parseSearchRequest, matchesQuery, matchesRequestedSource,
  SOURCES, BUILT_IN_ENTRIES, MAX_RESULT_COUNT,
};
