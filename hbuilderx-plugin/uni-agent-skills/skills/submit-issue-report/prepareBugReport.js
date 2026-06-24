const fs = require('fs')
const os = require('os')
const path = require('path')

// 第二步脚本：把对话上下文整理成 report-bug 草稿配置，并输出缺失/非法字段给上层决策。

// 参数解析：把上游脚本传入的 CLI 参数还原成统一对象。

function parseArgs(argv) {
  const args = {}

  // 只处理 `--key value` / `--flag` 这两种轻量参数格式，便于被上游脚本直接拼接调用。
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    if (!current.startsWith('--')) {
      continue
    }

    const key = current.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = 'true'
      continue
    }

    args[key] = next
    i += 1
  }

  return args
}

function sanitizeText(value) {
  if (value == null) {
    return ''
  }
  return String(value).trim()
}

function normalizeMultilineText(value) {
  return sanitizeText(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
}

// 文件系统校验：统一判断文件、目录、可执行路径是否真实可读，避免无效路径进入草稿配置。

function isReadablePath(targetPath, expectedType) {
  if (!targetPath) {
    return false
  }

  try {
    const stat = fs.statSync(targetPath)
    if (expectedType === 'file' && !stat.isFile()) {
      return false
    }
    if (expectedType === 'directory' && !stat.isDirectory()) {
      return false
    }

    fs.accessSync(targetPath, fs.constants.R_OK)
    return true
  } catch (error) {
    return false
  }
}

function isReadableFile(filePath) {
  return isReadablePath(filePath, 'file')
}

function isReadableDirectory(dirPath) {
  return isReadablePath(dirPath, 'directory')
}

function collectTodoFields(payload, fields) {
  return fields.filter((field) => {
    const value = sanitizeText(payload[field])
    return !value || value.startsWith('TODO:')
  })
}

function collectMissingFields(payload) {
  // 这里把占位文案也视为“仍然缺失”，这样上层可以继续追问用户补全核心信息。
  return collectTodoFields(payload, ['title', 'step', 'module'])
}

function collectInvalidFields(payload) {
  const invalid = []

  if (payload.attachmentPath && !isReadableFile(payload.attachmentPath)) {
    invalid.push('attachmentPath')
  }
  if (payload.runLog && !isReadableFile(payload.runLog)) {
    invalid.push('runLog')
  }
  if (payload.sampleProject && !isReadableDirectory(payload.sampleProject)) {
    invalid.push('sampleProject')
  }
  if (payload.picPath && !Array.isArray(payload.picPath)) {
    invalid.push('picPath')
  }
  if (Array.isArray(payload.picPath) && payload.picPath.some((item) => !isReadableFile(item))) {
    invalid.push('picPath')
  }

  return invalid
}

function getDefaultHBuilderXAppDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'HBuilder X')
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'HBuilder X')
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'HBuilder X')
}

function getDefaultHBuilderXAiChatStorageRoot() {
  return path.join(getDefaultHBuilderXAppDataDir(), 'extensions', 'hbuilderx-ai-chat')
}

// HBuilderX 数据目录定位：只负责定位扩展数据目录，不在第二步里触发任何 CLI 探测。

// 草稿配置统一写到扩展数据目录，避免污染当前项目工作区。
function getReportBugDir() {
  return path.join(getDefaultHBuilderXAiChatStorageRoot(), 'uni-agent', 'data', 'report-bug')
}

function createReportConfigFileName() {
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-').replace('T', '_').replace('Z', '')
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `prepared-report-bug-${timestamp}-${randomSuffix}.json`
}

function getReportConfigFilePrefix() {
  return 'prepared-report-bug-'
}

function getDefaultRunLogPath() {
  return path.join(getDefaultHBuilderXAppDataDir(), '.log')
}

