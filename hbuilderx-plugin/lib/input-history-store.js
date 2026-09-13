'use strict';

/**
 * 聊天输入历史的宿主侧镜像存储。
 *
 * 背景：前端 `webview/src/components/ChatInputBox/hooks/inputHistoryStorage.ts` 以
 * localStorage 为主存储（真正驱动上下键补全的是它），`record_input_history` /
 * `delete_input_history_item` / `clear_input_history` 只是把同样的变更「镜像」通知宿主，
 * 用于跨会话/跨窗口持久化（对齐上游 IDEA 版 `~/.codemoss/inputHistory.json`）。
 *
 * 算法与字段名对齐 `ai-bridge/services/claude/input-history-service.cjs`（同仓库已合并、
 * 但只服务于独立 Node 进程调用场景，未接入 daemon 的 request/response 协议，本插件宿主
 * 与前端同源同进程、无需经 daemon 往返，故直接在本文件重实现同一份逻辑）。
 * 存储位置沿用 `prefs.js` 的 `${hx.env.appData}/extensions/ccgui/` 目录约定，
 * 与 pref.json 分开存放（避免频繁的历史读写膨胀/污染 model/mode 等核心偏好文件）。
 */

const fs = require('fs');
const path = require('path');
const prefsDir = require('./prefs').prefDir;

/** 历史条目 / 计数记录的上限，对齐前端 MAX_HISTORY_ITEMS / MAX_COUNT_RECORDS。 */
const MAX_HISTORY_ITEMS = 200;
const MAX_COUNT_RECORDS = 200;

function historyFile(hx) {
  return path.join(prefsDir(hx), 'inputHistory.json');
}

/** 读取历史数据文件（出错或不存在时返回空结构，不抛异常）。 */
function readHistoryFile(hx) {
  try {
    const raw = fs.readFileSync(historyFile(hx), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      counts: parsed && typeof parsed.counts === 'object' && parsed.counts !== null ? parsed.counts : {},
    };
  } catch (e) {
    return { items: [], counts: {} };
  }
}

function writeHistoryFile(hx, data) {
  const dir = prefsDir(hx);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(historyFile(hx), JSON.stringify(data, null, 2), 'utf-8');
}

/** 计数记录超限时只保留使用次数最多的 MAX_COUNT_RECORDS 条。 */
function cleanupCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_COUNT_RECORDS) return counts;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_COUNT_RECORDS));
}

/**
 * 记录历史片段（对应 `record_input_history`，payload 为字符串数组）。
 * 去重后追加到末尾，超限裁掉最旧的。fire-and-forget：调用方不等待返回值，出错只记日志。
 */
function record(hx, fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) return;
  const { items, counts } = readHistoryFile(hx);
  let nextCounts = counts;
  for (const fragment of fragments) {
    if (typeof fragment !== 'string' || !fragment) continue;
    nextCounts[fragment] = (nextCounts[fragment] || 0) + 1;
  }
  nextCounts = cleanupCounts(nextCounts);
  const incoming = new Set(fragments.filter((f) => typeof f === 'string' && f));
  const kept = items.filter((item) => !incoming.has(item));
  const nextItems = [...kept, ...fragments].slice(-MAX_HISTORY_ITEMS);
  writeHistoryFile(hx, { items: nextItems, counts: nextCounts });
}

/** 删除单条历史（对应 `delete_input_history_item`，payload 为该条文本）。 */
function deleteItem(hx, item) {
  if (typeof item !== 'string' || !item) return;
  const { items, counts } = readHistoryFile(hx);
  const nextItems = items.filter((i) => i !== item);
  const nextCounts = { ...counts };
  delete nextCounts[item];
  writeHistoryFile(hx, { items: nextItems, counts: nextCounts });
}

/** 清空全部历史（对应 `clear_input_history`）。 */
function clearAll(hx) {
  writeHistoryFile(hx, { items: [], counts: {} });
}

module.exports = { record, deleteItem, clearAll, MAX_HISTORY_ITEMS };
