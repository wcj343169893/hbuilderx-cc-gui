'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 插件全局状态持久化。
 *
 * HBuilderX 不支持 VSCode 的 context.globalState（见官方 AI 教程「插件配置 - 设置插件的全局状态」），
 * 推荐写到 ${hx.env.appData}/extensions/${pluginId}/pref.json。本模块即实现该约定，
 * 用于持久化 model / mode / provider 等运行时选择（重启后恢复）。
 */

const PLUGIN_ID = 'ccgui';

/** 解析 pref.json 所在目录。 */
function prefDir(hx) {
  let appData = null;
  try {
    appData = hx && hx.env && hx.env.appData ? hx.env.appData : null;
  } catch (e) { /* ignore */ }
  const base = appData
    ? path.join(appData, 'extensions', PLUGIN_ID)
    : path.join(os.homedir(), '.' + PLUGIN_ID); // appData 不可用时的兜底
  return base;
}

function prefFile(hx) {
  return path.join(prefDir(hx), 'pref.json');
}

/** 读取全部偏好（出错或不存在时返回 {}）。 */
function load(hx) {
  try {
    const raw = fs.readFileSync(prefFile(hx), 'utf-8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

/** 合并写入偏好（浅合并）。返回是否成功。 */
function save(hx, partial) {
  try {
    const dir = prefDir(hx);
    fs.mkdirSync(dir, { recursive: true });
    const current = load(hx);
    const next = { ...current, ...(partial || {}) };
    fs.writeFileSync(prefFile(hx), JSON.stringify(next, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { load, save, prefFile, prefDir, PLUGIN_ID };
