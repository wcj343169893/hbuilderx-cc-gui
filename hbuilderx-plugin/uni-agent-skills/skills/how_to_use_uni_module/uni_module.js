#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const hx = require("../../common/scripts/hbuilderx.js");
const plugin = require("../../common/scripts/plugins.js");

/**
 * uni_module.js - uni_modules plugin management tool
 *
 * Usage:
 *   ./uni_module.js install <module_name> --project <project_path>
 *   ./uni_module.js inspect <module_name> --project <project_path>
 */

// Parse command line arguments
function parseArgs(args) {
    const result = {
        command: null,
        moduleName: null,
        projectPath: null
    };

    if (args.length < 1) {
        return result;
    }

    result.command = args[0];
    result.moduleName = args[1];

    // Parse --project argument
    const projectIndex = args.indexOf('--project');
    if (projectIndex !== -1 && args[projectIndex + 1]) {
        result.projectPath = args[projectIndex + 1];
    }

    return result;
}

/**
 * Check if uni_module exists in the project
 * @param {string} projectPath - Project path
 * @param {string} moduleName - Module name
 * @returns {boolean} Whether it exists
 */
function checkModuleExists(projectPath, moduleName) {
    const modulePath = path.join(projectPath, 'uni_modules', moduleName);
    return fs.existsSync(modulePath);
}

/**
 * Get module path
 * @param {string} projectPath - Project path
 * @param {string} moduleName - Module name
 * @returns {string} Module path
 */
function getModulePath(projectPath, moduleName) {
    return path.join(projectPath, 'uni_modules', moduleName);
}

/**
 * List all installed uni_modules in the project
 * @param {string} projectPath - Project path
 * @returns {string} List of installed modules
 */
function list(projectPath) {
    const uniModulesPath = path.join(projectPath, 'uni_modules');

    // Check if uni_modules directory exists
    if (!fs.existsSync(uniModulesPath)) {
        return 'No uni_modules directory found in the project';
    }

    // Read all directories in uni_modules
    const modules = fs.readdirSync(uniModulesPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    if (modules.length === 0) {
        return 'No uni_modules installed in the project';
    }

    return `Installed uni_modules (${modules.length}):\n${modules.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
}

/**
 * Install uni_module
 * @param {string} moduleName - Module name
 * @param {string} projectPath - Project path
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function install(moduleName, projectPath) {
    const hbuilderxEnv = await hx.checkHBuilderXEnvironment()
    if (hbuilderxEnv.path && fs.existsSync(hbuilderxEnv.path)) {
        const result = await hx.executeCommandWithOutput(hbuilderxEnv.path, [
        "uni_modules",
        "--download",
        moduleName,
        "--project",
        projectPath,
        ])
        return {
        success: result.code === 0,
        message:
            result.code === 0
            ? `Module ${moduleName} installed successfully`
            : `Failed to install module ${moduleName}: ${result.stderr}`,
        }
    }

    return {
        success: false,
        message: `HBuilderX CLI not found: ${hbuilderxEnv.path}`,
    }
}

/**
 * Inspect and get uni_module usage requirements and notes
 * @param {string} moduleName - Module name
 * @param {string} projectPath - Project path
 * @returns {Promise<string>} Returns module info or "NULL"
 */
async function inspect(moduleName, projectPath) {
    // TODO: Implement inspect logic
    // May need to read module's package.json, readme.md, etc.
    if (fs.existsSync(path.join(projectPath, 'uni_modules', moduleName, "LLM.md"))) {
        return fs.readFileSync(path.join(projectPath, 'uni_modules', moduleName, "LLM.md"), "utf-8").toString()
    }
    console.log("插件中没有 LLM.md 文件，尝试读取 README.md 文件")
    if (fs.existsSync(path.join(projectPath, 'uni_modules', moduleName, "README.md"))) {
        return fs.readFileSync(path.join(projectPath, 'uni_modules', moduleName, "README.md"), "utf-8").toString()
    }
    if (fs.existsSync(path.join(projectPath, 'uni_modules', moduleName, "readme.md"))) {
        return fs.readFileSync(path.join(projectPath, 'uni_modules', moduleName, "readme.md"), "utf-8").toString()
    }
    return "NULL"
}

/**
 * Print usage help
 */
function printUsage() {
    console.log(`
uni_module.js - uni_modules plugin management tool

Usage:
  ./uni_module.js list --project <project_path>
    List all installed uni_modules in the project

  ./uni_module.js plugins
    Get the list of all available uni_modules plugins

  ./uni_module.js install <module_name> --project <project_path>
    Install the specified uni_module to the project

  ./uni_module.js inspect <module_name> --project <project_path>
    Inspect and get the usage requirements and notes for the specified uni_module

Arguments:
  <module_name>   Plugin directory name (e.g.: 'uni-pay', 'uts-getwindowinfo')
  --project       Absolute path to the uni-app (x) project

Examples:
  ./uni_module.js list --project /path/to/my-uniapp-project
  ./uni_module.js plugins
  ./uni_module.js install uni-pay --project /path/to/my-uniapp-project
  ./uni_module.js inspect uni-pay --project /path/to/my-uniapp-project
`);
}


/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        process.exit(0);
    }

    const { command, moduleName, projectPath } = parseArgs(args);

    // Validate arguments
    if (!command) {
        console.error('Error: Please specify a command (list, plugins, install, inspect)');
        printUsage();
        process.exit(1);
    }

    const reqArgs = ['install', 'inspect'];
    if (reqArgs.includes(command) && !moduleName) {
        console.error('Error: Please specify a module name');
        printUsage();
        process.exit(1);
    }

    if (['list', 'install', 'inspect'].includes(command) && !projectPath) {
        console.error('Error: Please use --project to specify the project path');
        printUsage();
        process.exit(1);
    }

    // Validate project path exists
    if (['list', 'install', 'inspect'].includes(command) && !fs.existsSync(projectPath)) {
        console.error(`Error: Project path does not exist: ${projectPath}`);
        process.exit(1);
    }

    // Execute command
    switch (command) {
        case 'list': {
            const result = list(projectPath);
            console.log(result);
            break;
        }

        case 'install': {
            const result = await install(moduleName, projectPath);
            if (result.success) {
                console.log(result.message);
            } else {
                console.error(result.message);
                process.exit(1);
            }
            break;
        }

        case 'inspect': {
            // First check if module exists
            if (!checkModuleExists(projectPath, moduleName)) {
                console.log(`Module ${moduleName} does not exist in the project, please install it first`);
                console.log(`Run: ./uni_module.js install ${moduleName} --project ${projectPath}`);
                process.exit(1);
            }

            const result = await inspect(moduleName, projectPath);
            console.log(result);
            break;
        }

        case 'plugins': {
            const result =  await plugin.getPluginList()
            console.log(result);
            break;
        }

        default:
            console.error(`Error: Unknown command "${command}", supported commands: list, plugins, install, inspect`);
            printUsage();
            process.exit(1);
    }
}

// Export functions for external use
module.exports = {
    install,
    inspect,
    checkModuleExists,
    getModulePath
};

// If running this script directly
if (require.main === module) {
    main().catch(err => {
        console.error('Execution error:', err.message);
        process.exit(1);
    });
}
