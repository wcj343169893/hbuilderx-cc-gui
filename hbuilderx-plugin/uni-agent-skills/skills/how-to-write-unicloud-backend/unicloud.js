#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const hx = require("../../common/scripts/hbuilderx.js")

const CLOUD_FUNCTION_TEMPLATE = `'use strict';
exports.main = async (event, context) => {
\t//event为客户端上传的参数
\tconsole.log('event : ', event)
\t
\t//返回数据给客户端
\treturn event
};
`

const CLOUD_OBJECT_TEMPLATE = `// 云对象教程: https://uniapp.dcloud.net.cn/uniCloud/cloud-obj
// jsdoc语法提示教程：https://ask.dcloud.net.cn/docs/#//ask.dcloud.net.cn/article/129
module.exports = {
\t_before: function () { // 通用预处理器

\t},
}
`

const CLOUD_FUNCTION_PARAM_TEMPLATE = `// 本文件中的json内容将在云函数【运行】时作为参数传给云函数。
// 配置教程参考：https://uniapp.dcloud.net.cn/uniCloud/rundebug.html#runparam
{
}
`

const CLOUD_OBJECT_PARAM_TEMPLATE = `// 本文件中的内容将在云对象【运行】时解析为运行参数
// 配置教程参考：https://uniapp.dcloud.net.cn/uniCloud/rundebug.html#run-obj-param

`

/**
 * unicloud.js - uniCloud 云服务管理工具
 *
 * Usage:
 *   ./unicloud.js list [providers] --project <path>
 *   ./unicloud.js init <provider> --project <path>
 *   ./unicloud.js assignspace --project <path> --provider <provider> --space <spaceId>
 *   ./unicloud.js resources --project <path> --provider <provider> --type <type> [--unimod <name>] [--cloud]
 *   ./unicloud.js exec --project <path> --provider <provider> --type <type> --name <name>
 */

// Parse command line arguments
function parseArgs(args) {
    const result = {
        command: null,
        unicloudProvider: null,  // 兼容旧命令 (list/init)
        projectPath: null,       // --project 项目路径
        provider: null,          // --provider 云服务商
        name: null,              // --name 云函数/云对象名称
        type: null,              // --type 资源类型
        space: null,             // --space 云空间ID或名称
        unimod: null,            // --unimod uni_module模块名称
        cloud: false,            // --cloud 布尔标志
    }

    if (args.length < 1) {
        return result
    }

    // 提取位置参数和命名参数
    const positionalArgs = []
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            const key = args[i].slice(2)
            if (key === "cloud") {
                result.cloud = true
            } else if (key === "project" && i + 1 < args.length && !args[i + 1].startsWith("--")) {
                result.projectPath = args[++i]
            } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                result[key] = args[++i]
            }
        } else {
            positionalArgs.push(args[i])
        }
    }

    result.command = positionalArgs[0] || null
    result.unicloudProvider = positionalArgs[1] || null

    return result
}

/**
 * 列出项目中已存在的 uniCloud 服务商
 * @param {string} projectPath - 项目路径
 * @param {string[]} providers - 服务商列表
 * @returns {Promise<string>} 返回纯文本结果
 */
async function list(projectPath, providers) {
    providers = providers || ["alipay", "aliyun", "tcb"]
    let messages = []
    providers.forEach((provider) => {
        const modulePath = path.join(projectPath, `uniCloud-${provider}`)
        if (fs.existsSync(modulePath)) {
            messages.push(`uniCloud Provider: ${provider} exists at ${modulePath}`)
        }
    })

    if (messages.length === 0) {
        return "No provider exists, Please create."
    }
    return messages.join("\n")
}

/**
 * 初始化 uniCloud 环境
 * @param {string} unicloudProvider - 服务商名称
 * @param {string} projectPath - 项目路径
 * @returns {Promise<string>} 返回纯文本结果
 */
async function init(unicloudProvider, projectPath) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (hbuilderxEnv.path && fs.existsSync(hbuilderxEnv.path)) {
        const projectName = path.basename(projectPath)
        const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
            "cloud",
            "functions",
            "--create",
            "env",
            "--prj",
            projectName,
            "--provider",
            unicloudProvider,
        ])
        if (result.code === 0) {
            return `Initialized ${unicloudProvider} unicloud environment successfully`
        }
        throw new Error(`Failed to initialize provider ${unicloudProvider}: ${result.stderr}`)
    }

    throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
}

