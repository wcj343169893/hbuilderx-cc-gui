'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Agent（子智能体）服务。
 *
 * 移植自 src/.../settings/AgentManager.java + ConfigPathManager.java（agent.json 部分）。
 *
 * 关键对齐点（以 Java 权威实现为准）：
 *   - 存储位置：~/.codemoss/agent.json（**单一 JSON 文件**，不是 ~/.claude/agents/*.md）。
 *     结构：{ "agents": { "<id>": {id,name,prompt?,createdAt}, ... }, "selectedAgentId"?: string }
 *   - getAgents 按 createdAt 降序（最新在前）。
 *   - add：id 必须存在且不重复；自动补 createdAt。
 *   - update：合并 updates，禁止改 id/createdAt；值为 null 则删字段。
 *   - delete：按 id 删；不存在返回 false。
 *   - 导入冲突：detectConflicts 按 id 命中已存在 agent；batchImportAgents 按
 *     skip/overwrite/duplicate 三策略处理（对齐 ConflictStrategy.java，默认 skip）。
 *   - 导出/导入文件格式：{ format:'claude-code-agents-export-v1', exportTime, agentCount, agents:[...] }
 *
 * 注意：与 skills-service.js 不同——agent 是 JSON 条目而非 .md 文件/目录。
 */

const CONFIG_DIR_NAME = '.codemoss';
const AGENT_FILE_NAME = 'agent.json';
const EXPORT_FORMAT = 'claude-code-agents-export-v1';

const NAME_MAX_LENGTH = 20; // 对齐 Java validateAgent：name 1-20 字符
const PROMPT_MAX_LENGTH = 100000; // 对齐 Java validateAgent：prompt < 100000

// ==================== 路径 ====================

