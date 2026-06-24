---
name: uniappx-layout
description: >
  Guides layout implementation in uni-app x using the native Flexbox engine.
  Covers critical CSS differences from web (column default, no block/inline,
  class-only selectors, explicit CSS reset defaults, no style inheritance),
  supported units (px, rpx, %), positioning (relative/absolute/fixed, no
  sticky), and style isolation.
  Use this skill when questions involve CSS layout, styling, flex properties,
  selectors, units, positioning, or cross-platform style consistency in
  uni-app x.
project: uniappx
---

# uni-app x Layout System

## Overview

uni-app x 在 App 端使用 CSS 子集（Flexbox-only），与 W3C 标准有显著差异。回答前必须先阅读 References 中最相关的文档，以文档内容为准。

## Instructions

1. 判断用户问题属于哪个子主题：
   - display 与 flex 布局
   - 选择器支持范围
   - 长度单位（px、rpx、%）
   - 定位（relative、absolute、fixed）
   - CSS 变量
   - at-rules（@font-face、@import）
   - 样式隔离

2. 根据子主题阅读最相关的 References：
   - CSS 总览 / 默认值差异 / CSS reset → 读 README.md
   - display → 读 display.md
   - flex 布局 → 读 flex-direction.md
   - 定位 → 读 position.md
   - 单位 → 读 common/length.md
   - 选择器 → 读 common/selector.md
   - CSS 变量 → 读 common/variable.md
   - at-rules → 读 common/at-rules.md
   - 样式隔离 → 读 common/style-isolation.md

3. 稳定决策规则：
   - 先明确告知：uni-app x 有一套显式的 CSS reset，很多默认值和 W3C 不同，不能直接按浏览器默认行为推断
   - App 端仅支持 flex 和 none，无 block/inline/grid
   - box-sizing 默认 border-box（不是 content-box）
   - display 默认 flex（不是 inline）
   - flex 默认 none（不是 initial）
   - flex-direction 默认 column（不是 row）
   - flex-shrink 默认 0（不是 1）
   - position 默认 relative（不是 static）
   - overflow 默认 hidden（不是 visible）
   - min-width / min-height 默认 0px（不是 auto）
   - align-content / align-items 默认 stretch（不是 normal）
   - justify-content 默认 flex-start（不是 normal）
   - color 默认 #000000（App）而不是 canvastext
   - font-size 默认 16px（不是 medium）
   - letter-spacing 默认 0（不是 normal）
   - text-align 默认 left（不是 start）
   - white-space 默认 keep（App）/ pre-line（Web）而不是 normal
   - transform-origin 默认 50% 50%（App）而不是 50% 50% 0
   - z-index 默认 0（App）而不是 auto
   - 无样式继承：父组件样式不会影响子组件，文字样式必须直接写在 `<text>` 上
   - 仅支持 class 选择器为主，不支持 *、tag、#id、[attr]、:pseudo-class
   - 不支持 sticky，用 `<sticky>` 组件替代
   - 不支持 calc()、rem、vh、vw
   - 页面默认不可滚动，需包裹 scroll-view

4. 当用户问“哪些默认值不一样”时，优先按 README.md 的 CSS reset 表格逐项回答，不要自己删减成模糊概括；至少要覆盖：`align-content`、`align-items`、`box-sizing`、`display`、`flex`、`flex-direction`、`flex-shrink`、`font-size`、`justify-content`、`letter-spacing`、`min-height`、`min-width`、`overflow`、`position`、`text-align`、`white-space`、`z-index`。

5. 当用户问“为什么这个布局和 Web 不一样”时，优先从 CSS reset 默认值差异排查，尤其先检查：`display`、`flex-direction`、`box-sizing`、`position`、`overflow`、`min-width`、`min-height`、`flex-shrink`。

6. 回答时先给结论，再给最小代码示例，并注明依据的参考文档路径；如果涉及默认值差异，要直接列出与 W3C 不同的默认值，不要只笼统说“有差异”。

7. 如果参考文档未覆盖用户的具体问题，明确说明而非猜测。

## Constraints

- 不要仅凭记忆回答具体 CSS 属性支持情况，必须查阅 References 确认。
- 涉及平台差异时（App vs Web），必须先查对应文档再回答。
- 如果 References 之间存在冲突，以更具体、更直接相关的文档为准。

## References
- CSS 概述: {knowledges_base_dir}/uni-app-x/docs/css/README.md
- display: {knowledges_base_dir}/uni-app-x/docs/css/display.md
- flex-direction: {knowledges_base_dir}/uni-app-x/docs/css/flex-direction.md
- position: {knowledges_base_dir}/uni-app-x/docs/css/position.md
- 长度单位: {knowledges_base_dir}/uni-app-x/docs/css/common/length.md
- 选择器: {knowledges_base_dir}/uni-app-x/docs/css/common/selector.md
- CSS 变量: {knowledges_base_dir}/uni-app-x/docs/css/common/variable.md
- at-rules: {knowledges_base_dir}/uni-app-x/docs/css/common/at-rules.md
- 样式隔离: {knowledges_base_dir}/uni-app-x/docs/css/common/style-isolation.md