/**
 * 关联云空间到项目
 * @param {string} projectPath - 项目路径
 * @param {string} provider - 云服务商
 * @param {string} spaceId - 云空间ID或名称
 * @returns {Promise<string>} 返回纯文本结果
 */
async function assignspace(projectPath, provider, spaceId) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }

    const projectName = path.basename(projectPath)
    const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
        "cloud", "functions",
        "--prj", projectName,
        "--provider", provider,
        "--assignspace", spaceId
    ])

    if (result.code === 0) {
        return `Successfully assigned space ${spaceId} to project`
    }
    throw new Error(`Failed to assign space: ${result.stderr}`)
}

/**
 * 获取云空间资源列表
 * @param {string} projectPath - 项目路径
 * @param {string} provider - 云服务商
 * @param {string} resourceType - 资源类型 (cloudfunction/common/db/vf/action/space)
 * @param {string} unimod - uni_module模块名称 (可选)
 * @param {boolean} isCloud - 是否查询云端资源
 * @returns {Promise<string>} 返回纯文本结果
 */
async function resources(projectPath, provider, resourceType, unimod, isCloud) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }

    const projectName = path.basename(projectPath)
    const args = [
        "cloud", "functions",
        "--list", resourceType,
        "--prj", projectName,
        "--provider", provider
    ]

    if (unimod) {
        args.push("--unimod", unimod)
    }
    if (isCloud) {
        args.push("--cloud")
    }

    const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, args, false)

    if (result.code === 0) {
        return result.stdout
    }
    throw new Error(`Failed to list resources: ${result.stderr}`)
}

/**
 * 运行云函数或云对象
 * @param {string} projectPath - 项目路径
 * @param {string} provider - 云服务商
 * @param {string} runType - 运行类型 (cloudfunction/cloudobject)
 * @param {string} name - 云函数或云对象名称
 * @returns {Promise<string>} 返回纯文本结果
 */
async function exec(projectPath, provider, runType, name) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }

    const projectName = path.basename(projectPath)
    const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
        "cloud", "functions",
        "--run", runType,
        "--prj", projectName,
        "--provider", provider,
        "--name", name
    ], false)

    if (result.code === 0) {
        return result.stdout
    }
    throw new Error(`Failed to execute ${runType}: ${result.stderr}`)
}

/**
 * 解析本地云函数列表，获取指定函数的路径
 * 输入格式: "1 - add uniCloud-aliyun/cloudfunctions/add"
 * @param {string} output - CLI 输出内容
 * @param {string} functionName - 云函数名称
 * @returns {string|null} 返回函数路径或 null
 */
function parseLocalFunctionPath(output, functionName) {
    const lines = output.split(/\r?\n/)  // 支持 \n 和 \r\n 两种换行符
    for (const line of lines) {
        const trimmedLine = line.trim()
        const match = trimmedLine.match(/^(\d+)\s+-\s+(\S+)\s+(.+)$/)
        if (match) {
            const funcName = match[2]
            const funcPath = match[3]
            if (funcName === functionName) {
                return funcPath
            }
        }
    }
    return null
}

/**
 * 检查云端函数列表中是否存在指定函数
 * 输入格式: "1 - add" 或 "1 - (module-name) func-name"
 * @param {string} output - CLI 输出内容
 * @param {string} functionName - 云函数名称
 * @returns {boolean} 是否存在
 */
function parseCloudFunctionExists(output, functionName) {
    const lines = output.split(/\r?\n/)  // 支持 \n 和 \r\n 两种换行符
    for (const line of lines) {
        const trimmedLine = line.trim()
        const match = trimmedLine.match(/^(\d+)\s+-\s+(?:\(([^)]+)\)\s+)?(\S+)$/)
        if (match) {
            const funcName = match[3]  // 函数名在第3个捕获组
            if (funcName === functionName) {
                return true
            }
        }
    }
    return false
}

/**
 * 获取 云函数/云对象 的文件路径
 * @param {string} projectPath - 项目路径
 * @param {string} provider - 云服务商
 * @param {string} name - 云函数/云对象 名称
 * @returns {Promise<string>} 返回云函数文件路径
 */
