/**
 * Codex channel command handler – keeps Codex specific logic separated.
 */
import { sendMessage as codexSendMessage } from '../services/codex/message-service.js';
import { getMcpServerTools as codexGetMcpServerTools } from '../services/codex/message-service.js';

/**
 * Execute a Codex command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleCodexCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          threadId,
          cwd,
          permissionMode,
          model,
          baseUrl,
          apiKey,
          reasoningEffort,
          serviceTier,
          attachments,  // Image attachments (local_image format)
          configOverrides  // 受管供应商的 config.toml 覆盖（宿主解析后下发）
        } = stdinData;
        await codexSendMessage(
          message,
          threadId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          baseUrl || '',
          apiKey || '',
          (reasoningEffort || 'medium'),
          serviceTier || '',
          attachments || [],  // Pass attachments to message service
          configOverrides || null
        );
      } else {
        await codexSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      const serverConfig = stdinData?.serverConfig || null;
      await codexGetMcpServerTools(serverId, serverConfig);
      break;
    }

    default:
      throw new Error(`Unknown Codex command: ${command}`);
  }
}

export function getCodexCommandList() {
  return ['send', 'getMcpServerTools'];
}
