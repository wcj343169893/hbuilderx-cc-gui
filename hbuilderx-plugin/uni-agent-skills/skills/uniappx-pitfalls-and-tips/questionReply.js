#!/usr/bin/env node

const CHAT_URL = process.env.UNI_AGENT_UNI_HELPER_API_URL || ""
const AUTHORIZATION_TOKEN = process.env.UNI_AGENT_UNI_HELPER_AUTH_TOKEN || ""
const SUPPORTED_CLASSIFICATIONS = {
  uniapp: "uniapp",
  "uni-app": "uniapp",
  "uni-app x": "uni-app x",
  uniappx: "uni-app x",
  "uni-appx": "uni-app x",
  unicloud: "unicloud",
}

/**
 * 调用 uni-agent 问答接口获取回复
 *
 * @param {Object} options
 * @param {string} options.question - 问题描述
 * @param {string} options.classification - 问题分类
 * @returns {Promise<{chunk: string, extraData: any}>}
 */
async function getQuestionReply({ question, classification }) {
  if (!CHAT_URL) {
    throw new Error('小助手接口未配置，为了更好的发挥小助手的效果，目前仅订阅账号可以使用。<a href="https://doc.dcloud.net.cn/uni-app-x/ai/uni-agent.html#%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98%E6%8E%92%E6%9F%A5">详情</a>')
  }

  const url = new URL(CHAT_URL)
  url.searchParams.set("question", question)
  url.searchParams.set("classification", classification)
  const headers = {}

  if (AUTHORIZATION_TOKEN) {
    headers.Authorization = AUTHORIZATION_TOKEN
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body:JSON.stringify({
      question,classification
    })
  })

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`)
  }

  let result = null
  try {
    result = await response.json()
  } catch (error) {
    throw new Error(`Failed to parse response as JSON: ${error instanceof Error ? error.message : "Unknown error"}`)
  }

  if (result.errorCode !== 0 || !result.chunk) {
    throw new Error(`API error: ${result.errorMsg || "Unknown error"}`)
  }

  if (typeof result.chunk !== "string") {
    throw new Error("API error: chunk is not a string")
  }

  return {
    chunk: result.chunk,
    extraData: result.extraData || null,
  }
}

const args = process.argv.slice(2)

/**
 * 获取命令行参数的值
 * @param {string} long - 长参数名
 * @param {string} short - 短参数名
 * @returns {string|null} 参数值，如果不存在则返回 null
 */
function getArgValue(long, short) {
  const indexLong = args.indexOf(long)
  const indexShort = args.indexOf(short)

  const index = indexLong !== -1 ? indexLong : indexShort !== -1 ? indexShort : -1

  if (index !== -1 && args[index + 1]) {
    return args[index + 1]
  }

  return null
}

function normalizeClassification(classification) {
  if (!classification) {
    return null
  }

  return SUPPORTED_CLASSIFICATIONS[classification.trim().toLowerCase()] || null
}

/**
 * 打印帮助信息
 */
function printHelp() {
  console.log(`
Usage:
  questionReply --question <keyword> --classification <type>

Options:
  -q, --question         问题描述（必填）
  -c, --classification   问题分类（必填）：uniapp | uni-app x | unicloud
  -h, --help             显示帮助信息

Examples:
  questionReply --question "hbuilder 编译没反应" --classification "uni-app x"
  questionReply -q "云函数报错" -c unicloud
`)
}

/**
 * 主函数，解析命令行参数并调用 API
 */
async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    process.exit(0)
  }

  const question = getArgValue("--question", "-q")
  const classification = normalizeClassification(getArgValue("--classification", "-c"))

  if (!question) {
    console.error("❌ 缺少必要参数 question\n")
    printHelp()
    process.exit(1)
  }

  if (!classification) {
    console.error("❌ classification 不能为空，且必须是 uniapp、uni-app x 或 unicloud\n")
    printHelp()
    process.exit(1)
  }

  const result = await getQuestionReply({
    question,
    classification,
  })

  console.log(result.chunk)
}

/**
 * 如果直接运行此脚本，则执行 main 函数
 */
;(async () => {
  await main().catch((err) => {
    console.error("❌ 执行失败:", err.message)
    process.exit(1)
  })
})()
