const hx = require("../../common/scripts/hbuilderx.js");
const fs = require('fs');
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