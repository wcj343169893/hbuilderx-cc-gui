const hx = require("../../common/scripts/hbuilderx.js");
const fs = require('fs');
const path = require('path');

(async function() {
  const hbuilderxEnv = await hx.checkHBuilderXEnvironment();
  if (process.argv.indexOf("--checkTestEnv") != -1) {
    if (hbuilderxEnv.path && fs.existsSync(hbuilderxEnv.path)) {
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const macOSDir = path.dirname(hbuilderxEnv.path);//macOS
        const contentsDir = path.dirname(macOSDir);//Contents
        if(fs.existsSync(path.join(contentsDir,"HBuilderX","plugins","hbuilderx-for-uniapp-test"))){
          console.log("OK");
          return ;
        }
      }else{
        const rootDir = path.dirname(hbuilderxEnv.path);//ROOT
        if(fs.existsSync(path.join(rootDir,"plugins","hbuilderx-for-uniapp-test"))){
          console.log("OK");
          return ;
        }
      }
    }
    console.log("插件hbuilderx-for-uniapp-test没有安装，请先安装：https://ext.dcloud.net.cn/plugin?id=5708");
  } else {
    if (hbuilderxEnv.path && fs.existsSync(hbuilderxEnv.path)) {
      if (hbuilderxEnv.isRunning) {
        console.log(`hbuilderx_cli_path:\n${hbuilderxEnv.path}`);
      } else {
        await hx.executeCommand(hbuilderxEnv.path, ["open"]);
        console.log(`hbuilderx_cli_path:\n${hbuilderxEnv.path}`);
      }
    } else {
      console.log("NOT");
    }
  }
})();