async function getpath(projectPath, provider, name) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }

    const projectName = path.basename(projectPath)
    let targetDir = null

    console.info(`Getting path for local cloud function "${name}" in project "${projectName}" with provider "${provider}"`)
    // 步骤1: 获取本地云函数列表
    const localResult = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
        "cloud", "functions",
        "--list", "cloudfunction",
        "--prj", projectName,
        "--provider", provider
    ])

    // 步骤2: 解析本地列表，查找指定函数
    const localPath = parseLocalFunctionPath(localResult.stdout, name)
    if (localPath) {
        targetDir = path.join(projectPath, localPath)
        console.info(`Cloud function "${name}" found locally at: ${targetDir}`)
    } else {
        console.info(`Cloud function "${name}" not found locally, checking cloud...`)
        // 步骤3: 本地没有，获取云端列表
        const cloudResult = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
            "cloud", "functions",
            "--list", "cloudfunction",
            "--prj", projectName,
            "--provider", provider,
            "--cloud"
        ])

        // 步骤4: 检查云端是否有该函数
        const cloudFunctionExists = parseCloudFunctionExists(cloudResult.stdout, name)
        if (cloudFunctionExists) {
            console.info(`Cloud function "${name}" found in cloud, downloading...`)
            // 步骤5: 下载云函数
            await hx.executeCommandWithOutput(hbuilderxEnv.path, [
                "cloud", "functions",
                "--download", "cloudfunction",
                "--prj", projectName,
                "--provider", provider,
                "--name", name
            ])

            // 步骤6: 重新获取本地路径
            const localResult2 = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
                "cloud", "functions",
                "--list", "cloudfunction",
                "--prj", projectName,
                "--provider", provider
            ], false)

            const finalPath = parseLocalFunctionPath(localResult2.stdout, name)
            if (finalPath) {
                targetDir = path.join(projectPath, finalPath)
                console.info(`Cloud function "${name}" downloaded to: ${targetDir}`)
            }
        }
    }

    if (!targetDir) {
        throw new Error(`Cloud function "${name}" not found in local or cloud`)
    }

    // 3. 识别类型并构建返回信息
    const indexObjJsPath = path.join(targetDir, 'index.obj.js')
    const indexJsPath = path.join(targetDir, 'index.js')

    if (fs.existsSync(indexObjJsPath)) {
        // 是云对象
        const paramPath = path.join(targetDir, `${name}.param.js`)

        // 检查参数文件是否存在，不存在则创建
        if (!fs.existsSync(paramPath)) {
            fs.writeFileSync(paramPath, CLOUD_OBJECT_PARAM_TEMPLATE, 'utf8')
            console.info(`Created missing param file: ${paramPath}`)
        }

        return `Cloud object files with name "${name}":
Index file path: ${indexObjJsPath}
Param file path: ${paramPath}`
    } else {
        // 默认为云函数
        const paramPath = path.join(targetDir, `${name}.param.json`)

        // 检查参数文件是否存在，不存在则创建
        if (!fs.existsSync(paramPath)) {
            fs.writeFileSync(paramPath, CLOUD_FUNCTION_PARAM_TEMPLATE, 'utf8')
            console.info(`Created missing param file: ${paramPath}`)
        }

        return `Cloud function files with name "${name}":
Index file path: ${indexJsPath}
Param file path: ${paramPath}`
    }
}

/**
 * 创建本地云函数或云对象
 * @param {string} projectPath - 项目路径
 * @param {string} provider - 云服务商
 * @param {string} type - 类型 (cloudfunction/cloudobject)
 * @param {string} name - 云函数或云对象名称
 * @returns {Promise<string>} 返回创建结果信息
 */
async function create(projectPath, provider, type, name) {
    // 1. 构建目标目录路径
    const targetDir = path.join(projectPath, `uniCloud-${provider}`, 'cloudfunctions', name)

    // 2. 检查目录是否已存在
    if (fs.existsSync(targetDir)) {
        throw new Error(`${type === 'cloudfunction' ? 'Cloud function' : 'Cloud object'} "${name}" already exists at ${targetDir}`)
    }

    // 3. 创建目录
    fs.mkdirSync(targetDir, {recursive: true})

    // 4. 准备 package.json 内容
    const packageContent = JSON.stringify({
        name: name,
        dependencies: {},
        extensions: {
            "uni-cloud-jql": {}
        }
    }, null, 2)
    const packagePath = path.join(targetDir, 'package.json')

    // 5. 根据类型创建文件
    if (type === 'cloudfunction') {
        // 创建云函数文件
        const indexPath = path.join(targetDir, 'index.js')
        fs.writeFileSync(indexPath, CLOUD_FUNCTION_TEMPLATE, 'utf8')

        // 创建参数配置文件
        const paramPath = path.join(targetDir, `${name}.param.json`)
        fs.writeFileSync(paramPath, CLOUD_FUNCTION_PARAM_TEMPLATE, 'utf8')

        // 创建 package.json
        fs.writeFileSync(packagePath, packageContent, 'utf8')

        return `Cloud function create success with name "${name}".
Index file path: ${indexPath}
Param file path: ${paramPath}`

    } else if (type === 'cloudobject') {
        // 创建云对象文件
        const indexPath = path.join(targetDir, 'index.obj.js')
        fs.writeFileSync(indexPath, CLOUD_OBJECT_TEMPLATE, 'utf8')

        // 创建参数配置文件
        const paramPath = path.join(targetDir, `${name}.param.js`)
        fs.writeFileSync(paramPath, CLOUD_OBJECT_PARAM_TEMPLATE, 'utf8')

        // 创建 package.json
        fs.writeFileSync(packagePath, packageContent, 'utf8')

        return `Cloud object create success with name "${name}".
Index file path: ${indexPath}
Param file path: ${paramPath}`
    }

    throw new Error(`Unknown type: ${type}`)
}

