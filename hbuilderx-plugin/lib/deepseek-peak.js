'use strict';

/**
 * DeepSeek 峰谷定价辅助（纯逻辑，无 hbuilderx 依赖，便于 node --check 与单测）。
 *
 * 背景（官方提示）：DeepSeek API 服务预计 7 月中旬起采用峰谷定价，高峰时段价格为平时 2 倍，
 * 适用所有计费项。高峰时段（北京时间）：每日 09:00～12:00 与 14:00～18:00。
 *
 * 用途：识别当前是否在用 DeepSeek、当前是否处于高峰、下一次转平价的时刻，以及对外提示文案。
 * 决策/队列/调度由 message-router 承接（需要 hbuilderx 弹窗与发送能力）。
 */

/** 官方涨价提示原文（展示给用户）。 */
const PEAK_NOTICE =
  'DeepSeek API 服务预计7月中旬开始采用峰谷定价策略，高峰时段价格为平时价格2倍，适用所有计费项。'
  + '【高峰时段定义：北京时间每日9:00～12:00 和 14:00～18:00】';

/** 给开发者的省钱建议（配合高峰弹窗展示）。 */
const PEAK_ADVICE =
  '建议：高峰时段先让 AI 制定开发计划，平价时段再按计划分批自动执行，可显著降低费用。';

// 高峰时段（以「北京时间当日分钟数」表示的左闭右开区间）：09:00-12:00、14:00-18:00。
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

/** 把某时刻换算为「北京时间(UTC+8)当日分钟数」（0~1439），与宿主本地时区无关。 */
function beijingMinutesOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  // epoch 毫秒本就是 UTC；+8h 后用 getUTC* 即得北京墙钟。
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}

/** 当前（或给定时刻）是否处于 DeepSeek 高峰时段。 */
function isPeakAt(date = new Date()) {
  const m = beijingMinutesOfDay(date);
  return PEAK_WINDOWS.some(([a, b]) => m >= a && m < b);
}

/**
 * 返回「本次高峰结束、恢复平价」的时刻（Date）。若当前已是平价，返回传入时刻本身。
 * 仅用于给用户提示「约 HH:MM 恢复平价」。
 */
function nextOffPeakAt(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const m = beijingMinutesOfDay(d);
  for (const [a, b] of PEAK_WINDOWS) {
    if (m >= a && m < b) {
      return new Date(d.getTime() + (b - m) * 60 * 1000);
    }
  }
  return d;
}

/** 把某时刻格式化为北京时间 HH:MM（用于提示文案）。 */
function beijingHHMM(date = new Date()) {
  const total = beijingMinutesOfDay(date);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 依据 provider 名称 / baseUrl / 模型名判断是否在用 DeepSeek（大小写不敏感，含 'deepseek' 即算）。
 * @param {{ name?: string, baseUrl?: string, model?: string }} info
 */
function isDeepSeek(info = {}) {
  return [info.name, info.baseUrl, info.model]
    .map((x) => String(x == null ? '' : x).toLowerCase())
    .some((s) => s.includes('deepseek'));
}

// 任务难度关键词（大小写不敏感、含即命中）。命中「难」优先于「易」；都不命中或数量相当则「中」。
const HARD_KEYWORDS = [
  '重构', '架构', '设计模式', '迁移', '并发', '并行', '性能优化', '优化性能', '算法', '复杂',
  '多模块', '分布式', '系统级', '底层', '内核', '编译器', '协议', '安全', '加密', '排查', '定位问题',
  'refactor', 'architecture', 'migrate', 'migration', 'concurren', 'performance', 'algorithm',
  'security', 'encrypt', 'debug', 'root cause', 'race condition', 'optimi',
];
const EASY_KEYWORDS = [
  '改文案', '改文字', '文案', '错别字', '拼写', '重命名', '改名', '注释', '格式化', '缩进',
  '小改', '微调', '调整样式', '改颜色', '改个', '换个', '删掉', '加个',
  'typo', 'rename', 'comment', 'format', 'indent', 'wording', 'copy change',
];

/**
 * 依据任务文本粗略判断难度：'easy' | 'medium' | 'hard'。
 * 纯启发式（关键词 + 文本长度），用于「平价时段按难度自动选模型」。刻意保守：证据不足时回 'medium'。
 * @param {string} text
 */
function classifyDifficulty(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s.trim()) return 'medium';
  const hard = HARD_KEYWORDS.filter((k) => s.includes(k)).length;
  const easy = EASY_KEYWORDS.filter((k) => s.includes(k)).length;
  const longText = s.length >= 400; // 很长的需求通常更复杂

  if (hard > easy) return 'hard';
  if (easy > hard && !longText) return 'easy';
  if (longText && hard >= easy) return 'hard';
  return 'medium';
}

module.exports = {
  PEAK_NOTICE,
  PEAK_ADVICE,
  PEAK_WINDOWS,
  beijingMinutesOfDay,
  isPeakAt,
  nextOffPeakAt,
  beijingHHMM,
  isDeepSeek,
  classifyDifficulty,
};
