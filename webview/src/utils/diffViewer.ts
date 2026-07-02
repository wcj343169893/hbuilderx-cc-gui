/**
 * DiffViewerModal 的全局触发通道。
 *
 * HBuilderX 无原生 diff 视图 API（executeCommand 不能传参、无 DiffEditor 接口），
 * 故左右对比只能在 webview 内自建。为避免把 open 函数经 props 层层透传到深层组件
 * （FileChangesList 在 StatusPanel 内、EditToolBlock 在消息列表内），仿 window.addToast
 * 的做法用一个模块级单例：DiffViewerModal 挂载时注册，任意组件调 openDiffViewer 即可弹出。
 */

import { sendBridgeEvent } from './bridge';

export interface DiffSection {
  /** 分段标题（多次编辑时区分每处改动）；单段可省略 */
  label?: string;
  before: string;
  after: string;
}

export interface DiffViewerPayload {
  title: string;
  filePath?: string;
  sections: DiffSection[];
  /**
   * 当前生效的界面主题（'light' | 'dark'），跟随「设置 → 基础配置 → 界面主题」。
   * 编辑区 diff tab 是后端独立 webview，读不到聊天 webview 的 data-theme，
   * 故由此随 payload 传过去，使其配色与界面主题一致。
   */
  theme?: 'light' | 'dark';
}

type Listener = (payload: DiffViewerPayload) => void;

let listener: Listener | null = null;

/**
 * 打开左右对比 diff。首选渲染到 HBuilderX 编辑器区（custom editor）：发 open_diff_editor 事件
 * → 后端写 .ccdiff 临时文件并 openTextDocument 打开 → CcDiffEditorProvider 在编辑区渲染左右对比 tab。
 * 若发送失败（非 HBuilderX 环境等），回退到已注册的 webview 内浮层 modal（若有）。
 */
export function openDiffViewer(payload: DiffViewerPayload): void {
  // data-theme 由 useSettingsThemeSync 依「界面主题」设置写入根节点（system 时为跟随 IDE 的结果），
  // 即当前实际生效的界面主题；带上它让编辑区 diff tab 用相同配色渲染。
  const uiTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const withTheme: DiffViewerPayload = { ...payload, theme: payload.theme ?? uiTheme };
  try {
    sendBridgeEvent('open_diff_editor', JSON.stringify(withTheme));
  } catch (e) {
    if (listener) listener(withTheme);
  }
}

/** DiffViewerModal 挂载/卸载时调用，注册/注销唯一的展示回调。 */
export function registerDiffViewer(fn: Listener | null): void {
  listener = fn;
}
