import { mkdir, copyFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * 组装资源通道的 chunks 目录：hbuilderx-plugin/html/chunks/
 *
 * 放两类东西：
 *   1. mermaid-bundle.js —— 自包含的 mermaid 整包（vite.config.mermaid.mts 产出）
 *   2. locale-<lng>.json —— 未内置的语言包（内置的 zh / zh-TW / en 静态打进产物）
 *
 * 目录里只允许出现这些文件：其余一概清掉，防止改名/换版本后残留旧 chunk 被宿主读到。
 * LAZY_LANGUAGES 必须与 src/i18n/config.ts 的同名常量一致。
 */
const LAZY_LANGUAGES = ['hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'];
const MERMAID_BUNDLE = 'mermaid-bundle.js';

const cwd = process.cwd();
const localesDir = path.resolve(cwd, 'src/i18n/locales');
const mermaidDist = path.resolve(cwd, 'dist-mermaid', MERMAID_BUNDLE);
const chunksDir = path.resolve(cwd, '../hbuilderx-plugin/html/chunks');

const main = async () => {
  await mkdir(chunksDir, { recursive: true });

  const expected = new Set([MERMAID_BUNDLE, ...LAZY_LANGUAGES.map((l) => `locale-${l}.json`)]);

  // 清掉不该在的文件（旧 hash chunk、已下线的语言包等）
  for (const name of await readdir(chunksDir)) {
    if (!expected.has(name)) {
      await rm(path.join(chunksDir, name), { recursive: true, force: true });
      console.log(`[emit-chunks] 清理残留 ${name}`);
    }
  }

  await copyFile(mermaidDist, path.join(chunksDir, MERMAID_BUNDLE));
  const mermaidSize = (await stat(path.join(chunksDir, MERMAID_BUNDLE))).size;

  for (const lng of LAZY_LANGUAGES) {
    await copyFile(path.join(localesDir, `${lng}.json`), path.join(chunksDir, `locale-${lng}.json`));
  }

  console.log(
    `[emit-chunks] ${MERMAID_BUNDLE} ${(mermaidSize / 1048576).toFixed(2)} MB + ` +
    `${LAZY_LANGUAGES.length} 个按需语言包 -> ${chunksDir}`
  );
};

main().catch((error) => {
  console.error('[emit-chunks] 失败（mermaid 整包是否已构建？先跑 npm run build:chunks）', error);
  process.exit(1);
});
