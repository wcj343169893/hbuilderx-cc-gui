/**
 * mermaid 独立产物入口。
 *
 * mermaid 全家桶（mermaid + cytoscape + katex + langium 解析链）约 2.6MB，占单文件产物
 * 的 45%。MarkdownBlock 本来就是 `await import('mermaid')` 懒加载，但 vite-plugin-singlefile
 * 会强制 inlineDynamicImports，把动态 chunk 拍平进同一个 module script —— 结果是每次打开
 * 面板都要解析这 2.6MB，哪怕一张图表都没有。
 *
 * 所以把 mermaid 单独构建成一个 ESM 文件放进插件目录的 html/chunks/，
 * 首次遇到图表时经资源通道取回、用 blob URL 动态 import。
 * 构建见 webview/vite.config.mermaid.mts。
 */
export { default } from 'mermaid';