// 运行日志允许兜底到标准主日志，但只有用户未提供有效路径时才会触发回退。
function resolveRunLogPath(customRunLog) {
  if (isReadableFile(customRunLog)) {
    return customRunLog
  }

  // 只有用户未提供有效日志时，才回退到标准主日志路径。
  const defaultRunLogPath = getDefaultRunLogPath()
  return isReadableFile(defaultRunLogPath) ? defaultRunLogPath : ''
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

// 草稿目录会持续累积历史 JSON，这里按固定前缀筛选，并保留最近 10 份：
// 一方面避免目录无限增长，另一方面给并发生成留出缓冲，避免不同请求互相把刚生成的草稿删掉。
function cleanupOldReportConfigs(reportBugDir, keepCount = 10) {
  if (!isReadableDirectory(reportBugDir)) {
    return
  }

  const filePrefix = getReportConfigFilePrefix()
  const files = fs.readdirSync(reportBugDir)
    .filter((fileName) => fileName.startsWith(filePrefix) && fileName.endsWith('.json'))
    .map((fileName) => {
      const filePath = path.join(reportBugDir, fileName)

      try {
        return {
          fileName,
          filePath,
        }
      } catch (error) {
        return null
      }
    })
    .filter(Boolean)
    // 文件名本身带有固定宽度时间戳，按名称倒序即可稳定保留最近生成的草稿。
    .sort((left, right) => right.fileName.localeCompare(left.fileName))

  files.slice(keepCount).forEach((file) => {
    try {
      fs.unlinkSync(file.filePath)
    } catch (error) {
      // 清理失败不影响本次草稿生成，避免因为历史垃圾文件导致主流程失败。
    }
  })
}

// 值解析与字段清洗：把用户输入转换成 CLI 期望的字符串、布尔、数字或列表结构。

function getTextArg(args, key) {
  return sanitizeText(args[key])
}

function withPlaceholder(value, placeholder) {
  const text = sanitizeText(value)
  return text || placeholder
}

function parseNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseBoolean(value, fallback) {
  const text = sanitizeText(value).toLowerCase()
  if (!text) {
    return fallback
  }
  if (text === 'true') {
    return true
  }
  if (text === 'false') {
    return false
  }
  return fallback
}

function parseList(value, mapItem) {
  const text = sanitizeText(value)
  if (!text) {
    return []
  }

  // 同时兼容 JSON 数组和逗号分隔字符串，便于上层按不同来源直接透传。
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return parsed.map(mapItem).filter(Boolean)
    }
  } catch (error) {
    // ignore JSON parsing failure and use comma fallback
  }

  return text
    .split(',')
    .map((item) => mapItem(item.trim()))
    .filter(Boolean)
}

function parseFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseNumberList(value) {
  return parseList(value, parseFiniteNumber)
}

function parseStringList(value) {
  return parseList(value, sanitizeText)
}

function assignIfPresent(target, key, value) {
  if (value) {
    target[key] = value
  }
}

function assignIfTrueText(target, key, rawValue, fallback) {
  if (sanitizeText(rawValue)) {
    target[key] = parseBoolean(rawValue, fallback)
  }
}

function assignIfValidPath(target, key, value, validator) {
  if (validator(value)) {
    target[key] = value
  }
}

function getReadablePicPath(value) {
  const picPath = parseStringList(value)
  return {
    rawPicPath: picPath,
    readablePicPath: picPath.filter((item) => isReadableFile(item)),
  }
}

