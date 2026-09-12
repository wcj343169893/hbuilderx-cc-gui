'use strict';

/**
 * 资源通道（宿主侧）。
 *
 * HBuilderX 的 webview 只接受 HTML 字符串，注入文档没有基准 URL，相对路径资源无从解析，
 * 所以前端产物必须是单文件。为避免大块资源（mermaid 整包约 2.6MB、非内置语言包）
 * 常驻在那个单文件里，它们被构建到本插件目录的 `html/chunks/`，由前端按需索取、
 * 宿主读盘后经桥接以字符串下发。
 *
 * 对应前端：webview/src/utils/webviewAssets.ts
 * 对应事件：get_webview_asset -> callJs('onWebviewAsset', json)
 */

const fs = require('fs');
const path = require('path');

const CHUNKS_DIR = path.join(__dirname, '..', 'html', 'chunks');

/** 只允许简单文件名：禁目录分隔符、禁 `..`、禁控制字符。 */
const NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 允许的后缀白名单 —— 资源通道只用来下发 js / json，不是通用读文件接口。 */
const ALLOWED_EXTENSIONS = new Set(['.js', '.json']);

/** 单个资源上限：mermaid 整包约 2.6MB，留足余量同时挡住误放的大文件。 */
const MAX_ASSET_BYTES = 16 * 1024 * 1024;

/**
 * 读取一个 chunk 资源。
 * @param {string} name 资源文件名（非路径）
 * @returns {{ content: string } | { error: string }}
 */
function readWebviewAsset(name) {
  if (typeof name !== 'string' || !NAME_REGEX.test(name)) {
    return { error: 'invalid asset name' };
  }
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { error: 'asset type not allowed' };
  }

  const filePath = path.join(CHUNKS_DIR, name);
  // 双保险：即使正则被绕过，也不允许逃出 chunks 目录
  if (path.dirname(path.resolve(filePath)) !== path.resolve(CHUNKS_DIR)) {
    return { error: 'asset path escapes chunks dir' };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return { error: 'asset not found' };
  }
  if (!stat.isFile()) {
    return { error: 'asset not a file' };
  }
  if (stat.size > MAX_ASSET_BYTES) {
    return { error: 'asset too large' };
  }

  try {
    return { content: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    return { error: 'asset read failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/** chunks 目录是否就位（bundle 校验与启动自检用）。 */
function chunksDirExists() {
  try {
    return fs.statSync(CHUNKS_DIR).isDirectory();
  } catch (e) {
    return false;
  }
}

module.exports = { readWebviewAsset, chunksDirExists, CHUNKS_DIR, MAX_ASSET_BYTES };