/** 配置目录：~/.codemoss。 */
function getConfigDir() {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** agent.json 路径：~/.codemoss/agent.json。 */
function getAgentFilePath() {
  return path.join(getConfigDir(), AGENT_FILE_NAME);
}

/** 确保配置目录存在。 */
function ensureConfigDirectory() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ==================== 读写 ====================

/**
 * 读取 agent.json。不存在/解析失败时返回 { agents: {} }（对齐 Java readAgentConfig 的兜底）。
 * @returns {{agents: Object, selectedAgentId?: string}}
 */
function readAgentConfig() {
  const file = getAgentFilePath();
  if (!fs.existsSync(file)) {
    return { agents: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const config = JSON.parse(raw);
    if (!config || typeof config !== 'object') return { agents: {} };
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    return config;
  } catch (e) {
    // 读/解析失败：返回空壳（与 Java 一致，不抛）
    return { agents: {} };
  }
}

/** 写入 agent.json（保证目录存在）。 */
function writeAgentConfig(config) {
  ensureConfigDirectory();
  fs.writeFileSync(getAgentFilePath(), JSON.stringify(config, null, 2), 'utf-8');
}

// ==================== 查询 ====================

/**
 * 取全部 agent，按 createdAt 降序（最新在前）。每条保证带 id 字段。
 * 对齐 Java getAgents。
 * @returns {Array<object>}
 */
function getAgents() {
  const config = readAgentConfig();
  const agents = config.agents || {};
  const result = [];
  for (const key of Object.keys(agents)) {
    const agent = agents[key];
    if (!agent || typeof agent !== 'object') continue;
    if (agent.id == null) agent.id = key;
    result.push(agent);
  }
  result.sort((a, b) => {
    const ta = typeof a.createdAt === 'number' ? a.createdAt : 0;
    const tb = typeof b.createdAt === 'number' ? b.createdAt : 0;
    return tb - ta; // 降序
  });
  return result;
}

/** 取单个 agent（不存在返回 null）。 */
function getAgent(id) {
  const config = readAgentConfig();
  const agents = config.agents || {};
  if (!Object.prototype.hasOwnProperty.call(agents, id)) return null;
  const agent = agents[id];
  if (agent && agent.id == null) agent.id = id;
  return agent;
}

// ==================== 增 / 改 / 删 ====================

/**
 * 新增 agent。对齐 Java addAgent。
 * @param {object} agent 至少含 id；缺 createdAt 自动补当前毫秒时间戳。
 * @throws id 缺失或已存在时抛错。
 */
function addAgent(agent) {
  if (!agent || agent.id == null || agent.id === '') {
    throw new Error('Agent must have an id');
  }
  const config = readAgentConfig();
  const agents = config.agents || (config.agents = {});
  const id = String(agent.id);

  if (Object.prototype.hasOwnProperty.call(agents, id)) {
    throw new Error("Agent with id '" + id + "' already exists");
  }
  if (agent.createdAt == null) {
    agent.createdAt = Date.now();
  }
  agents[id] = agent;
  writeAgentConfig(config);
}

/**
 * 更新 agent。对齐 Java updateAgent：合并 updates；禁止改 id/createdAt；值为 null 删字段。
 * @throws id 不存在时抛错。
 */
function updateAgent(id, updates) {
  const config = readAgentConfig();
  const agents = config.agents || (config.agents = {});
  if (!Object.prototype.hasOwnProperty.call(agents, id)) {
    throw new Error("Agent with id '" + id + "' not found");
  }
  const agent = agents[id];
  const ups = updates && typeof updates === 'object' ? updates : {};
  for (const key of Object.keys(ups)) {
    if (key === 'id' || key === 'createdAt') continue; // 不允许修改
    const v = ups[key];
    if (v === null) {
      delete agent[key];
    } else {
      agent[key] = v;
    }
  }
  writeAgentConfig(config);
}

/**
 * 删除 agent。对齐 Java deleteAgent：不存在返回 false，删后写回返回 true。
 * @returns {boolean}
 */
function deleteAgent(id) {
  const config = readAgentConfig();
  const agents = config.agents || (config.agents = {});
  if (!Object.prototype.hasOwnProperty.call(agents, id)) {
    return false;
  }
  delete agents[id];
  // 若被删的是当前选中项，清空 selectedAgentId（对齐 Java AgentHandler 的清理逻辑）
  if (config.selectedAgentId === id) {
    delete config.selectedAgentId;
  }
  writeAgentConfig(config);
  return true;
}

// ==================== 导入 / 导出 ====================

/**
 * 校验导入的 agent。对齐 Java validateAgent。
 * @returns {string|null} 错误信息，合法返回 null。
 */
function validateAgent(agent) {
  if (!agent || typeof agent !== 'object') return 'Agent data is null';
  if (agent.id == null || agent.id === '') return 'Missing required field: id';
  if (agent.name == null) return 'Missing required field: name';
  const name = String(agent.name);
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
    return 'Agent name must be 1-20 characters';
  }
  if (agent.prompt != null) {
    if (String(agent.prompt).length > PROMPT_MAX_LENGTH) {
      return 'Agent prompt must be less than 100,000 characters';
    }
  }
  return null;
}

/**
 * 检测与已存在 agent 的 id 冲突。对齐 Java detectConflicts。
 * @param {Array<object>} agentsToImport
 * @returns {Set<string>} 冲突的 id 集合
 */
function detectConflicts(agentsToImport) {
  const conflicts = new Set();
  const config = readAgentConfig();
  const existing = config.agents || {};
  const list = Array.isArray(agentsToImport) ? agentsToImport : [];
  for (const agent of list) {
    if (agent && agent.id != null) {
      const id = String(agent.id);
      if (Object.prototype.hasOwnProperty.call(existing, id)) conflicts.add(id);
    }
  }
  return conflicts;
}

/** 基于 baseId 生成唯一 id（追加 -1/-2…）。对齐 Java generateUniqueId。 */
function generateUniqueId(baseId, existingItems) {
  let uniqueId = baseId;
  let suffix = 1;
  while (Object.prototype.hasOwnProperty.call(existingItems, uniqueId)) {
    uniqueId = baseId + '-' + suffix;
    suffix++;
  }
  return uniqueId;
}

/**
 * 解析导出文件内容为待导入 agent 列表，并产出预览结构。对齐 Java handleImportAgentsFile 的预览部分。
 * @param {string} fileContent 文件原始文本
 * @returns {{items: Array, summary: {total, newCount, updateCount}}}
 * @throws 格式非法时抛错。
 */
function buildImportPreview(fileContent) {
  let importData;
  try {
    importData = JSON.parse(fileContent);
  } catch (e) {
    throw new Error('Invalid JSON file');
  }
  if (!importData || importData.format !== EXPORT_FORMAT) {
    throw new Error('Invalid file format. Expected ' + EXPORT_FORMAT);
  }
  if (!Array.isArray(importData.agents)) {
    throw new Error("Invalid file: missing 'agents' field");
  }
  const agentsToImport = importData.agents;
  const conflicts = detectConflicts(agentsToImport);

  const items = [];
  for (const agent of agentsToImport) {
    const id = agent && agent.id != null ? String(agent.id) : '';
    const hasConflict = conflicts.has(id);
    items.push({
      data: agent,
      status: hasConflict ? 'update' : 'new',
      conflict: hasConflict,
    });
  }

  return {
    items,
    summary: {
      total: agentsToImport.length,
      newCount: agentsToImport.length - conflicts.size,
      updateCount: conflicts.size,
    },
  };
}

/**
 * 按冲突策略批量导入 agent。对齐 Java batchImportAgents。
 * @param {Array<object>} agentsToImport
 * @param {string} strategy 'skip' | 'overwrite' | 'duplicate'（非法值降级为 skip）
 * @returns {{success, imported, updated, skipped, errors}}
 */
function batchImportAgents(agentsToImport, strategy) {
  let imported = 0;
  let skipped = 0;
  let updated = 0;
  const errors = [];

  const normStrategy = (() => {
    const s = (typeof strategy === 'string' ? strategy : '').toLowerCase();
    if (s === 'overwrite' || s === 'duplicate' || s === 'skip') return s;
    return 'skip'; // 默认/非法降级 skip（对齐 ConflictStrategy.fromValue）
  })();

  const config = readAgentConfig();
  const agents = config.agents || (config.agents = {});
  const list = Array.isArray(agentsToImport) ? agentsToImport : [];
  const conflicts = detectConflicts(list);

  for (const agent of list) {
    try {
      const validationError = validateAgent(agent);
      if (validationError != null) {
        errors.push('Validation failed: ' + validationError);
        skipped++;
        continue;
      }
      const id = String(agent.id);
      const hasConflict = conflicts.has(id);

      if (hasConflict) {
        if (normStrategy === 'skip') {
          skipped++;
          continue;
        } else if (normStrategy === 'overwrite') {
          agents[id] = agent;
          updated++;
        } else if (normStrategy === 'duplicate') {
          const newId = generateUniqueId(id, agents);
          const duplicated = Object.assign({}, agent, { id: newId });
          if (duplicated.createdAt == null) duplicated.createdAt = Date.now();
          agents[newId] = duplicated;
          imported++;
        }
      } else {
        if (agent.createdAt == null) agent.createdAt = Date.now();
        agents[id] = agent;
        imported++;
      }
    } catch (e) {
      errors.push('Failed to import agent: ' + (e && e.message ? e.message : String(e)));
      skipped++;
    }
  }

  writeAgentConfig(config);

  return {
    success: errors.length === 0,
    imported,
    updated,
    skipped,
    errors,
  };
}

/**
 * 构造导出数据对象（写文件用）。对齐 Java handleExportAgents 的 exportData 结构。
 * @param {string[]=} agentIds 仅导出这些 id；为空/未传则导出全部。
 * @returns {{format, exportTime, agentCount, agents:Array}}
 */
function buildExportData(agentIds) {
  let agents = getAgents();
  if (Array.isArray(agentIds) && agentIds.length > 0) {
    const set = new Set(agentIds.map((x) => String(x)));
    agents = agents.filter((a) => set.has(String(a.id)));
  }
  // exportTime 形如 'yyyy-MM-dd HH:mm:ss'（对齐 Java SimpleDateFormat）
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const exportTime = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

  return {
    format: EXPORT_FORMAT,
    exportTime,
    agentCount: agents.length,
    agents,
  };
}

/** 默认导出文件名：agents-yyyyMMdd-HHmmss.json（对齐 Java filenameDateFormat）。 */
function defaultExportFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  return 'agents-' + stamp + '.json';
}

module.exports = {
  // 查询
  getAgents,
  getAgent,
  // 增改删
  addAgent,
  updateAgent,
  deleteAgent,
  // 导入导出
  validateAgent,
  detectConflicts,
  generateUniqueId,
  buildImportPreview,
  batchImportAgents,
  buildExportData,
  defaultExportFilename,
  // 路径辅助
  getConfigDir,
  getAgentFilePath,
  // 常量
  EXPORT_FORMAT,
};