/**
 * 获取 HBuilderX CLI 路径
 * @returns {Promise<string>} 返回 CLI 路径
 */
async function getcli() {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }
    return `HBuilderX CLI path: ${hbuilderxEnv.path}`
}

/**
 * 获取项目 uniCloud 关联信息
 * @param {string} provider - 云服务商 (aliyun/alipay/tcb)
 * @param {string} projectPath - 项目路径
 * @returns {Promise<string>} 返回纯文本的关联信息
 */

async function getInfo(provider, projectPath) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }

    const projectName = path.basename(projectPath)
    const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
        "cloud", "functions",
        "--info",
        "--prj", projectName,
        "--provider", provider
    ])

    if (result.code === 0) {
        return result.stdout
    }

    throw new Error(`Failed to info: ${result.stderr}`)
}

/**
 * 获取 uniCloud 本地调试运行日志
 * @param projectPath
 */
async function logcat (projectPath) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (!hbuilderxEnv.path || !fs.existsSync(hbuilderxEnv.path)) {
        throw new Error(`HBuilderX CLI not found: ${hbuilderxEnv.path}`)
    }

    const projectName = path.basename(projectPath)
    const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
        "logcat", "unicloud",
        "--project", projectName,
        "--host","HBuilderX-extension"
    ])

    if (result.code === 0) {
        return result.stdout
    }

    throw new Error(`Failed to logcat: ${result.stderr}`)
}

/**
 * Print usage help
 */
