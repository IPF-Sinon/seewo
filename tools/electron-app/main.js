// Aura 网页屏保 —— 由我们自己控制的运行时（下载的 Electron）
// 之所以要它：系统浏览器是独立进程，我们够不着它，全屏时用户退不出来。
// 这个窗口是我们自己的，所以注入退出按钮、接管 ESC 都有效。
const { app, BrowserWindow, globalShortcut } = require('electron');
const fs = require('fs');

function argVal(name) {
  const p = '--' + name + '=';
  const hit = process.argv.find(function (a) { return a.indexOf(p) === 0; });
  return hit ? hit.slice(p.length) : '';
}

const URL_ = argVal('aura-url');
const PID_FILE = argVal('aura-pid');

let win = null;
let quitting = false;

function quit() {
  if (quitting) { return; }
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch (e) { }
  try { if (PID_FILE) { fs.unlinkSync(PID_FILE); } } catch (e) { }
  try { app.quit(); } catch (e) { }
  setTimeout(function () { process.exit(0); }, 800);
}

function inject() {
  try {
    var js = '(function(){try{' +
      'if(document.getElementById("__aura_exit"))return;' +
      'var d=document.createElement("div");d.id="__aura_exit";' +
      'd.textContent="退出屏保";' +
      'd.style.cssText="position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px 22px;' +
      'border-radius:26px;background:rgba(0,0,0,.62);color:#fff;font:16px/1 sans-serif;cursor:pointer;' +
      'border:1px solid rgba(255,255,255,.35);box-shadow:0 4px 16px rgba(0,0,0,.45);user-select:none";' +
      'd.onclick=function(ev){ev.stopPropagation();location.href="aura-close://now";};' +
      '(document.body||document.documentElement).appendChild(d);' +
      '}catch(e){}})()';
    win.webContents.executeJavaScript(js).catch(function () { });
  } catch (e) { }
}

app.whenReady().then(function () {
  win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:aura' }
  });
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { }
  var wc = win.webContents;
  try { wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/[0-9.]+/g, '')); } catch (e) { }

  // 1) 键盘 ESC
  wc.on('before-input-event', function (ev, input) {
    try { if (input && input.key === 'Escape') { quit(); } } catch (e) { }
  });
  // 2) 页面里那个按钮 -> 哨兵地址
  wc.on('will-navigate', function (ev, u) {
    try {
      if (u && u.indexOf('aura-close:') === 0) { ev.preventDefault(); quit(); }
    } catch (e) { }
  });
  // 3) 新窗口一律原地打开
  try {
    wc.setWindowOpenHandler(function (d) {
      try {
        if (d && d.url && d.url !== 'about:blank') {
          setTimeout(function () { try { win.loadURL(d.url); } catch (e) { } }, 0);
        }
      } catch (e) { }
      return { action: 'deny' };
    });
  } catch (e) { }
  // 4) 每次加载完成都补一次按钮（页面内跳转会把它清掉）
  wc.on('did-finish-load', inject);
  wc.on('did-navigate-in-page', inject);

  win.once('ready-to-show', function () { try { win.show(); } catch (e) { } });
  win.on('closed', function () { quit(); });

  if (URL_) { win.loadURL(URL_); }

  // 5) 全局快捷键兜底
  try { globalShortcut.register('CommandOrControl+Alt+Q', quit); } catch (e) { }
  try { globalShortcut.register('CommandOrControl+Shift+Q', quit); } catch (e) { }

  if (PID_FILE) { try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (e) { } }
});

process.on('uncaughtException', function () { quit(); });