// 按 CLI 的 JSON 结构组装 payload，并在这里做第一轮字段清洗与路径过滤。
function buildPayload(args, runLogPath) {
  // 这里负责把对话上下文整理成 CLI 可消费的 report-bug 配置。
  const payload = {
    title: withPlaceholder(args.title, 'TODO: 请补充 bug 标题'),
    product: parseNumber(args.product, 4),
    step: withPlaceholder(normalizeMultilineText(args.step), 'TODO: 请补充复现步骤'),
    wantResult: sanitizeText(args.wantResult) || '未提供期望结果',
    module: withPlaceholder(args.module, 'TODO: 请补充模块 id'),
  }

  if (runLogPath) {
    payload.runLog = runLogPath
  }

  // 附件类字段只在路径可读时写入，避免下游拿到无效路径后再做二次裁剪。
  assignIfValidPath(payload, 'attachmentPath', getTextArg(args, 'attachmentPath'), isReadableFile)

  const phoneOsPlatform = parseNumberList(args.phoneOsPlatform)
  assignIfPresent(payload, 'phoneOsPlatform', phoneOsPlatform.length > 0 ? phoneOsPlatform : null)
  assignIfPresent(payload, 'phoneOsVersion', getTextArg(args, 'phoneOsVersion'))
  assignIfPresent(payload, 'phoneBrand', getTextArg(args, 'phoneBrand'))
  assignIfPresent(payload, 'phoneModel', getTextArg(args, 'phoneModel'))
  assignIfTrueText(payload, 'isVaporMode', args.isVaporMode, false)
  assignIfPresent(payload, 'sampleProjectGit', getTextArg(args, 'sampleProjectGit'))
  assignIfValidPath(payload, 'sampleProject', getTextArg(args, 'sampleProject'), isReadableDirectory)
  assignIfTrueText(payload, 'projectPublic', args.projectPublic, true)

  const { readablePicPath } = getReadablePicPath(args.picPath)
  if (readablePicPath.length > 0) {
    // 图片允许部分有效，但这一步只保留可读文件；是否存在无效输入由后面的 invalid 检查统一判断。
    payload.picPath = readablePicPath
  }

  return payload
}

// 草稿结果判定：区分“信息缺失”和“输入非法”，让上层决定继续追问还是直接中断流程。

function collectInvalidInputFields(args, payload) {
  // 区分“未传值”与“传了但无效”，这样第二步就能明确提示用户修正输入。
  const invalidFields = collectInvalidFields(payload)

  const attachmentPath = getTextArg(args, 'attachmentPath')
  if (attachmentPath && !payload.attachmentPath) {
    invalidFields.push('attachmentPath')
  }

  const runLog = getTextArg(args, 'runLog')
  if (runLog && payload.runLog !== runLog) {
    invalidFields.push('runLog')
  }

  if (getTextArg(args, 'sampleProject') && !payload.sampleProject) {
    invalidFields.push('sampleProject')
  }

  const { rawPicPath } = getReadablePicPath(args.picPath)
  if (rawPicPath.length > 0) {
    const readablePicCount = Array.isArray(payload.picPath) ? payload.picPath.length : 0
    if (readablePicCount !== rawPicPath.length) {
      invalidFields.push('picPath')
    }
  }

  return Array.from(new Set(invalidFields))
}

;(async function main() {
  try {
    const rawArgs = process.argv.slice(2)

    // 第一步：解析上游传入的命令行参数，拿到本次草稿生成所需的原始输入。
    const args = parseArgs(rawArgs)

    // 第二步：定位草稿文件写入目录；第二步只做信息整理，不负责解析或调用 CLI。
    const reportBugDir = getReportBugDir()
    ensureDir(reportBugDir)

    // 第三步：解析运行日志兜底路径，并把输入清洗成 report-bug 可消费的 payload。
    const customRunLog = sanitizeText(args.runLog)
    const runLogPath = resolveRunLogPath(customRunLog)
    const payload = buildPayload(args, runLogPath)

    // 第四步：把 payload 落成独立草稿文件，供后续真正的提交步骤继续使用。
    const configPath = path.join(reportBugDir, createReportConfigFileName())
    fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

    // 第五步：写入完成后再清理旧文件，但仍保留最近 10 份，给并发请求留出安全余量。
    cleanupOldReportConfigs(reportBugDir, 10)

    // 第六步：计算缺失字段和非法字段，明确告诉上层是该继续补问还是直接报错。
    const missingFields = collectMissingFields(payload)
    const invalidFields = collectInvalidInputFields(args, payload)

    // 第七步：通过标准输出返回草稿结果，供外层脚本按约定字段继续串联后续流程。
    console.log('已汇总 bug 信息')
    console.log(`config_path=${configPath}`)
    console.log(`missing_fields=${missingFields.join(',') || 'none'}`)
    console.log(`invalid_fields=${invalidFields.join(',') || 'none'}`)

    // 第八步：允许缺失字段进入补问环节，但非法输入要立即失败，避免下游继续使用被裁剪后的配置。
    if (invalidFields.length > 0) {
      process.exit(1)
    }
  } catch (error) {
    console.error(`汇总 bug 信息失败: ${error.message}`)
    process.exit(1)
  }
})()
