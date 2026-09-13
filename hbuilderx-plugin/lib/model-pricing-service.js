'use strict';

/**
 * 自定义模型单价的持久化（B2 / 上游 v0.4.7）。
 *
 * 对应上游 `handler/provider/CustomModelPricingHandler` + `settings/ModelPricing`。
 *
 * 存储位置与上游不同：上游写 `~/.codemoss/config.json`，本仓库的插件自有状态统一走
 * `prefs.js` 的 `${hx.env.appData}/extensions/ccgui/pref.json`（与 B0 的设置类事件一致），
 * 不为这一个功能新增对 `~/.codemoss` 的依赖。
 *
 * **本批次只做「存」，不做「算」**：本仓库当前没有任何费用计算——`get_usage_statistics`
 * 里 cost 全部硬编码 0，逐模型聚合也没有。消费侧（上游 CustomPricingProvider 的
 * 1m 后缀回退、路由前缀唯一匹配回退等约 300 行）属于 B4（TokenTracker）的范围。
 * 这里先把数据按正确结构存对，B4 直接读即可。
 */

const prefs = require('./prefs');

const PREF_KEY = 'customModelPricing';
const VALID_PROVIDERS = new Set(['claude', 'codex']);
const PRICE_FIELDS = ['inputCostPer1M', 'outputCostPer1M', 'cacheWriteCostPer1M', 'cacheReadCostPer1M'];

/** 非有限数或负数一律当作「未设置」。 */
function readNumber(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * 把前端传来的 models 数组规整成 { [modelId]: {四个维度} }。
 * 跳过：id 空、无 pricing 对象、四个维度全为 null（后三种都表示「用默认单价」）。
 */
function normalizeModels(models) {
  const out = {};
  if (!Array.isArray(models)) return out;
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) continue;
    const pricing = m.pricing;
    if (!pricing || typeof pricing !== 'object') continue;
    const entry = {};
    let any = false;
    for (const f of PRICE_FIELDS) {
      const n = readNumber(pricing[f]);
      entry[f] = n;
      if (n !== null) any = true;
    }
    if (!any) continue;
    out[id] = entry;
  }
  return out;
}

/**
 * 全量替换某个 provider 的自定义单价表。
 *
 * 语义是**替换**不是合并：前端在删除模型或清空单价时会重发整张表，merge 会让删掉的条目
 * 永远留在盘上（见 webview usePluginModels.ts 的注释）。
 *
 * @param {object} hx HBuilderX API 对象
 * @param {string} provider 'claude' | 'codex'
 * @param {Array} models 前端传来的模型数组
 * @returns {boolean} provider 非法时返回 false（静默丢弃，与上游一致，不回错给前端）
 */
function setCustomModelPricing(hx, provider, models) {
  if (!VALID_PROVIDERS.has(provider)) return false;
  const all = prefs.load(hx)[PREF_KEY];
  const next = all && typeof all === 'object' ? { ...all } : {};
  const table = normalizeModels(models);
  if (Object.keys(table).length) next[provider] = table;
  else delete next[provider]; // 空表就删掉该 provider 节点，不留空壳
  prefs.save(hx, { [PREF_KEY]: next });
  return true;
}

/**
 * 读取某个模型的自定义单价。B4 的用量统计会用到；B2 自身没有消费方。
 * @returns {object|null}
 */
function getPricing(hx, provider, modelId) {
  if (!VALID_PROVIDERS.has(provider) || !modelId) return null;
  const all = prefs.load(hx)[PREF_KEY];
  const table = all && typeof all === 'object' ? all[provider] : null;
  if (!table || typeof table !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(table, modelId) ? table[modelId] : null;
}

module.exports = { setCustomModelPricing, getPricing, normalizeModels, PREF_KEY, PRICE_FIELDS };
