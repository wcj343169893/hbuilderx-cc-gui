'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 技能（Skills）服务。
 *
 * 移植自 src/.../skill/SkillService.java + SkillFrontmatterParser.java（Claude 语义子集）。
 * 负责技能的扫描、导入、删除、启用/停用（启用=文件/目录移动）。
 *
 * 启用态存储目录（Claude CLI 实际读取）：
 *   - global: ~/.claude/skills
 *   - local : {workspace}/.claude/skills
 * 管理目录（停用态存储）：
 *   - global: ~/.codemoss/skills/global
 *   - local : ~/.codemoss/skills/{projectName}_{hashHex}
 *     其中 hashHex = Integer.toHexString(workspaceRoot.hashCode())，必须与 Java 完全一致，否则停用目录对不上。
 *
 * 注意：按 Agent Skills 规范，**只有目录**才是合法 skill（与 Java scanSkillsDirectory 一致，
 * 单个 .md 文件不计入扫描结果）。
 */

const CONFIG_DIR_NAME = '.codemoss';
const SKILLS_DIR_NAME = 'skills';
const GLOBAL_DIR_NAME = 'global';

const DESCRIPTION_MAX_LENGTH = 1024;
const NAME_MAX_LENGTH = 64;

/** 安全 skill 名校验（防路径穿越）：首字符为字母数字，其余允许字母数字 . - _。 */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Agent Skills 规范的 name 校验：小写字母数字+连字符，1-64，无首尾/连续连字符。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * 复刻 Java String.hashCode()：s[0]*31^(n-1)+...+s[n-1]，32 位有符号整型溢出。
 * Math.imul 做 32 位乘法，`| 0` 保持有符号 32 位环绕，结果与 JVM 完全一致。
 */
function javaStringHashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** 复刻 Java Integer.toHexString()：按无符号 32 位输出小写十六进制、无前导零。 */
function javaIntToHexString(intVal) {
  return (intVal >>> 0).toString(16);
}

/** 校验 skill 名是否安全（无 .. / \ 与空字节，且匹配 SAFE_NAME）。 */
function isSafeSkillName(name) {
  if (!name) return false;
  if (name.indexOf('..') !== -1 || name.indexOf('/') !== -1
    || name.indexOf('\\') !== -1 || name.indexOf('\0') !== -1) {
    return false;
  }
  return SAFE_NAME.test(name);
}

/** Agent Skills 规范 name 是否合法。 */
function isValidSkillName(name) {
  if (!name || name.length > NAME_MAX_LENGTH) return false;
  if (name.indexOf('--') !== -1) return false;
  return SKILL_NAME_PATTERN.test(name);
}

// ==================== 目录解析 ====================

