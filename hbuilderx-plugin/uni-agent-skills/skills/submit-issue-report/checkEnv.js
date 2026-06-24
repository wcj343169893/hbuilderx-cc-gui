const hx = require("../../common/scripts/hbuilderx.js");
const fs = require('fs');

// 这个探测脚本主要给旧流程兜底：尽量拿到可用 CLI，并在需要时拉起 HBuilderX。
(async function() {
  const hbuilderxEnv = await hx.checkHBuilderXEnvironment();
  if (hbuilderxEnv.path && fs.existsSync(hbuilderxEnv.path)) {
    if (hbuilderxEnv.isRunning) {
      console.log(`hbuilderx_cli_path:\n${hbuilderxEnv.path}`);
    } else {
      await hx.executeCommand(hbuilderxEnv.path,["open"]);
      console.log(`hbuilderx_cli_path:\n${hbuilderxEnv.path}`);
    }
  } else {
    console.log("NOT");
  }
})();
