'use strict';

/**
 * 编辑区左右分栏 Diff 的自定义编辑器（custom editor）。
 *
 * HBuilderX 无原生 diff 视图 API，但支持 registerCustomEditorProvider：打开匹配
 * fileNamePattern 的文件时，在**编辑器区域**创建一个 WebViewPanel tab 并回调
 * resolveCustomEditor。据此把左右 diff 作为编辑区 tab 渲染（而非聊天 webview 内的浮层）。
 *
 * 结构仿官方示例 hbuilderx-extension-samples/api/customEditor/custom.js。
 * 触发方式：hx.workspace.openTextDocument('xxx.ccdiff')（.ccdiff 内容为 JSON）。
 *
 * 数据流：resolveCustomEditor 直接从 .ccdiff 文件读 JSON 并内联进 HTML 渲染（非 postMessage 灌数据）。
 */

const fs = require('fs');
const hx = require('hbuilderx');

const CustomDocument = hx.CustomEditor.CustomDocument;
const CustomEditorProvider = hx.CustomEditor.CustomEditorProvider;

class CcDiffDocument extends CustomDocument {
  constructor(uri) { super(uri); }
  dispose() { super.dispose(); }
}

/** 把 .ccdiff 文件路径规整为可 readFileSync 的本地路径（去掉可能的 file:// scheme）。 */
function toFsPath(uri) {
  let p = String(uri || '');
  if (p.startsWith('file://')) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//, '')); } catch (e) { /* ignore */ }
    // Windows: file:///D:/x -> /D:/x，去掉前导斜杠
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }
  return p;
}

// diff 主题变量（两套值取自 webview/src/utils/diffTheme.ts 的 dark / light）。
// 主题优先跟随前端传来的「界面主题」设置；无前端上下文时回退读编辑器 colorScheme。
const DARK_VARS = '--diff-surface:#1e1e1e;--diff-gutter-bg:#252526;--diff-gutter-border:#333;'
  + '--diff-text:#ccc;--diff-muted-text:#666;'
  + '--diff-added-bg:rgba(20,80,20,0.3);--diff-added-accent:#89d185;'
  + '--diff-deleted-bg:rgba(80,20,20,0.3);--diff-deleted-accent:#ff6b6b;--btn-bg:#2a2a2a;';
const LIGHT_VARS = '--diff-surface:#f8fafc;--diff-gutter-bg:#eef2f7;--diff-gutter-border:#d6dee8;'
  + '--diff-text:#243244;--diff-muted-text:#7a8794;'
  + '--diff-added-bg:#e8f5e9;--diff-added-accent:#2e7d32;'
  + '--diff-deleted-bg:#fdecea;--diff-deleted-accent:#c62828;--btn-bg:#e6ebf1;';

const DARK_SCHEMES = new Set(['Monokai', 'Atom One Dark', 'Default Dark', 'Dark']);

/** 从 HBuilderX 配置推断编辑器主题（对齐 lib/webview-host.js 的 resolveTheme）。 */
function resolveTheme(hxApi) {
  try {
    const scheme = hxApi.workspace.getConfiguration().get('editor.colorScheme');
    if (typeof scheme === 'string' && (DARK_SCHEMES.has(scheme) || /dark/i.test(scheme))) {
      return 'dark';
    }
  } catch (e) { /* 读取失败退回浅色 */ }
  return 'light';
}

/**
 * 生成编辑区 diff 页面。独立 webview（不经聊天 html-template 注入），故需完整 HTML +
 * 自带 diff 主题变量。data = { title, sections: [{label, before, after}] }，theme = 'dark'|'light'。
 * 数据经 JSON 注入（转义 < 防止 </script> 截断）；渲染逻辑与 webview/src/utils/diff.ts
 * 的 buildSideBySideRows 保持一致。
 */
