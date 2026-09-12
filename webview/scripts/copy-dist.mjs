import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const distFile = path.resolve(cwd, 'dist/index.html');

// 默认产物（mermaid 外置）只给 HBuilderX 插件用：它实现了资源通道，会按需下发
// html/chunks/mermaid-bundle.js。IDEA 版宿主不实现该事件，拿到外置产物会丢图表渲染，
// 所以只有上游兼容产物（npm run build:inline）才同步给 src/main/resources。
const HBX_TARGET = path.resolve(cwd, '../hbuilderx-plugin/html/claude-chat.html');
const IDEA_TARGET = path.resolve(cwd, '../src/main/resources/html/claude-chat.html');

const hbxOnly = process.argv.includes('--hbx-only');
const targetFiles = hbxOnly ? [HBX_TARGET] : [IDEA_TARGET, HBX_TARGET];

const main = async () => {
  const html = await readFile(distFile, 'utf-8');
  for (const targetFile of targetFiles) {
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, html, 'utf-8');
    console.log(`[copy-dist] 已同步 ${distFile} -> ${targetFile}`);
  }
  const sizeMb = (Buffer.byteLength(html, 'utf8') / 1048576).toFixed(2);
  console.log(`[copy-dist] 产物体积 ${sizeMb} MB${hbxOnly ? '（mermaid 外置）' : '（含内联 mermaid）'}`);
};

main().catch((error) => {
  console.error('[copy-dist] 复制构建产物失败', error);
  process.exit(1);
});
