import { spawn as spawnProcess } from 'node:child_process';
import { AsyncStream } from '../../utils/async-stream.js';
import { loadClaudeSdk } from '../../utils/sdk-loader.js';
import { createPreToolUseHook, normalizePermissionMode } from './permission-mode.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes as cleanupAnonymousFromRegistry,
  cleanupStaleSessionRuntimes as cleanupSessionsFromRegistry,
  clearActiveTurnRuntimeIf,
  endRuntimeTurn,
  findRuntimeForRequest,
  rememberRuntime,
  promoteRuntimeToSession,
  removeRuntime,
  touchRuntime
} from './runtime-registry.js';

let cachedQueryFn = null;

export function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch) {
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled,
    runtimeSessionEpoch: runtimeSessionEpoch || '',
    model: options.model || '',
    effort: options.effort || '',
    // permissionMode 一般可用 setPermissionMode 动态切换，故不入签名；唯独 bypassPermissions
    // 依赖 spawn 时的 --allow-dangerously-skip-permissions 标志（无法事后补），所以把该标志
    // 纳入签名：进/出「自动模式」时签名变化 → 重建 runtime，确保 spawn 标志与当前模式一致。
    allowDangerouslySkipPermissions: !!options.allowDangerouslySkipPermissions
  };
  return JSON.stringify(material);
}

async function ensureQueryFn() {
  if (cachedQueryFn) return cachedQueryFn;
  const sdk = await loadClaudeSdk();
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  cachedQueryFn = queryFn;
  return cachedQueryFn;
}

export function setCachedQueryFn(queryFn) {
  cachedQueryFn = queryFn;
}

export function resetCachedQueryFn() {
  cachedQueryFn = null;
}

export function registerRuntimeSession(runtime, sessionId, callbacks) {
  promoteRuntimeToSession(runtime, sessionId, callbacks);
}

/**
 * 兜底清理：按进程树强杀 Claude CLI 子进程及其全部后代。
 *
 * 中断一轮时，query.interrupt()/close() 只停止 SDK 那一轮并终结 CLI 进程本身，
 * 但 CLI 通过 Bash 工具派生出来的孙进程（如 `node tests/e2e/*.mjs`、playwright/
 * chromium 浏览器）不会被连带回收，会变成孤儿进程常驻后台（曾观察到单次中断遗留
 * 16 个进程、~1.6GB）。这里在中断触发的 dispose 里按 pid 终结整棵树来兜底。
 *
 * 仅在「中断」路径调用（见 disposeRuntime 的 abortRequested 判定）；正常空闲回收时
 * CLI 会随优雅退出自行带走子进程，无需强杀。
 */
export function killProcessTree(pid) {
  if (!pid || !Number.isInteger(pid)) return;
  try {
    if (process.platform === 'win32') {
      // /T 连带终结整棵进程树（含 Bash→node→playwright 等孙进程），/F 强制。
      const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => { /* taskkill 不存在/进程已退出：忽略 */ });
    } else {
      // POSIX 兜底：尽力而为直接杀该进程（不保证整树；本项目主用 Windows）。
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* 已退出 */ }
    }
  } catch (_) { /* best-effort，绝不因清理失败而抛出 */ }
}