/** 全局启用目录：~/.claude/skills。 */
function getGlobalSkillsDir() {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** 本地启用目录：{workspaceRoot}/.claude/skills（无工作区返回 null）。 */
function getLocalSkillsDir(workspaceRoot) {
  if (!workspaceRoot) return null;
  return path.join(workspaceRoot, '.claude', 'skills');
}

/** 管理目录根：~/.codemoss/skills。 */
function getManagementRootDir() {
  return path.join(os.homedir(), CONFIG_DIR_NAME, SKILLS_DIR_NAME);
}

/** 全局管理（停用）目录：~/.codemoss/skills/global。 */
function getGlobalManagementDir() {
  return path.join(getManagementRootDir(), GLOBAL_DIR_NAME);
}

/**
 * 本地管理（停用）目录：~/.codemoss/skills/{projectName}_{hashHex}。
 * projectName = basename(workspaceRoot)（对齐 Java Paths.get(root).getFileName()）；
 * hashHex 用 workspaceRoot 原始字符串算（对齐 Java workspaceRoot.hashCode()）。
 */
function getLocalManagementDir(workspaceRoot) {
  if (!workspaceRoot) return null;
  const projectName = path.basename(workspaceRoot);
  const pathHash = javaIntToHexString(javaStringHashCode(workspaceRoot));
  const safeDirName = projectName + '_' + pathHash;
  return path.join(getManagementRootDir(), safeDirName);
}

/** 确保目录存在（不存在则创建）。 */
function ensureDirectoryExists(dirPath) {
  if (!dirPath) return false;
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

// ==================== Frontmatter 解析 ====================

/** 定位 skill 目录下的 SKILL.md（优先大写）或 skill.md，均无返回 null。 */
function locateSkillMd(skillDir) {
  const upper = path.join(skillDir, 'SKILL.md');
  try { if (fs.statSync(upper).isFile()) return upper; } catch (e) { /* ignore */ }
  const lower = path.join(skillDir, 'skill.md');
  try { if (fs.statSync(lower).isFile()) return lower; } catch (e) { /* ignore */ }
  return null;
}

/** 读取首对 --- 之间的 frontmatter 文本（对齐 Java extractFrontmatter 的边界判定）。 */
function extractFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  // 从位置 3 起找闭合 \n---（跳过开头的 ---）
  const secondDelimiter = content.indexOf('\n---', 3);
  if (secondDelimiter < 0) return null;
  const yaml = content.substring(3, secondDelimiter).trim();
  return yaml.length ? yaml : null;
}

/**
 * 从 frontmatter YAML 文本里取单个标量字段（name/description 等）。
 * 仅做行级解析：`key: value`，支持单/双引号包裹与 # 注释剥离；
 * 不接 YAML 库（HBuilderX 内置 Node 无 snakeyaml 等价物），对常见 SKILL.md 足够。
 * 解析失败/缺字段返回 null。
 */
function getYamlScalar(yamlText, key) {
  const lines = yamlText.split(/\r\n|\r|\n/);
  // 仅匹配顶层 key（行首无缩进），避免误取嵌套字段
  const re = new RegExp('^' + key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*:\\s*(.*)$');
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    let val = m[1];
    // 去尾部未被引号包裹的 # 注释
    // 先判断是否整体被引号包裹
    const trimmed = val.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
      || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
      return trimmed.substring(1, trimmed.length - 1).trim();
    }
    // 非引号：剥离行内注释（前面有空白的 #）
    const hashIdx = val.search(/\s#/);
    if (hashIdx >= 0) val = val.substring(0, hashIdx);
    val = val.trim();
    return val.length ? val : null;
  }
  return null;
}

/**
 * 取 frontmatter 之后正文的首个非空段落（description 缺失时的兜底，对齐 Java extractFirstParagraph）。
 */
function extractFirstParagraph(content) {
  if (!content.startsWith('---')) return null;
  const closingDelimiter = content.indexOf('\n---', 3);
  if (closingDelimiter < 0) return null;
  // 跳过闭合 --- 行
  const bodyStart = content.indexOf('\n', closingDelimiter + 4);
  if (bodyStart < 0 || bodyStart >= content.length) return null;
  let body = content.substring(bodyStart + 1).replace(/^\s+/, '');
  if (!body) return null;
  const blankLine = body.indexOf('\n\n');
  let firstParagraph = (blankLine > 0 ? body.substring(0, blankLine) : body).trim();
  // 剥离前导 markdown 标题符号
  firstParagraph = firstParagraph.replace(/^#+\s*/, '');
  if (!firstParagraph) return null;
  if (firstParagraph.length > DESCRIPTION_MAX_LENGTH) {
    return firstParagraph.substring(0, DESCRIPTION_MAX_LENGTH);
  }
  return firstParagraph;
}

/**
 * 解析 skill 目录的 frontmatter，返回 { name, description } 或 null（无 SKILL.md / 无 frontmatter）。
 * 对齐 Java SkillFrontmatterParser.parse 的取值与兜底顺序。
 */
function parseSkillMetadata(skillDir) {
  const skillMd = locateSkillMd(skillDir);
  if (!skillMd) return null;

  let content;
  try {
    content = fs.readFileSync(skillMd, 'utf-8');
  } catch (e) {
    return null;
  }

  const yamlText = extractFrontmatter(content);
  if (yamlText == null) return null;

  const dirName = path.basename(skillDir);

  // name：可选，非法时回退目录名
  let name = getYamlScalar(yamlText, 'name');
  if (name != null) {
    name = name.trim();
    if (!isValidSkillName(name)) name = dirName;
  } else {
    name = dirName;
  }

  // description：可选，缺失时取正文首段
  let description = getYamlScalar(yamlText, 'description');
  if (description != null) description = description.trim();
  if (!description) {
    description = extractFirstParagraph(content);
  }
  if (!description) description = '';
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    description = description.substring(0, DESCRIPTION_MAX_LENGTH);
  }

  return { name, description };
}

// ==================== 扫描 ====================

/**
 * 扫描某目录下的技能。仅目录视为合法 skill；跳过隐藏项与普通文件（对齐 Java）。
 * @param {string} dirPath 目录
 * @param {string} scope global / local
 * @param {boolean} enabled 该目录下技能是否为启用态
 * @returns {Object<string, object>} id -> skill 的映射（SkillsMap 形状）
 */
function scanSkillsDirectory(dirPath, scope, enabled) {
  const skills = {};
  if (!dirPath || !fs.existsSync(dirPath)) return skills;

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return skills;
  }

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue; // 跳过隐藏项
    // 按 Agent Skills 规范，只有目录是合法 skill
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      // 软链指向目录时也按目录处理
      try { isDir = fs.statSync(path.join(dirPath, name)).isDirectory(); } catch (e) { isDir = false; }
    }
    if (!isDir) continue;

    const fullPath = path.join(dirPath, name);
    // id 带启用/停用标记，区分同名技能
    const id = scope + '-' + name + (enabled ? '' : '-disabled');

    const skill = {
      id,
      type: 'directory',
      scope,
      path: fullPath,
      enabled,
    };

    const metadata = parseSkillMetadata(fullPath);
    if (metadata != null) {
      skill.name = metadata.name;
      skill.description = metadata.description;
    } else {
      // 无有效 frontmatter：仍保留在列表中，名用目录名并标记 warning
      skill.name = name;
      skill.warning = 'invalid_frontmatter';
    }

    try {
      const st = fs.statSync(fullPath);
      if (st.birthtime) skill.createdAt = st.birthtime.toISOString();
      if (st.mtime) skill.modifiedAt = st.mtime.toISOString();
    } catch (e) { /* 读不到属性不影响 */ }

    skills[id] = skill;
  }

  return skills;
}