function buildDiffEditorHtml(data, theme) {
  const json = JSON.stringify(data || {}).replace(/</g, '\\u003c');
  const vars = theme === 'light' ? LIGHT_VARS : DARK_VARS;
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>Diff</title><style>'
    + ':root{' + vars
    + '--ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;'
    + '--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;}'
    + '*{box-sizing:border-box;}'
    + 'html,body{margin:0;height:100%;}'
    + 'body{background:var(--diff-surface);color:var(--diff-text);font-family:var(--ui);'
    + 'display:flex;flex-direction:column;}'
    + '.hd{display:flex;align-items:center;justify-content:space-between;gap:12px;'
    + 'padding:8px 14px;border-bottom:1px solid var(--diff-gutter-border);flex:0 0 auto;}'
    + '.hd .t{font-size:13px;font-weight:600;color:var(--diff-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.hd .c{cursor:pointer;border:1px solid var(--diff-gutter-border);background:var(--btn-bg);color:var(--diff-muted-text);'
    + 'border-radius:4px;width:26px;height:26px;font-size:15px;line-height:1;}'
    + '.hd .c:hover{color:var(--diff-text);}'
    + '.body{flex:1 1 auto;overflow-y:auto;}'
    + '.sh{display:flex;align-items:center;gap:10px;padding:6px 14px;font-size:11px;color:var(--diff-muted-text);'
    + 'background:var(--diff-gutter-bg);border-top:1px solid var(--diff-gutter-border);'
    + 'border-bottom:1px solid var(--diff-gutter-border);position:sticky;top:0;z-index:1;}'
    + '.sh .st{font-family:var(--mono);font-weight:600;}'
    + '.add{color:var(--diff-added-accent);}.del{color:var(--diff-deleted-accent);}'
    + '.row{display:flex;align-items:stretch;font-family:var(--mono);font-size:12px;line-height:1.6;}'
    + '.col{flex:1 1 0;min-width:0;overflow-x:auto;}'
    + '.dv{flex:0 0 1px;background:var(--diff-gutter-border);}'
    + '.cell{display:flex;min-width:min-content;}'
    + '.cell.deleted{background:var(--diff-deleted-bg);}'
    + '.cell.added{background:var(--diff-added-bg);}'
    + '.cell.empty{background:var(--diff-gutter-bg);}'
    + '.g{flex:0 0 auto;width:44px;text-align:right;padding-right:8px;color:var(--diff-muted-text);'
    + 'user-select:none;white-space:pre;font-variant-numeric:tabular-nums;}'
    + '.gl{flex:0 0 auto;width:16px;text-align:center;user-select:none;}'
    + '.cell.deleted .gl{color:var(--diff-deleted-accent);}'
    + '.cell.added .gl{color:var(--diff-added-accent);}'
    + '.cell.unchanged .gl,.cell.empty .gl{color:transparent;}'
    + '.code{flex:1 1 auto;white-space:pre;tab-size:4;padding-right:12px;}'
    + '.empty-tip{padding:24px 14px;color:var(--diff-muted-text);font-size:12px;}'
    + '.cell.fold{background:var(--diff-gutter-bg);cursor:pointer;justify-content:center;}'
    + '.cell.fold:hover .foldbar{color:var(--diff-text);}'
    + '.foldbar{padding:2px 8px;color:var(--diff-muted-text);font-size:11px;'
    + 'font-family:var(--ui);white-space:nowrap;}'
    + '</style></head><body>'
    + '<div class="hd"><span class="t" id="title"></span>'
    + '<button class="c" id="close" title="关闭">✕</button></div>'
    + '<div class="body" id="body"></div>'
    + '<script>const DATA=' + json + ';' + DIFF_RENDER_JS + '</script>'
    + '</body></html>';
}

