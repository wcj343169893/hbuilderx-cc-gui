'use strict';

/**
 * 宿主侧桥接：承接 HBuilderX webview 的双向消息通道，复刻 IDEA 版
 * ClaudeChatWindow.handleJavaScriptMessage（出站解析）与 callJavaScript（入站下发）。
 *
 * - 出站（webview -> 宿主）：webview 发来 { __ch:'toHost', payload:"event:content" }，
 *   按首个冒号切分为 (event, content)，交给已注册的 dispatch 处理。
 * - 入站（宿主 -> webview）：callJs(fn, ...args) -> webview.postMessage({ __ch:'callJs', fn, args })，
 *   webview 内的 shim 会调用 window[fn](...args)。
 */
class BridgeHost {
  /**
   * @param {object} webview HBuilderX WebView 对象（webviewPanel.webView）
   * @param {{ appendLine: (s: string) => void }} [output] OutputChannel，用于日志
   */
  constructor(webview, output) {
    this.webview = webview;
    this.output = output || { appendLine() {} };
    /** @type {(event: string, content: string) => void} */
    this._dispatch = (event, content) => {
      this.output.appendLine(`[bridge] 未处理事件: ${event} (${(content || '').slice(0, 120)})`);
    };

    if (webview && typeof webview.onDidReceiveMessage === 'function') {
      webview.onDidReceiveMessage((msg) => this._handleIncoming(msg));
    }
  }

  /** 注册出站事件分发器（通常是 MessageRouter.dispatch）。 */
  onEvent(dispatch) {
    if (typeof dispatch === 'function') {
      this._dispatch = dispatch;
    }
    return this;
  }

  _handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.__ch === 'console') {
      this.output.appendLine(`[webview:${msg.level || 'log'}] ${msg.text || ''}`);
      return;
    }
    if (msg.__ch === 'toHost') {
      const payload = typeof msg.payload === 'string' ? msg.payload : '';
      const idx = payload.indexOf(':');
      const event = idx === -1 ? payload : payload.slice(0, idx);
      const content = idx === -1 ? '' : payload.slice(idx + 1);
      try {
        this._dispatch(event, content);
      } catch (err) {
        this.output.appendLine(`[bridge] dispatch 异常: ${err && err.message}`);
      }
    }
  }

  /**
   * 调用前端 window[fn](...args)，等价于 IDEA 的 callJavaScript。
   * @param {string} fn 前端 window 上的回调函数名
   * @param {...any} args 透传参数（应可被 JSON 化）
   */
  callJs(fn, ...args) {
    if (!this.webview || typeof this.webview.postMessage !== 'function') return;
    try {
      this.webview.postMessage({ __ch: 'callJs', fn, args });
    } catch (err) {
      this.output.appendLine(`[bridge] callJs(${fn}) 失败: ${err && err.message}`);
    }
  }
}

module.exports = { BridgeHost };
