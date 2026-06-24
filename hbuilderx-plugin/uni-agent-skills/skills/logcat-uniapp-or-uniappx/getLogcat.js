const hx = require('../../common/scripts/hbuilderx.js')
const logcat = require('../../common/scripts/logcat.js')

async function main() {
  const cliArgs = logcat.parseArgs(process.argv.slice(2))
  const options = logcat.normalizeOptions({
    ...cliArgs,
    cli: cliArgs.cli || process.env.HBUILDERX_CLI_PATH,
  })

  logcat.validateOptions(options)
  await hx.ensureSingleHostSelected(options.cli, options.host)

  const output = options.platform === 'web'
    ? await logcat.fetchWebLog(options)
    : await logcat.executeLogcat(options)

  const pendingState = logcat.getPendingLogState(output)
  if (pendingState) {
    process.stdout.write(`${logcat.formatPendingLogStateMessage(pendingState, '获取日志')}\n${output.trim()}\n`)
    process.exit(logcat.PENDING_LOG_EXIT_CODE)
  }

  process.stdout.write(`${output.trim()}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${(error && error.message) || String(error)}\n`)
    process.exit(1)
  })
}