// 内联渲染脚本：computeDiff(LCS) + buildRows(side-by-side) + DOM 渲染。
// 注意：不得使用反引号（避免与外层模板字符串冲突）。逻辑对齐 utils/diff.ts。
const DIFF_RENDER_JS = [
  // 超大输入时 LCS 的 O(m*n) dp 会卡死/占爆内存，降级为快速对比：取公共前缀+公共后缀对齐，
  // 中间整体当作「删旧+增新」。牺牲最小编辑精度换线性时间（配合 hunk 折叠，头尾未改动会折起）。
  'function fastDiff(o,n){var L=[],i,m=o.length,k=n.length;',
  ' var p=0;while(p<m&&p<k&&o[p]===n[p])p++;',
  ' var s=0;while(s<m-p&&s<k-p&&o[m-1-s]===n[k-1-s])s++;',
  ' for(i=0;i<p;i++)L.push({type:"unchanged",content:o[i]});',
  ' for(i=p;i<m-s;i++)L.push({type:"deleted",content:o[i]});',
  ' for(i=p;i<k-s;i++)L.push({type:"added",content:n[i]});',
  ' for(i=m-s;i<m;i++)L.push({type:"unchanged",content:o[i]});',
  ' return{lines:L};}',
  'function computeDiff(o,n){',
  ' if(o.length===0&&n.length===0)return{lines:[]};',
  ' if(o.length===0)return{lines:n.map(function(c){return{type:"added",content:c};})};',
  ' if(n.length===0)return{lines:o.map(function(c){return{type:"deleted",content:c};})};',
  ' if(o.length*n.length>4000000)return fastDiff(o,n);',
  ' var m=o.length,k=n.length,dp=[];for(var i=0;i<=m;i++){dp[i]=[];for(var j=0;j<=k;j++)dp[i][j]=0;}',
  ' for(i=1;i<=m;i++)for(j=1;j<=k;j++){dp[i][j]=o[i-1]===n[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);}',
  ' var L=[];i=m;j=k;',
  ' while(i>0||j>0){',
  '  if(i>0&&j>0&&o[i-1]===n[j-1]){L.unshift({type:"unchanged",content:o[i-1]});i--;j--;}',
  '  else if(j>0&&(i===0||dp[i][j-1]>=dp[i-1][j])){L.unshift({type:"added",content:n[j-1]});j--;}',
  '  else{L.unshift({type:"deleted",content:o[i-1]});i--;}',
  ' }return{lines:L};',
  '}',
  'function buildRows(before,after){',
  ' var o=before?before.split("\\n"):[],n=after?after.split("\\n"):[];',
  ' var lines=computeDiff(o,n).lines,rows=[],ln=0,rn=0,del=[],add=[];',
  ' function flush(){var c=Math.max(del.length,add.length);',
  '  for(var x=0;x<c;x++){var d=x<del.length?del[x]:undefined,a=x<add.length?add[x]:undefined;',
  '   rows.push({left:d!==undefined?{content:d,type:"deleted",lineNo:++ln}:{content:"",type:"empty",lineNo:null},',
  '    right:a!==undefined?{content:a,type:"added",lineNo:++rn}:{content:"",type:"empty",lineNo:null}});}',
  '  del=[];add=[];}',
  ' for(var y=0;y<lines.length;y++){var l=lines[y];',
  '  if(l.type==="unchanged"){flush();rows.push({left:{content:l.content,type:"unchanged",lineNo:++ln},right:{content:l.content,type:"unchanged",lineNo:++rn}});}',
  '  else if(l.type==="deleted")del.push(l.content);else add.push(l.content);}',
  ' flush();return rows;',
  '}',
  'function glyph(t){return t==="deleted"?"-":t==="added"?"+":" ";}',
  'function cellEl(cell){var e=document.createElement("div");e.className="cell "+cell.type;',
  ' var g=document.createElement("div");g.className="g";g.textContent=cell.lineNo==null?"":String(cell.lineNo);',
  ' var gl=document.createElement("div");gl.className="gl";gl.textContent=glyph(cell.type);',
  ' var c=document.createElement("div");c.className="code";c.textContent=cell.content===""?" ":cell.content;',
  ' e.appendChild(g);e.appendChild(gl);e.appendChild(c);return e;}',
  // 折叠占位：未改动大段收成一行「⋯ 展开 N 行未改动 ⋯」，点击时同步在左右两列就地展开真实行。
  'function foldCell(n){var e=document.createElement("div");e.className="cell fold";',
  ' var c=document.createElement("div");c.className="foldbar";',
  ' c.textContent="\\u22EF 展开 "+n+" 行未改动 \\u22EF";e.appendChild(c);return e;}',
  'function appendFold(lc,rc,segRows){',
  ' var fl=foldCell(segRows.length),fr=foldCell(segRows.length);',
  ' lc.appendChild(fl);rc.appendChild(fr);',
  ' function expand(){var bl=fl.nextSibling,br=fr.nextSibling;',
  '  segRows.forEach(function(r){lc.insertBefore(cellEl(r.left),bl);rc.insertBefore(cellEl(r.right),br);});',
  '  lc.removeChild(fl);rc.removeChild(fr);}',
  ' fl.addEventListener("click",expand);fr.addEventListener("click",expand);}',
  'function renderSection(root,sec){',
  ' var rows=buildRows(sec.before||"",sec.after||"");',
  ' var adds=0,dels=0;rows.forEach(function(r){if(r.right.type==="added")adds++;if(r.left.type==="deleted")dels++;});',
  ' var sh=document.createElement("div");sh.className="sh";',
  ' var lb=document.createElement("span");lb.textContent=sec.label||"改动";',
  ' var st=document.createElement("span");st.className="st";',
  ' if(adds>0){var sa=document.createElement("span");sa.className="add";sa.textContent="+"+adds;st.appendChild(sa);}',
  ' if(adds>0&&dels>0)st.appendChild(document.createTextNode(" "));',
  ' if(dels>0){var sd=document.createElement("span");sd.className="del";sd.textContent="-"+dels;st.appendChild(sd);}',
  ' sh.appendChild(lb);sh.appendChild(st);root.appendChild(sh);',
  ' var row=document.createElement("div");row.className="row";',
  ' var lc=document.createElement("div");lc.className="col";var rc=document.createElement("div");rc.className="col";',
  ' var dv=document.createElement("div");dv.className="dv";',
  // hunk 折叠：变更行 ±CTX 内的行可见，其余未改动大段折叠（长度<=1 不值得折叠，直接渲染）。
  ' var CTX=3;',
  ' var changed=rows.map(function(r){return r.left.type!=="unchanged"||r.right.type!=="unchanged";});',
  ' function near(i){for(var j=Math.max(0,i-CTX);j<=Math.min(rows.length-1,i+CTX);j++){if(changed[j])return true;}return false;}',
  ' var segs=[],cur=null;',
  ' for(var i=0;i<rows.length;i++){var v=near(i);',
  '  if(!cur||cur.vis!==v){cur={vis:v,rows:[]};segs.push(cur);}cur.rows.push(rows[i]);}',
  ' segs.forEach(function(seg){',
  '  if(seg.vis||seg.rows.length<=1){seg.rows.forEach(function(r){lc.appendChild(cellEl(r.left));rc.appendChild(cellEl(r.right));});}',
  '  else{appendFold(lc,rc,seg.rows);}});',
  ' row.appendChild(lc);row.appendChild(dv);row.appendChild(rc);root.appendChild(row);',
  '}',
  'document.getElementById("title").textContent=DATA.title||"文件差异";',
  'var body=document.getElementById("body");',
  'var secs=(DATA.sections||[]);',
  'if(!secs.length){var t=document.createElement("div");t.className="empty-tip";t.textContent="（无差异数据）";body.appendChild(t);}',
  'else secs.forEach(function(s){renderSection(body,s);});',
  'var cb=document.getElementById("close");',
  'if(cb)cb.addEventListener("click",function(){try{hbuilderx.postMessage({command:"close"});}catch(e){}});',
].join('');