export async function disposeRuntime(runtime, callbacks) {
  if (!runtime || runtime.closed) return;
  console.log('[LIFECYCLE] disposeRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + (runtime.runtimeSignature || '(none)'));
  runtime.closed = true;
  runtime.activeTurnCount = 0;

  try {
    runtime.inputStream.done();
  } catch (err) {
    console.error('[LIFECYCLE] inputStream.done() failed:', err?.message || err);
  }

  try {
    runtime.query?.close?.();
  } catch (err) {
    console.error('[LIFECYCLE] query.close() failed:', err?.message || err);
  }

  // 中断路径兜底：close() 不会连带回收 CLI 通过 Bash 派生的孙进程（e2e/浏览器等），
  // 这里按进程树强杀 CLI，避免孤儿进程常驻。仅中断时执行（正常回收 CLI 会自行带走子进程）。
  if (runtime.abortRequested && runtime.cliPid) {
    console.log('[LIFECYCLE] killProcessTree cliPid=' + runtime.cliPid + ' (abort 清理孙进程)');
    killProcessTree(runtime.cliPid);
  }

  removeRuntime(runtime, callbacks?.removeSession);
  clearActiveTurnRuntimeIf(runtime);
}

async function createRuntime(requestContext, callbacks) {
  const queryFn = await ensureQueryFn();
  const initialPermissionMode = normalizePermissionMode(requestContext.permissionMode);

  const runtime = {
    closed: false,
    sessionId: requestContext.requestedSessionId || null,
    runtimeSessionEpoch: requestContext.runtimeSessionEpoch || null,
    runtimeSignature: requestContext.runtimeSignature,
    currentModel: requestContext.sdkModelName || null,
    modelId: requestContext.modelId || null, // Original model ID, may contain [1m] suffix
    currentPermissionMode: initialPermissionMode,
    permissionModeState: { value: initialPermissionMode },
    currentMaxThinkingTokens: requestContext.maxThinkingTokens ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    activeTurnCount: 0,
    stderrLines: [],
    query: null,
    cliPid: null, // Claude CLI 子进程 pid（由下方自定义 spawn 捕获），中断时用于按树清理
    inputStream: new AsyncStream(),
    titleGenerationAttempted: false
  };

  const options = {
    ...requestContext.options,
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (!text) return;
        runtime.stderrLines.push(text);
        if (runtime.stderrLines.length > 200) {
          runtime.stderrLines.shift();
        }
        console.error(`[SDK-STDERR] ${text}`);
      } catch (_) {
      }
    }
  };

  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [{
      hooks: [createPreToolUseHook(runtime.permissionModeState, options.cwd, async (mode) => {
        if (runtime.currentPermissionMode === mode) {
          runtime.permissionModeState.value = mode;
          return;
        }
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await runtime.query.setPermissionMode(mode);
          } catch (error) {
            console.warn('[LIFECYCLE] hook setPermissionMode failed, updating local state only:', error.message);
          }
        }
        // Always update local state to keep hook and runtime in sync
        runtime.currentPermissionMode = mode;
        runtime.permissionModeState.value = mode;
      })]
    }]
  };

  // 自定义 CLI spawn：仅为拿到 Claude CLI 子进程的真实 pid（存到 runtime.cliPid），
  // 以便中断时按进程树精确清理它派生的 Bash/浏览器等孙进程（见 killProcessTree）。
  // 忠实复刻 SDK 默认 spawnLocalProcess 行为：SpawnOptions 已给出解析后的
  // command/args/cwd/env/signal；stderr 走 pipe 并转发到上面的 options.stderr（供
  // stderrLines 采集错误）；Node ChildProcess 满足 SDK 的 SpawnedProcess 接口。
  const stderrHandler = options.stderr;
  options.spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }) => {
    const child = spawnProcess(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      env,
      windowsHide: true,
    });
    runtime.cliPid = child.pid || null;
    if (child.stderr && typeof stderrHandler === 'function') {
      child.stderr.on('data', (chunk) => {
        try { stderrHandler(chunk); } catch (_) { /* ignore */ }
      });
    }
    return child;
  };

  runtime.query = queryFn({
    prompt: runtime.inputStream,
    options
  });

  rememberRuntime(runtime, requestContext, callbacks?.registerActiveQueryResult);

  console.log('[LIFECYCLE] createRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + runtime.runtimeSignature);

  return runtime;
}

async function applyDynamicControls(runtime, requestContext) {
  if (!runtime || runtime.closed) return;

  const targetPermissionMode = normalizePermissionMode(requestContext.permissionMode);
  if (runtime.currentPermissionMode !== targetPermissionMode) {
    if (typeof runtime.query?.setPermissionMode === 'function') {
      try {
        await runtime.query.setPermissionMode(targetPermissionMode);
      } catch (error) {
        console.error('[DAEMON] setPermissionMode failed:', error.message);
      }
    }
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
  }

  const targetModel = requestContext.sdkModelName || null;
  if (runtime.currentModel !== targetModel && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetModel || undefined);
      runtime.currentModel = targetModel;
    } catch (error) {
      console.error('[DAEMON] setModel failed:', error.message);
    }
  }

  const targetThinking = requestContext.maxThinkingTokens ?? null;
  if (runtime.currentMaxThinkingTokens !== targetThinking && typeof runtime.query?.setMaxThinkingTokens === 'function') {
    try {
      await runtime.query.setMaxThinkingTokens(targetThinking);
      runtime.currentMaxThinkingTokens = targetThinking;
    } catch (error) {
      console.error('[DAEMON] setMaxThinkingTokens failed:', error.message);
    }
  }
}

function assertRuntimeOwnership(runtime, requestContext) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    const err = new Error(
      `Runtime ownership mismatch: expected epoch ${requestContext.runtimeSessionEpoch}, got ${runtime.runtimeSessionEpoch || '(none)'}`
    );
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.requestedSessionId && runtime.sessionId && runtime.sessionId !== requestContext.requestedSessionId) {
    const err = new Error(
      `Runtime ownership mismatch: expected session ${requestContext.requestedSessionId}, got ${runtime.sessionId}`
    );
    err.runtimeTerminated = true;
    throw err;
  }
}

export async function acquireRuntime(requestContext, callbacks) {
  await cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));

  let runtime = findRuntimeForRequest(requestContext);

  if (runtime && runtime.runtimeSignature !== requestContext.runtimeSignature) {
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (runtime && requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    console.log('[LIFECYCLE] disposeRuntimeForEpochMismatch existing=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' requested=' + requestContext.runtimeSessionEpoch);
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (!runtime) {
    runtime = await createRuntime(requestContext, callbacks);
  } else {
    console.log('[LIFECYCLE] reuseRuntime sessionId=' + (runtime.sessionId || '(new)')
      + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' signature=' + runtime.runtimeSignature);
  }

  assertRuntimeOwnership(runtime, requestContext);
  await applyDynamicControls(runtime, requestContext);
  touchRuntime(runtime);
  return runtime;
}

export async function cleanupStaleAnonymousRuntimes(callbacks) {
  return cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export async function cleanupStaleSessionRuntimes(callbacks) {
  return cleanupSessionsFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export { beginRuntimeTurn, endRuntimeTurn, touchRuntime, applyDynamicControls };
