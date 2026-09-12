/**
 * 资源通道：把「宿主磁盘上的文件」按需取进 webview。
 *
 * 背景：HBuilderX 的 webview 只接受 HTML 字符串（`webview.html = '<html>…'`），
 * 注入的文档没有基准 URL，相对路径资源无法解析 —— 这就是产物必须打成单文件的根因。
 * 于是大块资源（mermaid 整包 2.6MB、非内置语言包）不再进构建产物，改为放在插件目录的
 * `html/chunks/`，运行时由宿主读盘、经桥接以字符串下发，前端再用 blob URL 动态 import。
 *
 * 这条通道不依赖任何平台特性（不需要 file:// / asWebviewUri / 本地 http），
 * 在 IDEA 版（宿主未实现该事件）上会超时返回 null，调用方各自降级即可。
 */
import { sendToJava } from './bridge';

/** 资源名白名单：只允许简单文件名，禁止路径分隔符与上跳，宿主侧还会再校验一次。 */
const ASSET_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 宿主不在（IDEA 版）或事件未实现时，不应让调用方永久挂起。 */
const ASSET_TIMEOUT_MS = 20000;

interface PendingAsset {
  resolve: (content: string | null) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingAsset>();
/** 同名资源的并发请求合并为一次宿主往返（mermaid 整包可能被多条消息同时触发）。 */
const inflight = new Map<string, Promise<string | null>>();
let requestSeq = 0;
/**
 * 已安装的回调引用：用它判断是否需要（重新）安装，而不是一个一次性布尔标记 ——
 * 若别处覆盖了 window.onWebviewAsset，下一次请求会重新挂上，不至于静默失联。
 */
let installedHandler: ((json: string) => void) | null = null;

function settle(requestId: string, content: string | null) {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timeoutId);
  pending.delete(requestId);
  entry.resolve(content);
}

function installHandler() {
  if (installedHandler && window.onWebviewAsset === installedHandler) return;

  // 链上别人的回调（若有且不是我们自己的），避免覆盖
  const previous = window.onWebviewAsset === installedHandler ? undefined : window.onWebviewAsset;
  const handler = (json: string) => {
    if (previous) {
      try {
        previous(json);
      } catch {
        // 旧回调出错不影响本次解析
      }
    }
    try {
      const data = JSON.parse(json) as { requestId?: string; content?: string | null };
      if (!data.requestId) return;
      settle(data.requestId, typeof data.content === 'string' ? data.content : null);
    } catch {
      // 宿主返回非法 JSON：当作取不到，交给超时/降级
    }
  };

  installedHandler = handler;
  window.onWebviewAsset = handler;
}

/**
 * 向宿主索取一个资源文件的文本内容。
 * @returns 文件内容；宿主没实现、文件不存在或超时时为 null（调用方负责降级）
 */
export function fetchWebviewAsset(name: string): Promise<string | null> {
  if (!ASSET_NAME_REGEX.test(name)) {
    return Promise.resolve(null);
  }
  const existing = inflight.get(name);
  if (existing) return existing;

  installHandler();

  const requestId = `asset-${++requestSeq}-${Date.now()}`;
  const promise = new Promise<string | null>((resolve) => {
    // 桥接不存在（单元测试 / 纯浏览器预览）时立即判定取不到，不必等超时
    if (typeof window.sendToJava !== 'function') {
      resolve(null);
      return;
    }
    const timeoutId = setTimeout(() => settle(requestId, null), ASSET_TIMEOUT_MS);
    pending.set(requestId, { resolve, timeoutId });
    sendToJava('get_webview_asset', { requestId, name });
  }).finally(() => {
    inflight.delete(name);
  });

  inflight.set(name, promise);
  return promise;
}

/**
 * 把一段 ESM 源码变成可用模块（blob URL + 动态 import）。
 * 失败（CSP 拦截、blob 不可用、语法错误）时返回 null。
 */
export async function importModuleFromSource(source: string): Promise<Record<string, unknown> | null> {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    return mod;
  } catch {
    return null;
  } finally {
    if (url) {
      // import 完成后 blob 已被解析，立即回收避免常驻占用内存
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 忽略回收失败
      }
    }
  }
}

/** 取一个 JSON 资源并解析；任何环节失败都返回 null。 */
export async function fetchWebviewJsonAsset<T>(name: string): Promise<T | null> {
  const text = await fetchWebviewAsset(name);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
