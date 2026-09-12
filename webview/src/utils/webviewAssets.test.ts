import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchWebviewAsset, fetchWebviewJsonAsset } from './webviewAssets';

/**
 * 资源通道（前端侧）单测。
 * 重点：宿主不在 / 名字非法 / 并发合并 —— 这三种情况都不能让调用方挂住，
 * 因为 mermaid 与语言包的加载都挂在它后面，挂住就表现为「图表一直 Loading」。
 */

type Outbound = { event: string; payload: Record<string, unknown> };

function installBridge(): Outbound[] {
  const sent: Outbound[] = [];
  window.sendToJava = (msg: string) => {
    const idx = msg.indexOf(':');
    const event = idx === -1 ? msg : msg.slice(0, idx);
    const raw = idx === -1 ? '{}' : msg.slice(idx + 1);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
    sent.push({ event, payload });
  };
  return sent;
}

/** 模拟宿主回传 */
function reply(requestId: string, content: string | null) {
  window.onWebviewAsset?.(JSON.stringify({ requestId, content }));
}

describe('webviewAssets', () => {
  beforeEach(() => {
    delete window.sendToJava;
    delete window.onWebviewAsset;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('桥接不存在时立刻返回 null，不等超时', async () => {
    await expect(fetchWebviewAsset('mermaid-bundle.js')).resolves.toBeNull();
  });

  it('名字非法时不发请求', async () => {
    const sent = installBridge();
    await expect(fetchWebviewAsset('../claude-chat.html')).resolves.toBeNull();
    await expect(fetchWebviewAsset('a/b.js')).resolves.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('正常取回内容', async () => {
    const sent = installBridge();
    const promise = fetchWebviewAsset('mermaid-bundle.js');
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe('get_webview_asset');
    expect(sent[0].payload.name).toBe('mermaid-bundle.js');

    reply(sent[0].payload.requestId as string, 'export default 1;');
    await expect(promise).resolves.toBe('export default 1;');
  });

  it('同名并发只向宿主请求一次', async () => {
    const sent = installBridge();
    const a = fetchWebviewAsset('locale-ja.json');
    const b = fetchWebviewAsset('locale-ja.json');
    expect(sent).toHaveLength(1);

    reply(sent[0].payload.requestId as string, '{"k":"v"}');
    expect(await a).toBe('{"k":"v"}');
    expect(await b).toBe('{"k":"v"}');
  });

  it('宿主回 null（文件缺失）时返回 null', async () => {
    const sent = installBridge();
    const promise = fetchWebviewAsset('missing.js');
    reply(sent[0].payload.requestId as string, null);
    await expect(promise).resolves.toBeNull();
  });

  it('宿主不应答时超时返回 null', async () => {
    vi.useFakeTimers();
    installBridge();
    const promise = fetchWebviewAsset('locale-ru.json');
    await vi.advanceTimersByTimeAsync(25000);
    await expect(promise).resolves.toBeNull();
  });

  it('JSON 资源解析失败时返回 null', async () => {
    const sent = installBridge();
    const promise = fetchWebviewJsonAsset('locale-fr.json');
    reply(sent[0].payload.requestId as string, 'not json');
    await expect(promise).resolves.toBeNull();
  });
});
