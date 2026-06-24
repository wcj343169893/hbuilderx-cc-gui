const hx = require('./hbuilderx.js')

const EXPLICIT_FAILURE_PATTERNS = [
  /请先在 HBuilderX 中启动项目，然后再执行该命令/,
]
const PENDING_LOG_PATTERNS = [
  {
    code: 'installing-uts-runtime-extension',
    message: '运行依赖安装中',
    pattern: /(?:项目使用了uts插件，)?正在安装\s*uts\s+\S+\s+运行扩展/,
  },
]
const PENDING_LOG_EXIT_CODE = 2
const WEB_BROWSER_CANDIDATES = [null, 'Chrome', 'Firefox', 'Ie', 'Edge', 'Safari']

function parseArgs(argv) {
  const parsed = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const value = argv[index + 1]

    if (!value || value.startsWith('--')) {
      parsed[key] = ''
      continue
    }

    parsed[key] = value
    index += 1
  }

  return parsed
}

function normalizeMode(mode) {
  return typeof mode === 'string' && mode.trim() ? mode.trim() : 'full'
}

function normalizeBrowser(browser) {
  if (typeof browser !== 'string') {
    return null
  }

  const normalized = browser.trim()
  return normalized && normalized !== 'Built' ? normalized : null
}

function normalizeOptions(rawOptions) {
  return {
    cli: rawOptions.cli,
    project_path: rawOptions.project_path || rawOptions.project,
    platform: rawOptions.platform,
    mode: normalizeMode(rawOptions.mode),
    browser_name: normalizeBrowser(rawOptions.browser_name || rawOptions.browser),
    host: hx.normalizeHost(rawOptions.host),
  }
}

function buildLogcatArgs(rawOptions) {
  const options = normalizeOptions(rawOptions)
  const args = ['logcat', options.platform, '--project', options.project_path, '--mode', options.mode]

  if (options.browser_name) {
    args.push('--browser', options.browser_name)
  }

  hx.appendHostArg(args, options.host)

  return args
}

function getFailureMessage(output, fallbackMessage) {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.length > 0 ? lines[lines.length - 1] : fallbackMessage
}

function isExplicitFailure(output) {
  return EXPLICIT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
}

function getPendingLogState(output) {
  const content = `${output || ''}`

  for (const item of PENDING_LOG_PATTERNS) {
    if (item.pattern.test(content)) {
      return {
        code: item.code,
        message: item.message,
      }
    }
  }

  return null
}

function isPendingLogState(output) {
  return Boolean(getPendingLogState(output))
}

function formatPendingLogStateMessage(pendingState, action) {
  return `当前状态：${pendingState.message}，请等待完成后重试${action}；当前日志为非终态，不能判定为成功或失败。`
}

async function executeLogcat(rawOptions, config = {}) {
  const options = normalizeOptions(rawOptions)
  const result = await hx.executeCommandWithOutput(options.cli, buildLogcatArgs(options), false)
  const output = `${result.stdout}`.trim()
  const emptyOutputMessage = config.emptyOutputMessage || '未获取到有效日志输出'

  if (result.code !== 0) {
    throw new Error(getFailureMessage(output, `命令执行失败，退出码 ${result.code}`))
  }
  if (!output) {
    throw new Error(emptyOutputMessage)
  }
  if (isExplicitFailure(output)) {
    throw new Error(config.explicitFailureMessage || getFailureMessage(output, output))
  }

  return output
}

async function fetchWebLog(rawOptions, config = {}) {
  const options = normalizeOptions(rawOptions)
  let lastFailureReason = config.defaultFailureMessage || '未发现在指定平台运行的实例'

  for (const candidate of WEB_BROWSER_CANDIDATES) {
    try {
      return await executeLogcat({
        ...options,
        browser_name: candidate,
      }, config)
    } catch (error) {
      lastFailureReason = (error && error.message) || String(error)
    }
  }

  return lastFailureReason
}

function validateOptions(options) {
  if (!options.cli) {
    throw new Error('缺少环境变量 HBUILDERX_CLI_PATH')
  }

  if (!options.project_path) {
    throw new Error('缺少 --project_path 参数')
  }

  if (!options.platform) {
    throw new Error('缺少 --platform 参数')
  }
}

module.exports = {
  executeLogcat,
  fetchWebLog,
  formatPendingLogStateMessage,
  getPendingLogState,
  isPendingLogState,
  normalizeOptions,
  parseArgs,
  PENDING_LOG_EXIT_CODE,
  validateOptions,
}