/** 取某 scope 的全部技能（启用 + 停用合并）。 */
function getAllSkillsByScope(scope, workspaceRoot) {
  const allSkills = {};

  const activeDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  if (activeDir) {
    const activeSkills = scanSkillsDirectory(activeDir, scope, true);
    Object.assign(allSkills, activeSkills);
  }

  const managementDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  if (managementDir) {
    const disabledSkills = scanSkillsDirectory(managementDir, scope, false);
    Object.assign(allSkills, disabledSkills);
  }

  return allSkills;
}

/**
 * 取全部技能（global + local），形状对齐前端 SkillsConfig。
 * 同时带上空的 user/repo（Codex 字段），避免前端对其调 Object.values 时为 undefined。
 */
function getAllSkills(workspaceRoot) {
  return {
    global: getAllSkillsByScope('global', workspaceRoot),
    local: getAllSkillsByScope('local', workspaceRoot),
    user: {},
    repo: {},
  };
}

// ==================== 文件操作 ====================

/** 递归复制目录。 */
function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** 递归删除目录（Node 18 fs.rmSync 支持 recursive）。 */
function deleteDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 移动文件/目录（先尝试 rename，跨盘失败回退「复制 + 删除」）。 */
function movePath(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    // 跨文件系统等情况：复制后删除
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      copyDirectory(src, dest);
      deleteDirectory(src);
    } else {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }
  }
}

/**
 * 导入技能（复制源文件/目录到启用目录）。对齐 Java importSkills。
 * @param {string[]} sourcePaths 源路径列表
 * @param {string} scope global / local
 * @param {string} workspaceRoot 工作区根
 * @returns {object} { success, count, total, imported, errors? } —— 形状对齐前端 skillImportResult
 */
function importSkills(sourcePaths, scope, workspaceRoot) {
  const result = {};
  const imported = [];
  const errors = [];

  const targetDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  if (!targetDir) {
    return { success: false, error: '无法获取 ' + scope + ' Skills 目录' };
  }

  if (!fs.existsSync(targetDir)) {
    if (!ensureDirectoryExists(targetDir)) {
      return { success: false, error: '无法创建 Skills 目录: ' + targetDir };
    }
  }

  const list = Array.isArray(sourcePaths) ? sourcePaths : [];
  for (const sourcePath of list) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      errors.push({ path: sourcePath, error: '源路径不存在' });
      continue;
    }

    const name = path.basename(sourcePath);
    const targetPath = path.join(targetDir, name);

    if (fs.existsSync(targetPath)) {
      errors.push({ path: sourcePath, error: '已存在同名 Skill: ' + name });
      continue;
    }

    try {
      const st = fs.statSync(sourcePath);
      const isDir = st.isDirectory();
      if (isDir) {
        copyDirectory(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }

      const type = isDir ? 'directory' : 'file';
      const id = scope + '-' + name;
      const skill = { id, name, type, scope, path: targetPath };
      // description 仅对目录解析（与 Java extractDescription 一致：非目录返回 null）
      if (isDir) {
        const metadata = parseSkillMetadata(targetPath);
        if (metadata && metadata.description) skill.description = metadata.description;
      }
      imported.push(skill);
    } catch (e) {
      errors.push({ path: sourcePath, error: '复制失败: ' + (e && e.message) });
    }
  }

  result.success = errors.length === 0 || imported.length > 0;
  result.count = imported.length;
  result.total = list.length;
  result.imported = imported;
  if (errors.length > 0) result.errors = errors;
  return result;
}