class CcDiffEditorProvider extends CustomEditorProvider {
  constructor(output) {
    super();
    this.output = output || { appendLine() {} };
  }

  openCustomDocument(uri) {
    return Promise.resolve(new CcDiffDocument(uri));
  }

  resolveCustomEditor(document, webViewPanel) {
    let data = { title: '文件差异', sections: [] };
    try {
      const fsPath = toFsPath(document && document.uri);
      const raw = fs.readFileSync(fsPath, 'utf8');
      data = JSON.parse(raw);
      this.output.appendLine('[diff-editor] resolve 成功: ' + fsPath
        + ' sections=' + ((data.sections && data.sections.length) || 0));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.output.appendLine('[diff-editor] 读取/解析失败: ' + msg);
      data = { title: '差异数据读取失败', sections: [{ label: msg, before: '', after: '' }] };
    }

    try {
      // 优先用前端随 payload 传来的界面主题（跟随「设置→基础配置→界面主题」）；
      // 缺省时（如右键 spike 入口无前端上下文）回退读 HBuilderX 编辑器 colorScheme。
      const fromUi = data && (data.theme === 'light' || data.theme === 'dark');
      const theme = fromUi ? data.theme : resolveTheme(hx);
      webViewPanel.webView.html = buildDiffEditorHtml(data, theme);
      this.output.appendLine('[diff-editor] 渲染主题=' + theme
        + (fromUi ? '(界面主题)' : '(编辑器 colorScheme)'));
    } catch (e) {
      this.output.appendLine('[diff-editor] 设置 html 失败: ' + ((e && e.message) || e));
    }

    try {
      webViewPanel.webView.onDidReceiveMessage((msg) => {
        if (msg && msg.command === 'close') {
          try { webViewPanel.dispose(); } catch (e) { /* ignore */ }
        }
      });
    } catch (e) { /* onDidReceiveMessage 不可用则忽略 */ }
  }

  saveCustomDocument() { return true; }
  saveCustomDocumentAs() { return true; }
}

module.exports = { CcDiffEditorProvider, buildDiffEditorHtml };
