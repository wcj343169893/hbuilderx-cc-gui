/**
 * 插件相关公共方法
 */
const fs = require('fs');
const path = require('path');

/**
 * 插件列表 markdown 文件的下载地址
 */
const PLUGIN_LIST_MD_URL = "https://update.liuyingyong.cn/hbuilderx/marketplace/plugin-list-for-ai.md"
const PLUGIN_LIST_FILE_PATH = path.join(__dirname, '..', 'plugins-list.md');

/**
 * 获取插件列表
 * 先检查 plugins-list.md 文件，若不存在或者修改时间超过1小时，则下载更新该文件
 * 文件保存路径: common/plugins-list.md
 */
async function getPluginList() {
  let needDownload = false;

  // 检查文件是否存在
  if (fs.existsSync(PLUGIN_LIST_FILE_PATH)) {
    // 检查修改时间是否超过1小时
    const stats = fs.statSync(PLUGIN_LIST_FILE_PATH);
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    if (now - stats.mtimeMs > oneDay) {
      needDownload = true;
    }
  } else {
    needDownload = true;
  }

  let content = '';
  // 下载文件
  if (needDownload) {
    const response = await fetch(PLUGIN_LIST_MD_URL);
    if (!response.ok) {
      throw new Error(`Failed to download plugin list: ${response.status}`);
    }
    content = await response.text();
    fs.writeFileSync(PLUGIN_LIST_FILE_PATH, content, 'utf-8');
  }else{
    content = fs.readFileSync(PLUGIN_LIST_FILE_PATH, 'utf-8');
  }

  return content;
}

module.exports = {
  getPluginList,
};