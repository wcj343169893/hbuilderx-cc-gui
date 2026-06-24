const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 通过进程查找 HBuilderX 可执行文件路径
 * @returns {Promise<string|null>} HBuilderX 可执行文件路径，如果找不到返回 null
 */
function findHBuilderXFromProcess() {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    let command;
    if (isWindows) {
      // Windows: 查找 HBuilderX.exe 进程
      command = 'wmic process where "name=\'HBuilderX.exe\'" get executablepath /format:csv';
    } else if (isMac) {
      // macOS: 查找 HBuilderX 进程，使用更精确的匹配
      command = 'ps -ax | grep -i "HBuilderX" | grep -v grep';
    } else {
      // Linux: 查找 HBuilderX 进程
      command = 'ps -ax | grep -i "HBuilderX" | grep -v grep';
    }

    exec(command, (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }

      try {
        if (isWindows) {
          // Windows 输出解析
          const lines = stdout.split('\n').filter(line => line.trim() && !line.includes('ExecutablePath'));
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length > 1) {
              const executablePath = parts[parts.length - 1].trim();
              if (executablePath && fs.existsSync(executablePath)) {
                // Windows 使用同目录下的 cli.exe
                const cliPath = path.join(path.dirname(executablePath), 'cli.exe');
                if (fs.existsSync(cliPath)) {
                  resolve(cliPath);
                  return;
                }
              }
            }
          }
        } else {
          // macOS/Linux 输出解析
          // ps 输出格式：PID TTY TIME COMMAND [args...]
          // TTY 可能是 ?? 或 ttys001 等
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;

            // 匹配格式：PID TTY TIME COMMAND [args...]
            // 使用正则直接匹配完整的 HBuilderX 路径
            // 匹配：/路径/到/HBuilderX*.app/Contents/MacOS/HBuilderX
            const pathMatch = line.match(/(\/[^\s]*(?:\s+[^\s]*)*\.app\/Contents\/MacOS\/HBuilderX)/);
            if (pathMatch && pathMatch[1]) {
              const executablePath = pathMatch[1];

              if (fs.existsSync(executablePath)) {
                const cliPath = path.join(path.dirname(executablePath), 'cli');
                if (fs.existsSync(cliPath)) {
                  resolve(cliPath);
                  return;
                }
              }
            }
          }
        }
        resolve(null);
      } catch (parseError) {
        resolve(null);
      }
    });
  });
}

/**
 * 检查 HBuilderX 环境
 * @returns {Promise<{path: string, isRunning: boolean}>} HBuilderX 可执行文件路径和是否已运行
 */
async function checkHBuilderXEnvironment() {
  // 1. 优先通过进程查找已启动的 HBuilderX
  const processPath = await findHBuilderXFromProcess();
  if (processPath) {
    return { path: processPath, isRunning: true };
  }

  // 2. 检查环境变量
  const hbuilderxCliPath = process.env.HBUILDERX_CLI_PATH;
  if (hbuilderxCliPath && fs.existsSync(hbuilderxCliPath)) {
    return { path: hbuilderxCliPath, isRunning: false };
  }

  // 3. 都没有找到，报错
  console.error('未找到 HBuilderX:');
  console.error('1. 未检测到正在运行的 HBuilderX 进程');
  console.error('2. HBUILDERX_CLI_PATH 环境变量未设置或路径无效');
  console.error('');
  console.error('请执行以下操作之一:');
  console.error('- 先启动 HBuilderX 应用程序');
  console.error('- 设置 HBUILDERX_CLI_PATH 环境变量为 HBuilderX CLI 路径');
  if (process.platform === 'darwin' || process.platform === 'linux') {
    console.error('  示例: export HBUILDERX_CLI_PATH="/Applications/HBuilderX.app/Contents/MacOS/cli"');
  } else {
    console.error('  示例: set HBUILDERX_CLI_PATH="C:\\Program Files\\HBuilderX\\cli.exe"');
  }
  process.exit(1);
}

/**
 * 执行 HBuilderX 命令
 * @param {string} hbuilderxCli - HBuilderX CLI 工具路径
 * @param {string[]} args - 命令参数
 * @param {boolean} showOutput - 是否显示输出，默认为 true
 * @returns {Promise<number>} 退出码
 */
function executeCommand(hbuilderxCli, args, showOutput = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(hbuilderxCli, args, {
      stdio: showOutput ? 'inherit' : ['ignore', 'ignore', 'ignore']
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Process killed with signal: ${signal}`));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/**
 * 执行 HBuilderX 命令并捕获输出
 * @param {string} hbuilderxCli - HBuilderX CLI 工具路径
 * @param {string[]} args - 命令参数
 * @param {boolean} printOutput - 是否打印输出到控制台，默认为 true
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 退出码和输出
 */
function executeCommandWithOutput(hbuilderxCli, args, printOutput = true) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(hbuilderxCli, args, {
      stdio: ['inherit', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      // 同时输出到控制台，保持原有体验
      if (printOutput) {
        process.stdout.write(data);
      }
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      // 同时输出到控制台，保持原有体验
      if (printOutput) {
        process.stderr.write(data);
      }
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Process killed with signal: ${signal}`));
      } else {
        resolve({
          code: code ?? 0,
          stdout,
          stderr
        });
      }
    });
  });
}

function getFailureMessage(output, fallbackMessage) {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length > 0 ? lines[lines.length - 1] : fallbackMessage;
}

function normalizeHost(host) {
  return typeof host === 'string' && host.trim() ? host.trim() : null;
}

function appendHostArg(args, host) {
  const normalizedHost = normalizeHost(host);
  if (normalizedHost) {
    args.push('--host', normalizedHost);
  }

  return args;
}

async function listHosts(hbuilderxCli) {
  const result = await executeCommandWithOutput(hbuilderxCli, ['listhost'], false);
  const output = `${result.stdout}`.trim();

  if (result.code !== 0) {
    throw new Error(getFailureMessage(output, `获取 HBuilderX 实例列表失败，退出码 ${result.code}`));
  }

  return output
    .split(/\r?\n/)
    .map((host) => host.trim())
    .filter(Boolean);
}

async function ensureSingleHostSelected(hbuilderxCli, host) {
  const normalizedHost = normalizeHost(host);
  if (normalizedHost) {
    return normalizedHost;
  }

  const hosts = await listHosts(hbuilderxCli);
  if (hosts.length > 1) {
    throw new Error(`当前存在多个运行的 HBuilderX，请通过 --host 指定目标实例，可选：${hosts.reverse().join(', ')}`);
  }

  return null;
}

/**
 * 获取当前项目路径
 * @returns {string} 项目路径
 */
function getCurrentProjectPath() {
  return process.cwd();
}

/**
 * 处理命令执行错误
 * @param {Error} error - 错误对象
 * @param {string} commandName - 命令名称
 */
function handleCommandError(error, commandName) {
  console.error(`Failed to execute ${commandName} command: ${error.message}`);
  process.exit(1);
}

module.exports = {
  checkHBuilderXEnvironment,
  appendHostArg,
  executeCommand,
  executeCommandWithOutput,
  ensureSingleHostSelected,
  getCurrentProjectPath,
  handleCommandError,
  listHosts,
  normalizeHost
};