/**
 * 删除技能（支持删除启用/停用态）。对齐 Java deleteSkill(name, scope, enabled, workspaceRoot)。
 * @returns {object} { success, error? }
 */
function deleteSkill(name, scope, enabled, workspaceRoot) {
  if (!isSafeSkillName(name)) {
    return { success: false, error: 'Invalid skill name: ' + name };
  }

  let dir;
  if (enabled) {
    dir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  } else {
    dir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  }
  if (!dir) {
    return { success: false, error: '无法获取 ' + scope + ' Skills 目录' };
  }

  const targetPath = path.join(dir, name);
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: 'Skill 不存在: ' + name };
  }

  try {
    const st = fs.statSync(targetPath);
    if (st.isDirectory()) {
      deleteDirectory(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: '删除失败: ' + (e && e.message) };
  }
}

/**
 * 启用技能（从管理目录移动到启用目录）。对齐 Java enableSkill。
 * @returns {object} { success, name?, scope?, enabled?, path?, error?, conflict? }
 */
function enableSkill(name, scope, workspaceRoot) {
  if (!isSafeSkillName(name)) {
    return { success: false, error: 'Invalid skill name: ' + name };
  }

  const sourceDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  const targetDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  if (!sourceDir || !targetDir) {
    return { success: false, error: '无法获取 ' + scope + ' Skills 目录' };
  }

  const source = path.join(sourceDir, name);
  const target = path.join(targetDir, name);

  if (!fs.existsSync(source)) {
    return { success: false, error: 'Skill does not exist in the management directory: ' + name };
  }
  if (fs.existsSync(target)) {
    return { success: false, error: 'A skill with the same name already exists in the active directory: ' + name, conflict: true };
  }
  if (!ensureDirectoryExists(targetDir)) {
    return { success: false, error: 'Unable to create target directory: ' + targetDir };
  }

  try {
    movePath(source, target);
    return { success: true, name, scope, enabled: true, path: target };
  } catch (e) {
    return { success: false, error: 'Move failed: ' + (e && e.message) };
  }
}

/**
 * 停用技能（从启用目录移动到管理目录）。对齐 Java disableSkill。
 * @returns {object} { success, name?, scope?, enabled?, path?, error?, conflict? }
 */
function disableSkill(name, scope, workspaceRoot) {
  if (!isSafeSkillName(name)) {
    return { success: false, error: 'Invalid skill name: ' + name };
  }

  const sourceDir = scope === 'global' ? getGlobalSkillsDir() : getLocalSkillsDir(workspaceRoot);
  const targetDir = scope === 'global' ? getGlobalManagementDir() : getLocalManagementDir(workspaceRoot);
  if (!sourceDir || !targetDir) {
    return { success: false, error: '无法获取 ' + scope + ' Skills 目录' };
  }

  const source = path.join(sourceDir, name);
  const target = path.join(targetDir, name);

  if (!fs.existsSync(source)) {
    return { success: false, error: 'Skill does not exist in the active directory: ' + name };
  }
  if (fs.existsSync(target)) {
    return { success: false, error: 'A skill with the same name already exists in the management directory: ' + name, conflict: true };
  }
  if (!ensureDirectoryExists(targetDir)) {
    return { success: false, error: 'Unable to create target directory: ' + targetDir };
  }

  try {
    movePath(source, target);
    return { success: true, name, scope, enabled: false, path: target };
  } catch (e) {
    return { success: false, error: 'Move failed: ' + (e && e.message) };
  }
}

/**
 * 切换技能启用态。currentEnabled 为当前状态：true→停用，false→启用。对齐 Java toggleSkill。
 */
function toggleSkill(name, scope, currentEnabled, workspaceRoot) {
  if (currentEnabled) {
    return disableSkill(name, scope, workspaceRoot);
  }
  return enableSkill(name, scope, workspaceRoot);
}

module.exports = {
  getAllSkills,
  getAllSkillsByScope,
  importSkills,
  deleteSkill,
  enableSkill,
  disableSkill,
  toggleSkill,
  // 导出辅助函数便于复用/测试
  getGlobalSkillsDir,
  getLocalSkillsDir,
  getGlobalManagementDir,
  getLocalManagementDir,
  parseSkillMetadata,
  javaStringHashCode,
  javaIntToHexString,
};
