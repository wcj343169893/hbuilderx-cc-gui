/**
 * Codex Message Service — Slim Coordinator
 *
 * Handles message sending through Codex SDK (@openai/codex-sdk).
 * Provides unified interface that matches Claude's message service.
 *
 * Key Differences from Claude:
 * - Uses threadId instead of sessionId
 * - Permission model: skipGitRepoCheck + sandbox (not permissionMode string)
 * - Events: thread.*, turn.*, item.* (not system/assistant/user/result)
 * - Supports images via local_image type (requires file paths)
 *
 * All event-processing logic lives in codex-event-handler.js.
 * Utility functions are split across codex-utils.js, codex-agents-loader.js,
 * codex-patch-parser.js, and codex-command-utils.js.
 *
 * @author Crafted with geek spirit
 */

import { CodexPermissionMapper } from '../../utils/permission-mapper.js';
import { getMcpServerTools as getMcpServerToolsImpl } from '../claude/mcp-status/index.js';
import {
  logDebug, logInfo, logWarn,
  ensureCodexSdk,
  normalizeCodexPermissionMode,
  resolveSandboxModeOverride,
  resolveApprovalPolicyOverride,
  buildCodexCliEnvironment,
  buildErrorPayload
} from './codex-utils.js';
import { collectAgentsInstructions } from './codex-agents-loader.js';
import {
  createInitialEventState,
  prepareSessionReplayBoundary,
  processCodexEventStream,
} from './codex-event-handler.js';

// ---------------------------------------------------------------------------
// Active turn tracking (daemon abort)
// ---------------------------------------------------------------------------

// 当前正在执行的 Codex 轮次的 AbortController。daemon 模式下 abort 请求绕过命令队列直接到达，
// 需经此句柄中止 runStreamed（SDK 会随 signal 结束 codex CLI 子进程）。
// 此前 turnAbortController 仅为 sendMessage 局部变量，daemon 的 abort 只能中断 Claude，
// Codex 轮次点「停止」后仍在后台继续执行。
let activeTurnAbortController = null;

/**
 * 中止当前 Codex 轮次（无进行中轮次时为 no-op）。
 * @returns {boolean} 是否确实触发了中止
 */
