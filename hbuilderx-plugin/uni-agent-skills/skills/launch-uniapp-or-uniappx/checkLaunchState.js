const hx = require('../../common/scripts/hbuilderx.js')
const logcat = require('../../common/scripts/logcat.js')

const NOT_FOUND_MESSAGE = '未发现在指定平台运行的实例'
const STOPPED_PATTERNS = [
  /已停止运行/
]

function getMeaningfulLines(output) {
  return `${output || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function isLaunchStopped(output) {
  const lines = getMeaningfulLines(output)
  if (lines.length === 0) {
    return true
  }

  const recentOutput = lines.slice(-5).join('\n')
  return STOPPED_PATTERNS.some((pattern) => pattern.test(recentOutput))
}

async function main() {
  const cliArgs = logcat.parseArgs(process.argv.slice(2))
  const options = logcat.normalizeOptions({
    ...cliArgs,
    cli: cliArgs.cli || process.env.HBUILDERX_CLI_PATH,
  })

  logcat.validateOptions(options)
  await hx.ensureSingleHostSelected(options.cli, options.host)

  const config = {
    defaultFailureMessage: NOT_FOUND_MESSAGE,
    emptyOutputMessage: NOT_FOUND_MESSAGE,
    explicitFailureMessage: NOT_FOUND_MESSAGE,
  }
  const output = options.platform === 'web'
    ? await logcat.fetchWebLog(options, config)
    : await logcat.executeLogcat(options, config)

  const pendingState = logcat.getPendingLogState(output)
  if (pendingState) {
    process.stdout.write(`${logcat.formatPendingLogStateMessage(pendingState, '检查')}\n${output.trim()}\n`)
    process.exit(logcat.PENDING_LOG_EXIT_CODE)
  }

  process.stdout.write(`${isLaunchStopped(output) ? NOT_FOUND_MESSAGE : output}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${(error && error.message) || String(error)}\n`)
    process.exit(1)
  })
}
