'use strict';

/**
 * 把 HBuilderX 官方 uni-agent 的 skills 与 common/scripts「收纳」进本插件仓库，
 * 供运行时 lib/uni-agent-skills-installer.js 转换后预置给用户。
 *
 * 只收纳 **skill 定义 + common 脚本**（体积小、需要我们控制/转换）；
 * 33MB 的 knowledges 知识库 **不收纳**，运行时改为引用用户机器上已安装的 HBuilderX
 * （见 installer 的 {knowledges_base_dir} 替换）。
 *
 * 用法：
 *   node scripts/vendor-uni-agent-skills.js [--from <uni-agent 目录>]
 * 缺省 --from 时按常见安装路径探测 HBuilderX 下的 uni-agent。
 *
 * 产物布局（hbuilderx-plugin/uni-agent-skills/）：
 *   skills/<skill>/...        —— 原样拷贝（保留 {xxx} 占位符，转换在运行时做）
 *   common/scripts/*.js       —— 被 skill 内 .js require 的共享脚本
 */

const fs = require('fs');
const path = require('path');

const pluginRoot = path.join(__dirname, '..');
const destRoot = path.join(pluginRoot, 'uni-agent-skills');

/** 解析 --from 参数；缺省时按平台常见路径探测 HBuilderX/.../uni-agent。 */
function resolveSourceUniAgentDir() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--from');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];

  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\HBuilderX', 'D:\\HBuilderX', 'C:\\HBuilderX']) {
      candidates.push(path.join(base, 'plugins', 'hbuilderx-ai-chat', 'uni-agent'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/HBuilderX.app/Contents/HBuilderX/plugins/hbuilderx-ai-chat/uni-agent');
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'skills'))) return c;
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const srcUniAgent = resolveSourceUniAgentDir();
  if (!srcUniAgent || !fs.existsSync(path.join(srcUniAgent, 'skills'))) {
    console.error('[vendor] ✗ 未找到 HBuilderX uni-agent 源目录。请用 --from 指定，例如：');
    console.error('  node scripts/vendor-uni-agent-skills.js --from "D:\\HBuilderX\\plugins\\hbuilderx-ai-chat\\uni-agent"');
    process.exit(1);
  }

  const srcSkills = path.join(srcUniAgent, 'skills');
  const srcCommonScripts = path.join(srcUniAgent, 'common', 'scripts');

  console.log(`[vendor] 源: ${srcUniAgent}`);
  fs.rmSync(destRoot, { recursive: true, force: true });

  // 1) skills/
  copyDir(srcSkills, path.join(destRoot, 'skills'));
  const skillCount = fs.readdirSync(path.join(destRoot, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).length;
  console.log(`[vendor] ✓ 收纳 skills: ${skillCount} 个`);

  // 2) common/scripts/
  if (fs.existsSync(srcCommonScripts)) {
    copyDir(srcCommonScripts, path.join(destRoot, 'common', 'scripts'));
    const n = fs.readdirSync(path.join(destRoot, 'common', 'scripts')).filter((f) => f.endsWith('.js')).length;
    console.log(`[vendor] ✓ 收纳 common/scripts: ${n} 个脚本`);
  } else {
    console.warn(`[vendor] ! 未找到 common/scripts: ${srcCommonScripts}`);
  }

  console.log(`[vendor] ✅ 已写入 ${path.relative(pluginRoot, destRoot)}（knowledges 知识库不收纳，运行时引用已装 HBuilderX）`);
}

main();