export function abortActiveCodexTurn() {
  const controller = activeTurnAbortController;
  if (!controller) return false;
  activeTurnAbortController = null;
  try {
    controller.abort();
  } catch (error) {
    logDebug('Codex', 'Abort active turn failed:', error?.message || error);
  }
  return true;
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

/**
 * Send message to Codex (with optional thread resumption)
 *
 * @param {string} message - User message to send
 * @param {string} threadId - Thread ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Unified permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {string} baseUrl - API base URL (optional, for custom endpoints)
 * @param {string} apiKey - API key (optional, for custom auth)
 * @param {string} reasoningEffort - Reasoning effort level (optional)
 * @param {string} serviceTier - Codex service tier; "fast" matches Codex CLI /fast (optional)
 * @param {Array} attachments - Image attachments in local_image format (optional)
 * @param {object|null} configOverrides - 受管供应商 config.toml 解析出的配置覆盖（经 SDK 转为 --config），
 *   用于不改写用户 ~/.codex/config.toml 的前提下让该供应商生效（optional）
 */
export async function sendMessage(
  message,
  threadId = null,
  cwd = null,
  permissionMode = null,
  model = null,
  baseUrl = null,
  apiKey = null,
  reasoningEffort = 'medium',
  serviceTier = null,
  attachments = [],
  configOverrides = null
) {
  let streamStarted = false;
  let streamEnded = false;
  const emitStreamEndOnce = () => {
    if (!streamStarted || streamEnded) {
      return;
    }
    streamEnded = true;
    console.log('[STREAM_END]');
  };

  try {
    const normalizedPermissionMode = normalizeCodexPermissionMode(permissionMode || 'default');

    console.log('[DEBUG] Codex sendMessage called with params:', {
      threadId,
      cwd,
      permissionMode: normalizedPermissionMode,
      model,
      reasoningEffort,
      serviceTier,
      hasBaseUrl: !!baseUrl,
      hasApiKey: !!apiKey,
      attachmentsCount: attachments?.length || 0
    });

    console.log('[MESSAGE_START]');

    // ============================================================
    // 1. Initialize Codex SDK (dynamic loading)
    // ============================================================

    const sdk = await ensureCodexSdk();
    const Codex = sdk.Codex || sdk.default || sdk;

    const codexOptions = {};

    // Always initialize config with reasoning summaries forced to true
    // so custom models not in the SDK's known-reasoning-model allowlist
    // still get thinking/reasoning parameters in API requests.
    codexOptions.config = {
      model_supports_reasoning_summaries: true
    };

    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    }
    if (configOverrides && typeof configOverrides === 'object' && !Array.isArray(configOverrides)
        && Object.keys(configOverrides).length > 0) {
      // 必须 merge 而不是赋值：上游在本批次给 config 加了 model_supports_reasoning_summaries
      // 默认键（让不在 SDK 已知推理模型白名单里的自定义模型也能拿到 thinking 参数）。
      // 本仓库的单次请求 config 覆盖若整体赋值，会把那个默认键连带抹掉——自定义模型静默失去
      // reasoning，且无任何报错。同名键仍以 configOverrides 为准。
      codexOptions.config = { ...codexOptions.config, ...configOverrides };
      logDebug('Codex', 'Provider config override keys:', Object.keys(configOverrides).join(','));
    }
    if (serviceTier && serviceTier.trim() !== '') {
      const sdkServiceTier = serviceTier.trim();
      const baseConfig = codexOptions.config || {};
      const baseFeatures = baseConfig.features && typeof baseConfig.features === 'object' ? baseConfig.features : {};
      codexOptions.config = {
        ...baseConfig,
        features: {
          ...baseFeatures,
          fast_mode: true
        },
        service_tier: sdkServiceTier
      };
      logDebug('Codex', 'Service tier:', sdkServiceTier, 'with fast_mode feature enabled');
    }

    // Pass a sanitized env to the SDK to avoid inherited CODEX_* pollution
    const { cliEnv, removedKeys } = buildCodexCliEnvironment(process.env);
    codexOptions.env = cliEnv;
    logDebug('PERM_DEBUG', 'Codex CLI env isolation:', JSON.stringify({
      removedKeys,
      removedCount: removedKeys.length
    }));

    const codex = new Codex(codexOptions);

    // ============================================================
    // 2. Map Unified Permission Mode to Codex Format
    // ============================================================

    const permissionConfig = CodexPermissionMapper.toProvider(normalizedPermissionMode);

    logDebug('PERM_DEBUG', 'Codex permission config:', JSON.stringify(permissionConfig));
    logDebug('PERM_DEBUG', 'Raw env permission overrides:', JSON.stringify({
      CODEX_SANDBOX_MODE: process.env.CODEX_SANDBOX_MODE || '',
      CODEX_APPROVAL_POLICY: process.env.CODEX_APPROVAL_POLICY || ''
    }));

    // Allow Java side to force sandbox mapping override via env vars
    const sandboxOverride = resolveSandboxModeOverride();
    if (sandboxOverride) {
      permissionConfig.sandbox = sandboxOverride;
      logDebug('PERM_DEBUG', 'Sandbox override from env CODEX_SANDBOX_MODE:', sandboxOverride);
    }
    const approvalPolicyOverride = resolveApprovalPolicyOverride();
    if (approvalPolicyOverride) {
      permissionConfig.approvalPolicy = approvalPolicyOverride;
      logDebug('PERM_DEBUG', 'Approval override from env CODEX_APPROVAL_POLICY:', approvalPolicyOverride);
    }

    // ============================================================
    // 3. Build Thread Options
    // ============================================================

    const threadOptions = {
      skipGitRepoCheck: permissionConfig.skipGitRepoCheck,
      maxTurns: 200
    };

    if (reasoningEffort && reasoningEffort.trim() !== '') {
      threadOptions.modelReasoningEffort = reasoningEffort;
      console.log('[DEBUG] Reasoning effort:', reasoningEffort);
    }

    if (permissionConfig.approvalPolicy) {
      threadOptions.approvalPolicy = permissionConfig.approvalPolicy;
    }

    // CRITICAL: Only set working directory for NEW threads
    const isResumingThread = threadId && threadId.trim() !== '';

    if (!isResumingThread) {
      if (cwd && cwd.trim() !== '') {
        threadOptions.workingDirectory = cwd;
        console.log('[DEBUG] Working directory:', cwd);
      }
    } else {
      console.log('[DEBUG] Resuming thread - skipping workingDirectory to allow session lookup');
    }

    if (model && model.trim() !== '') {
      threadOptions.model = model;
      console.log('[DEBUG] Model:', model);
    }

    if (permissionConfig.sandbox) {
      threadOptions.sandboxMode = permissionConfig.sandbox;
      console.log('[DEBUG] Sandbox mode:', permissionConfig.sandbox);
    }

    logDebug('PERM_DEBUG', 'Final Codex threadOptions:', JSON.stringify({
      permissionMode: normalizedPermissionMode,
      workingDirectory: threadOptions.workingDirectory,
      sandboxMode: threadOptions.sandboxMode,
      approvalPolicy: threadOptions.approvalPolicy,
      skipGitRepoCheck: threadOptions.skipGitRepoCheck
    }));

    // ============================================================
    // 4. Create or Resume Thread
    // ============================================================

    let thread;
    if (isResumingThread) {
      console.log('[DEBUG] Resuming thread:', threadId);
      thread = codex.resumeThread(threadId, threadOptions);
    } else {
      console.log('[DEBUG] Starting new thread');
      thread = codex.startThread(threadOptions);
    }

    // ============================================================
    // 5. Collect AGENTS.md Instructions (only for new threads)
    // ============================================================

    let finalMessage = message;
    if (!isResumingThread && cwd) {
      const agentsInstructions = collectAgentsInstructions(cwd);
      if (agentsInstructions) {
        finalMessage = `<agents-instructions>\n${agentsInstructions}\n</agents-instructions>\n\n${message}`;
        logDebug('AGENTS.md', `Prepended ${agentsInstructions.length} chars of instructions to message`);
      }
    }

    // ============================================================
    // 6. Build Input and Start Streaming
    // ============================================================

    let runInput;
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      runInput = [{ type: 'text', text: finalMessage }];
      for (const attachment of attachments) {
        if (attachment && attachment.type === 'local_image' && attachment.path) {
          runInput.push({ type: 'local_image', path: attachment.path });
          console.log('[DEBUG] Added local_image attachment:', attachment.path);
        }
      }
      console.log('[DEBUG] Using array input format with', runInput.length, 'entries');
    } else {
      runInput = finalMessage;
      console.log('[DEBUG] Using string input format');
    }

    const workingDirectory = cwd && cwd.trim() !== '' ? cwd : undefined;
    const emitMessage = (msg) => {
      console.log('[MESSAGE]', JSON.stringify(msg));
    };
    const state = createInitialEventState(emitMessage);
    await prepareSessionReplayBoundary(state, threadId);

    const turnAbortController = new AbortController();
    activeTurnAbortController = turnAbortController;
    const { events } = await thread.runStreamed(runInput, {
      signal: turnAbortController.signal
    });
    console.log('[STREAM_START]');
    streamStarted = true;

    // ============================================================
    // 7. Delegate Event Processing to codex-event-handler
    // ============================================================

    const config = {
      cwd: workingDirectory,
      threadId,
      threadOptions,
      normalizedPermissionMode,
      turnAbortController,
      onTurnCompleted: emitStreamEndOnce,
      onTurnFailed: emitStreamEndOnce
    };

    await processCodexEventStream(events, state, config);
    emitStreamEndOnce();

    // ============================================================
    // 8. Completion Phase
    // ============================================================

    if (!state.reasoningObserved) {
      console.warn('[THINKING_HINT]', 'Codex did not return reasoning items. If you still cannot see the thinking process, please refer to docs/codex/docs/config.md for hide_agent_reasoning/show_raw_agent_reasoning settings, and ensure your OpenAI account has been verified.');
    }

    if (!state.suppressNoResponseFallback && state.assistantText.length === 0) {
      const noResponseMsg = [
        '\n[WARNING] Codex completed tool executions but did not generate a text response.',
        'This may happen when:',
        '- The task was purely about gathering information',
        '- Codex reached maxTurns limit (200 turns)',
        '- The query required only command execution',
        '\nPlease try:',
        '- Asking a more specific question',
        '- Requesting explicit analysis or explanation',
        '- Checking the command outputs above for your answer'
      ].join('\n');

      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: noResponseMsg }]
        }
      });
      state.finalResponse = noResponseMsg;
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      threadId: state.currentThreadId,
      result: state.finalResponse
    }));

  } catch (error) {
    emitStreamEndOnce();
    console.error('[DEBUG] Error:', error.message);
    console.error('[DEBUG] Error stack:', error.stack);

    const errorPayload = buildErrorPayload(error);
    console.error('[SEND_ERROR]', JSON.stringify(errorPayload));
    // daemon 模式下 stderr 与 stdout 分流（非 IDEA 版单进程 redirectErrorStream），
    // 宿主只解析 stdout 行，故同时写一份到 stdout，否则错误被吞、界面只剩空回复
    //（与 claude persistent-query-service 的双写做法一致）。
    console.log('[SEND_ERROR]', JSON.stringify(errorPayload));
    console.log(JSON.stringify(errorPayload));
  } finally {
    activeTurnAbortController = null;
  }
}

