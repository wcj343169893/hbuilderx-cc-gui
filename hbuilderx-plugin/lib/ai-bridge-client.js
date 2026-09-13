'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * ai-bridge 守护进程客户端。
 * 移植自 src/.../provider/common/DaemonBridge.java + ClaudeProcessInvoker.java。
 *
 * 用用户系统 Node 启动 ai-bridge/daemon.js，按 NDJSON 协议通信：
 *   stdin :  {"id":"1","method":"claude.send","params":{...}}
 *   stdout:  {"type":"daemon","event":"ready",...}        // 生命周期
 *            {"id":"1","line":"[CONTENT_DELTA] \"x\""}     // 命令输出（标记行）
 *            {"id":"1","done":true,"success":true}         // 命令完成
 */

/** 解析 ai-bridge 目录：优先插件内置副本，其次仓库同级目录（开发态）。 */
function resolveAiBridgeDir() {
  const candidates = [
    path.join(__dirname, '..', 'ai-bridge'),       // 打包随插件分发
    path.join(__dirname, '..', '..', 'ai-bridge'),  // 开发态：仓库根下的 ai-bridge
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'daemon.js'))) {
      return dir;
    }
  }
  return null;
}

class AiBridgeClient {
  /**
   * @param {string} nodePath 系统 Node 可执行路径
   * @param {{ appendLine: (s: string) => void }} output
   * @param {string} [aiBridgeDir]
   */
  constructor(nodePath, output, aiBridgeDir, extraEnv) {
    this.nodePath = nodePath;
    this.output = output || { appendLine() {} };
    this.aiBridgeDir = aiBridgeDir || resolveAiBridgeDir();
    this.extraEnv = extraEnv || {};
    this.proc = null;
    this._seq = 0;
    this._buf = '';
    /** @type {Map<string, { onLine: (line: string) => void, resolve: Function }>} */
    this._pending = new Map();
    this._readyResolve = null;
    this._readyPromise = null;
    this._disposed = false; // dispose 后拒绝再自动拉起（路由器已弃用本客户端）
    this._startedAt = 0; // daemon 子进程 spawn 时刻（毫秒时间戳），供「Node 进程管理」面板算运行时长
  }

