'use strict';

/**
 * 敏感配置文件的安全写入（B1 / 上游 v0.4.6 安全加固组）。
 *
 * 背景：宿主会把 provider API Key（`~/.codemoss/config.json`）与 MCP 服务器定义
 * （`~/.claude.json`，其 env 段常放 token）写到用户主目录。默认 umask 下这些文件是
 * 0644——同机其它用户可读。上游在 Java 侧用 `Files.setPosixFilePermissions` 收紧到
 * `rw-------`，这里是对应的 JS 实现。
 *
 * Windows 上 POSIX 位无意义：`fs.chmod` 只会去动只读位，因此直接跳过（与上游
 * 用 PosixFilePermissions 前先判平台的做法一致），不报错、不影响写入本身。
 */

const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const isPosix = process.platform !== 'win32';

/**
 * 确保目录存在，并在 POSIX 上收紧到 0700。
 * @param {string} dir
 */
function ensureSecureDir(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true, mode: isPosix ? DIR_MODE : undefined });
  if (!isPosix) return;
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch (e) {
    // 目录可能是用户自建且属主不是当前进程（少见）。收紧失败不该阻断写入。
  }
}

/**
 * 把 JSON 写入敏感配置文件，并把权限收紧到 0600。
 *
 * 先按 0600 创建再写入（而不是写完再 chmod）：避免「文件已存在且内容已落盘、
 * 但权限还没收紧」的时间窗。对已存在的文件 `fs.writeFileSync` 的 mode 不生效，
 * 所以写完仍显式 chmod 一次兜底。
 *
 * @param {string} file 目标文件绝对路径
 * @param {any} value 要序列化的对象
 * @param {{ pretty?: boolean }} [opts] pretty 为 true 时按 2 空格缩进
 */
function writeJsonSecure(file, value, opts) {
  const pretty = !opts || opts.pretty !== false;
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  ensureSecureDir(path.dirname(file));
  fs.writeFileSync(file, text, { encoding: 'utf-8', mode: isPosix ? FILE_MODE : undefined });
  if (!isPosix) return;
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch (e) {
    // 同上：属主不符时收紧失败，写入本身已成功，不向上抛。
  }
}

module.exports = { writeJsonSecure, ensureSecureDir, FILE_MODE, DIR_MODE };