// ---------------------------------------------------------------------------
// getMcpServerTools
// ---------------------------------------------------------------------------

/**
 * Gets the tools list for a Codex MCP server.
 * Reuses mcp-status-service probing logic to avoid duplicate handshake implementation.
 *
 * @param {string} serverId
 * @param {Object} rawServerConfig
 */
export async function getMcpServerTools(serverId, rawServerConfig) {
  try {
    if (!serverId) {
      const invalid = {
        success: false,
        serverId: '',
        error: 'Missing serverId',
        tools: []
      };
      console.log('[MCP_SERVER_TOOLS]' + JSON.stringify(invalid));
      console.log(JSON.stringify(invalid));
      return;
    }

    if (!rawServerConfig || typeof rawServerConfig !== 'object') {
      const invalid = {
        success: false,
        serverId,
        error: 'Missing serverConfig',
        tools: []
      };
      console.log('[MCP_SERVER_TOOLS]' + JSON.stringify(invalid));
      console.log(JSON.stringify(invalid));
      return;
    }

    const serverConfig = normalizeCodexMcpConfig(rawServerConfig);
    const toolsResult = await getMcpServerToolsImpl(serverId, serverConfig);
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
    const hasError = !!toolsResult?.error;

    const result = {
      success: !hasError || tools.length > 0,
      serverId,
      serverName: toolsResult?.name || serverId,
      tools,
      error: toolsResult?.error || null
    };

    const resultJson = JSON.stringify(result);
    console.log('[MCP_SERVER_TOOLS]' + resultJson);
    console.log(resultJson);
  } catch (error) {
    const errorResult = {
      success: false,
      serverId: serverId || '',
      error: error?.message || String(error),
      tools: []
    };
    const resultJson = JSON.stringify(errorResult);
    console.log('[MCP_SERVER_TOOLS]' + resultJson);
    console.log(resultJson);
  }
}

