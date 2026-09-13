import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * 把 mermaid 打成**一个自包含 ESM 文件**，供宿主经资源通道下发、前端 blob import。
 *
 * `inlineDynamicImports` 是必需的：mermaid 内部按图表类型做了大量动态 import
 * （flowDiagram / ganttDiagram / cytoscape / katex …）。若保留这些 chunk，blob URL
 * 没有可解析的基准地址，运行时去取相对路径会直接失败 —— 必须全部内联进同一个文件。
 *
 * 产物先落在 dist-mermaid/，再由 scripts/emit-chunks.mjs 拷进
 * hbuilderx-plugin/html/chunks/，避免把带 hash 的中间产物残留在插件目录。
 */
export default defineConfig({
  build: {
    outDir: 'dist-mermaid',
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/mermaid-bundle.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'mermaid-bundle.js',
      },
    },
  },
  esbuild: { drop: ['console', 'debugger'] },
});