  /** 启动 daemon，等待 ready 事件。 */
  start() {
    if (this._readyPromise) return this._readyPromise;
    if (!this.aiBridgeDir) {
      return Promise.reject(new Error('未找到 ai-bridge 目录（daemon.js）'));
    }

    const entry = path.join(this.aiBridgeDir, 'daemon.js');
    this.output.appendLine(`[ai-bridge] 启动: ${this.nodePath} ${entry}`);

    this.proc = spawn(this.nodePath, [entry], {
      cwd: this.aiBridgeDir,
      env: { ...process.env, ...this.extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._startedAt = Date.now();

    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      const onExitEarly = (code) => reject(new Error(`daemon 在就绪前退出 (code=${code})`));
      this.proc.once('exit', onExitEarly);
      this.proc.once('error', reject);
      // 就绪后摘掉早退监听
      this._clearEarlyExit = () => this.proc && this.proc.removeListener('exit', onExitEarly);
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const t = String(chunk).trim();
      if (t) this.output.appendLine(`[ai-bridge:stderr] ${t.slice(0, 500)}`);
    });
    this.proc.on('exit', (code) => {
      this.output.appendLine(`[ai-bridge] daemon 退出 (code=${code})`);
      // 失败所有未完成请求
      for (const [, p] of this._pending) {
        p.resolve({ success: false, error: `daemon exited (code=${code})` });
      }
      this._pending.clear();
      this.proc = null;
      this._readyPromise = null;
    });

    return this._readyPromise;
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        this.output.appendLine(`[ai-bridge] 非 JSON 行: ${line.slice(0, 200)}`);
        continue;
      }
      this._dispatch(obj);
    }
  }

  _dispatch(obj) {
    // 生命周期事件
    if (obj.type === 'daemon') {
      if (obj.event === 'ready') {
        if (this._clearEarlyExit) this._clearEarlyExit();
        this.output.appendLine(`[ai-bridge] ready (pid=${obj.pid}, sdkPreloaded=${obj.sdkPreloaded})`);
        if (this._readyResolve) {
          this._readyResolve(obj);
          this._readyResolve = null;
        }
      } else if (obj.event === 'log') {
        this.output.appendLine(`[ai-bridge:log] ${obj.message}`);
      } else {
        this.output.appendLine(`[ai-bridge:daemon] ${obj.event}`);
      }
      return;
    }

    // 命令输出 / 完成
    const id = obj.id;
    const pending = id != null ? this._pending.get(String(id)) : null;
    if (!pending) return;

    if (obj.line !== undefined) {
      pending.onLine(obj.line);
      return;
    }
    if (obj.stderr !== undefined) {
      this.output.appendLine(`[ai-bridge:cmd-stderr] ${String(obj.stderr).slice(0, 300)}`);
      return;
    }
    if (obj.done) {
      this._pending.delete(String(id));
      pending.resolve({ success: obj.success !== false, error: obj.error });
    }
  }

  /**
   * 发送一个命令请求。
   * daemon 不在（从未启动 / 已崩溃退出）时自动拉起自愈；启动失败则携带真实原因报错，
   * 而非裸 "daemon 未启动"（该原因对用户定位问题无帮助——例如插件目录缺 ai-bridge/ 时
   * 真实原因应为「未找到 ai-bridge 目录（daemon.js）」）。
   * @param {string} method 形如 "claude.send"
   * @param {object} params
   * @param {(line: string) => void} onLine 每行输出回调（标记行）
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async request(method, params, onLine) {
    if (!this.proc) {
      if (this._disposed) {
        return Promise.reject(new Error('daemon 已关闭（插件正在停用/重启）'));
      }
      // 自愈拉起：崩溃后下一次请求自动重启 daemon。start() 内部以 _readyPromise 去重，
      // 并发请求只会拉起一次。启动失败把真实原因带给调用方（init 失败路径同样受益）。
      try {
        await this.start();
      } catch (err) {
        return Promise.reject(new Error(`daemon 启动失败: ${err && err.message ? err.message : err}`));
      }
    }
    const id = String(++this._seq);
    return new Promise((resolve) => {
      this._pending.set(id, { onLine: onLine || (() => {}), resolve });
      const payload = JSON.stringify({ id, method, params: params || {} }) + '\n';
      try {
        this.proc.stdin.write(payload);
      } catch (err) {
        this._pending.delete(id);
        resolve({ success: false, error: err.message });
      }
    });
  }

  /** 中断当前请求。 */
  abort() {
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ method: 'abort' }) + '\n'); } catch (e) { /* ignore */ }
    }
  }

  /**
   * 当前 daemon 子进程的快照（供「Node 进程管理」面板展示）。
   * MVP：本客户端只管理这**一个**常驻 daemon 子进程，没有 Java 版 NodeProcessRegistry 那样
   * 跨 CLI 引擎/跨 channel 的进程注册表，所以只报这一条 kind:'DAEMON' 记录，不产出
   * CHANNEL/ORPHAN 记录——没有可靠的注册表数据支撑，宁可不报也不编造。
   * @returns {{id:string, kind:'DAEMON', pid:number, alive:boolean, startedAt:number, uptimeMs:number}|null}
   */
  getProcessSnapshot() {
    if (!this.proc || typeof this.proc.pid !== 'number') return null;
    const startedAt = this._startedAt || Date.now();
    return {
      id: 'ai-bridge-daemon',
      kind: 'DAEMON',
      pid: this.proc.pid,
      alive: this.proc.exitCode == null && this.proc.signalCode == null,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      activeRequestCount: this._pending.size,
      orphan: false,
    };
  }

  /**
   * 按 pid 终止进程（仅当 pid 与当前 daemon 一致时生效；否则视为「找不到该进程」）。
   * 终止后清空 this.proc——下一次 request() 会按自愈逻辑自动重新拉起 daemon。
   * @param {number} pid
   * @returns {{success:boolean, error?:string}}
   */
  killByPid(pid) {
    if (!this.proc || typeof this.proc.pid !== 'number') {
      return { success: false, error: 'daemon 未运行' };
    }
    if (this.proc.pid !== pid) {
      return { success: false, error: `未找到 pid=${pid} 的进程（当前 daemon pid=${this.proc.pid}）` };
    }
    try {
      this.proc.kill();
      return { success: true };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  }

  /** 优雅关闭 daemon。 */
  dispose() {
    this._disposed = true;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (e) { /* ignore */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } }, 1500).unref();
      this.proc = null;
    }
  }
}

module.exports = { AiBridgeClient, resolveAiBridgeDir };