function printUsage() {
    console.log(`
unicloud.js - uniCloud 云服务管理工具

Usage:
  ./unicloud.js list [providers] --project <path>
    列出项目中已存在的 uniCloud 服务商

  ./unicloud.js init <provider> --project <path>
    初始化指定的 uniCloud 服务商环境

  ./unicloud.js assignspace --project <path> --provider <provider> --space <spaceId>
    关联云空间到项目

  ./unicloud.js resources --project <path> --provider <provider> --type <type> [--unimod <name>] [--cloud]
    获取云空间资源列表

  ./unicloud.js exec --project <path> --provider <provider> --type <type> --name <name>
    运行云函数或云对象

  ./unicloud.js getpath --project <path> --provider <provider> --name <functionName>
    获取云函数文件路径（本地不存在时自动从云端下载）

  ./unicloud.js create --project <path> --provider <provider> --type <type> --name <name>
    创建本地云函数或云对象

  ./unicloud.js getcli
    获取 HBuilderX CLI 路径

  ./unicloud.js logcat --project <path>
    获取 uniCloud 本地调试运行日志

Arguments:
  --project <path>      uni-app x 项目的绝对路径
  --provider <name>     云服务商: aliyun / alipay / tcb
  --space <id>          云空间ID或名称
  --type <type>         资源类型: cloudfunction / cloudobject / common / db / vf / action / space
  --name <name>         云函数或云对象名称
  --unimod <name>       uni_module 模块名称 (可选)
  --cloud               查询云端资源而非本地 (可选标志)

Examples:
  ./unicloud.js list --project /path/to/project
  ./unicloud.js init aliyun --project /path/to/project
  ./unicloud.js assignspace --project /path/to/project --provider aliyun --space my-space-id
  ./unicloud.js resources --project /path/to/project --provider aliyun --type cloudfunction
  ./unicloud.js resources --project /path/to/project --provider aliyun --type space --cloud
  ./unicloud.js exec --project /path/to/project --provider aliyun --type cloudfunction --name myFunction
  ./unicloud.js getpath --project /path/to/project --provider aliyun --name myFunction
  ./unicloud.js create --project /path/to/project --provider aliyun --type cloudfunction --name myFunction
  ./unicloud.js getcli
  ./unicloud.js info --project /path/to/project --provider aliyun
  ./unicloud.js logcat --project /path/to/project
`)
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2)

    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printUsage()
        process.exit(0)
    }

    const {command, unicloudProvider, projectPath, provider, name, type, space, unimod, cloud} = parseArgs(args)

    // Validate arguments
    if (!command) {
        console.error("Error: Please specify a command (list, init, assignspace, resources, exec, getpath, create, getcli, info)")
        printUsage()
        process.exit(1)
    }

    // getcli 命令不需要 projectPath
    if (command !== "getcli") {
        if (!projectPath) {
            console.error("Error: Please use --project to specify the project path")
            printUsage()
            process.exit(1)
        }

        // Validate project path exists
        if (!fs.existsSync(projectPath)) {
            console.error(`Error: Project path does not exist: ${projectPath}`)
            process.exit(1)
        }
    }

    // Execute command
    switch (command) {
        case "list": {
            let providers = unicloudProvider ? unicloudProvider.split(",") : null
            const result = await list(projectPath, providers)
            console.log(result)
            break
        }

        /**
         * 初始化云环境
         */
        case "init": {
            const result = await init(unicloudProvider, projectPath)
            console.log(result)
            break
        }

        /**
         * 关联云空间
         */
        case "assignspace": {
            if (!provider) {
                console.error("Error: --provider is required for assignspace command")
                process.exit(1)
            }
            if (!space) {
                console.error("Error: --space is required for assignspace command")
                process.exit(1)
            }
            const result = await assignspace(projectPath, provider, space)
            console.log(result)
            break
        }

        /**
         * 获取云空间资源列表
         */
        case "resources": {
            if (!provider) {
                console.error("Error: --provider is required for resources command")
                process.exit(1)
            }
            if (!type) {
                console.error("Error: --type is required (cloudfunction/common/db/vf/action/space)")
                process.exit(1)
            }
            const result = await resources(projectPath, provider, type, unimod, cloud)
            // 结果由 CLI 命令输出
            console.log(result)
            break
        }

        /**
         * 运行云函数/对象
         */
        case "exec": {
            if (!provider) {
                console.error("Error: --provider is required for exec command")
                process.exit(1)
            }
            if (!type) {
                console.error("Error: --type is required (cloudfunction/cloudobject)")
                process.exit(1)
            }
            if (!name) {
                console.error("Error: --name is required for exec command")
                process.exit(1)
            }
            const result = await exec(projectPath, provider, type, name)
            // 结果由 CLI 命令输出
            console.log(result)
            break
        }

        /**
         * 获取云函数文件路径
         */
        case "getpath": {
            if (!provider) {
                console.error("Error: --provider is required for getpath command")
                process.exit(1)
            }
            if (!name) {
                console.error("Error: --name is required for getpath command")
                process.exit(1)
            }
            const result = await getpath(projectPath, provider, name)
            console.log(result)
            break
        }

        /**
         * 创建云函数/对象
         */
        case "create": {
            if (!provider) {
                console.error("Error: --provider is required for create command")
                process.exit(1)
            }
            if (!type) {
                console.error("Error: --type is required (cloudfunction/cloudobject)")
                process.exit(1)
            }
            if (!name) {
                console.error("Error: --name is required for create command")
                process.exit(1)
            }
            const result = await create(projectPath, provider, type, name)
            console.log(result)
            break
        }

        /**
         * 获取 HBuilderX CLI 路径
         */
        case "getcli": {
            const result = await getcli()
            console.log(result)
            break
        }

        case "info": {
            if (!provider) {
                console.error("Error: --provider is required for info command")
                process.exit(1)
            }
            await getInfo(provider, projectPath)
            break
        }

        case "logcat": {
            await logcat(projectPath)
            break
        }

        default:
            console.error(`Error: Unknown command "${command}", supported commands: list, init, assignspace, resources, exec, getpath, create, getcli, info, logcat`)
            printUsage()
            process.exit(1)
    }
}


// If running this script directly
if (require.main === module) {
    main().catch((err) => {
        console.error("Execution error:", err.message)
        process.exit(1)
    })
}
