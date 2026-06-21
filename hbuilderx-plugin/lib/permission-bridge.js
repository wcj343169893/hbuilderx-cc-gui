'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * 权限 / AskUserQuestion / Plan 审批的宿主侧桥接。
 * 移植自 src/.../permission/{PermissionRequestWatcher,PermissionFileProtocol,PermissionService}
 * + handler/PermissionHandler。
 *
 * 机制为文件系统 IPC（见 ai-bridge/permission-ipc.js）：
 *   - ai-bridge 在 PERMISSION_DIR 写 request-<sid>-<id>.json，并轮询 response-<sid>-<id>.json。
 *   - 宿主轮询发现 request 文件 -> 弹前端对话框 -> 据用户决定写 response 文件。
 *
 * 关键：CLAUDE_PERMISSION_DIR / CLAUDE_SESSION_ID 必须在 spawn daemon 时通过 env 传入
 * （ai-bridge 在进程启动时即读取）。本类提供 env() 供 ai-bridge-client 使用。
 */

const POLL_INTERVAL_MS = 500;
const SAFETY_NET_MS = (300 + 60) * 1000; // 与 ai-bridge 默认值一致

class PermissionBridge {
  /**
   * @param {{ callJs: (fn: string, ...args: any[]) => void }} bridge
   * @param {{ appendLine: (s: string) => void }} [output]
   */
  constructor(bridge, output) {
    this.bridge = bridge;
    this.output = output || { appendLine() {} };
    this.sessionId = crypto.randomUUID();
    this.dir = path.join(os.tmpdir(), 'ccgui-permission');
    this._timer = null;
    this._dispatched = new Set(); // 已派发的文件名，避免重复弹窗
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) { /* ignore */ }
  }

  /** 提供给 ai-bridge-client 的环境变量（spawn 前注入）。 */
  env() {
    return {
      CLAUDE_PERMISSION_DIR: this.dir,
      CLAUDE_SESSION_ID: this.sessionId,
      CLAUDE_PERMISSION_SAFETY_NET_MS: String(SAFETY_NET_MS),
    };
  }

  start() {
    if (this._timer) return;
    this._cleanupSessionFiles();
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
    this.output.appendLine(`[perm] 监听权限目录: ${this.dir} (sid=${this.sessionId})`);
  }

  dispose() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _poll() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      return;
    }
    const sid = this.sessionId;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (this._dispatched.has(name)) continue;

      if (name.startsWith(`request-${sid}-`)) {
        this._dispatch(name, 'permission');
      } else if (name.startsWith(`ask-user-question-${sid}-`) && !name.startsWith('ask-user-question-response-')) {
        this._dispatch(name, 'ask');
      } else if (name.startsWith(`plan-approval-${sid}-`) && !name.startsWith('plan-approval-response-')) {
        this._dispatch(name, 'plan');
      }
    }
  }

  _dispatch(name, kind) {
    const file = path.join(this.dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      return; // 可能写入未完成，下个轮询再试
    }
    this._dispatched.add(name);
    // 读到内容后删除 request 文件，避免重复派发（response 仍由 ai-bridge 轮询）
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }

    const requestId = data.requestId;
    if (!requestId) return;

    if (kind === 'permission') {
      this.output.appendLine(`[perm] 权限请求: ${data.toolName} (${requestId})`);
      this.bridge.callJs('showPermissionDialog', JSON.stringify({
        channelId: requestId,
        toolName: data.toolName,
        inputs: data.inputs || {},
      }));
    } else if (kind === 'ask') {
      this.output.appendLine(`[perm] AskUserQuestion (${requestId})`);
      // 前端 showAskUserQuestionDialog 接收完整请求对象（含 requestId、questions）
      this.bridge.callJs('showAskUserQuestionDialog', JSON.stringify(data));
    } else if (kind === 'plan') {
      this.output.appendLine(`[perm] Plan 审批 (${requestId})`);
      this.bridge.callJs('showPlanApprovalDialog', JSON.stringify(data));
    }
  }

  // ===== 处理来自前端的决定（由 MessageRouter 路由进来）=====

  /** permission_decision: { channelId, allow, remember, rejectMessage? } */
  handlePermissionDecision(content) {
    let d;
    try { d = JSON.parse(content); } catch (e) { return; }
    const requestId = d.channelId;
    if (!requestId) return;
    this._writeResponse(`response-${this.sessionId}-${requestId}.json`, { allow: d.allow === true });
    this._dispatched.delete(`request-${this.sessionId}-${requestId}.json`);
  }

  /** ask_user_question_response: { requestId, answers } */
  handleAskUserQuestionResponse(content) {
    let d;
    try { d = JSON.parse(content); } catch (e) { return; }
    if (!d.requestId) return;
    this._writeResponse(
      `ask-user-question-response-${this.sessionId}-${d.requestId}.json`,
      { answers: d.answers || {} }
    );
  }

  /** plan_approval_response: { requestId, approved, targetMode } */
  handlePlanApprovalResponse(content) {
    let d;
    try { d = JSON.parse(content); } catch (e) { return; }
    if (!d.requestId) return;
    this._writeResponse(
      `plan-approval-response-${this.sessionId}-${d.requestId}.json`,
      { approved: d.approved === true, targetMode: d.targetMode || 'default' }
    );
  }

  _writeResponse(name, payload) {
    try {
      fs.writeFileSync(path.join(this.dir, name), JSON.stringify(payload));
      this.output.appendLine(`[perm] 写入响应: ${name} -> ${JSON.stringify(payload)}`);
    } catch (e) {
      this.output.appendLine(`[perm] 写入响应失败: ${name} (${e && e.message})`);
    }
  }

  _cleanupSessionFiles() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch (e) { return; }
    const sid = this.sessionId;
    for (const name of names) {
      if (name.includes(`-${sid}-`)) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch (e) { /* ignore */ }
      }
    }
  }
}

module.exports = { PermissionBridge };
