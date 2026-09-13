import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 两种产物模式：
 *
 * - 默认（`npm run build`）：**mermaid 外置**。mermaid 全家桶约 2.6MB，占单文件产物 45%，
 *   而 vite-plugin-singlefile 会强制 inlineDynamicImports，把 MarkdownBlock 里
 *   `await import('mermaid')` 的懒加载拍平成必加载。这里直接把 mermaid 模块替换成空壳，
 *   整包由 vite.config.mermaid.mts 单独构建到 hbuilderx-plugin/html/chunks/，
 *   运行时经资源通道下发（见 src/utils/webviewAssets.ts）。供 HBuilderX 版使用。
 *
 * - `--mode inline`（`npm run build:inline`）：上游兼容产物，mermaid 内联进单文件，
 *   给不实现资源通道的宿主（IDEA 版）使用。
 */
export default defineConfig(({ mode }) => {
  const inlineMermaid = mode === 'inline';

  return {
    plugins: [
      react(),
      ...(inlineMermaid
        ? []
        : [
            {
              // 把 mermaid 从产物中摘出去：动态 import 仍然成立，但解析到空壳模块。
              // 必须在 resolve 层拦掉 —— 只靠 define + 死代码消除不可靠，
              // rollup 在 minify 之前就会为 import('mermaid') 生成 chunk。
              name: 'ccgui-externalize-mermaid',
              enforce: 'pre' as const,
              resolveId(id: string) {
                return id === 'mermaid' ? '\0ccgui-mermaid-stub' : null;
              },
              load(id: string) {
                return id === '\0ccgui-mermaid-stub' ? 'export default null;' : null;
              },
            },
          ]),
      viteSingleFile(),
    ],
    define: {
      // MarkdownBlock 用它决定是否还存在内联兜底路径
      __CCGUI_INLINE_MERMAID__: JSON.stringify(inlineMermaid),
    },
    build: {
      minify: 'esbuild',
      esbuild: {
        drop: ['console', 'debugger'],
      },
      assetsInlineLimit: 1024 * 1024,
      cssCodeSplit: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
    },
  };
});