// ---------------------------------------------------------------------------
// normalizeCodexMcpConfig (internal)
// ---------------------------------------------------------------------------

/**
 * Converts Codex config field names to a format recognized by mcp-status-service.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeCodexMcpConfig(raw) {
  const normalized = { ...raw };
  const type = normalized.type || (normalized.url ? 'http' : 'stdio');
  normalized.type = type;

  // Codex: http_headers -> mcp-status: headers
  if (!normalized.headers && normalized.http_headers && typeof normalized.http_headers === 'object') {
    normalized.headers = { ...normalized.http_headers };
  }

  // Codex: env_http_headers (values are env var names) -> headers (resolved values)
  if (normalized.env_http_headers && typeof normalized.env_http_headers === 'object') {
    const fromEnv = {};
    for (const [headerName, envName] of Object.entries(normalized.env_http_headers)) {
      if (typeof envName === 'string') {
        const envValue = process.env[envName];
        if (envValue) {
          fromEnv[headerName] = envValue;
        }
      }
    }
    normalized.headers = { ...(normalized.headers || {}), ...fromEnv };
  }

  // Codex: bearer_token_env_var -> Authorization header
  if (normalized.bearer_token_env_var && typeof normalized.bearer_token_env_var === 'string') {
    const token = process.env[normalized.bearer_token_env_var];
    if (token && !(normalized.headers && normalized.headers.Authorization)) {
      normalized.headers = { ...(normalized.headers || {}), Authorization: `Bearer ${token}` };
    }
  }

  return normalized;
}
