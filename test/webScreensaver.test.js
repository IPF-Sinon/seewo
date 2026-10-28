'use strict';
/**
 * 网页屏保测试
 *
 * 为什么要走「网页」而不是给官方加转场类型：
 *   官方的 7 种转场是 public/vendor.js 里的固定 CSS 关键帧 + JS 映射，
 *   想加新的必须改渲染器 bundle（类名带构建期哈希），每次希沃升级都可能失配。
 *   网页屏保把「怎么动」交给网页自己（CSS/JS/视频），既不碰官方渲染器，
 *   又能实现无限自定义动画。
 *
 * 本文件断言的核心不变量：
 *   A. 勾了网页屏保 → /displayScreenSaver 被我们接管，官方控制器**不被调用**
 *   B. 没勾 / 没填地址 → 一律放行官方屏保（绝不劫持）
 *   C. 本地 HTML 路径 → file:/// URL
 *   D. ESC 能退出全屏（否则用户会被困住）
 *   E. ★ 任何失败都必须回退官方屏保，绝不留黑屏
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOADER = path.join(__dirname, '..', 'tools', 'payload', 'aura-screensaver-loader.js');
const ROUTE = '/displayScreenSaver';

function boot(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-web-'));
  const dataDir = path.join(tmp, 'seewo', 'AuraScreensaver');
  fs.mkdirSync(dataDir, { recursive: true });

  const prev = { APPDATA: process.env.APPDATA, CFG: process.env.AURA_SCREENSAVER_CONFIG, HOME: process.env.USERPROFILE };
  process.env.APPDATA = tmp;
  delete process.env.AURA_SCREENSAVER_CONFIG;
  delete process.env.USERPROFILE;

  if (opts.preCommand) {
    fs.writeFileSync(path.join(dataDir, 'command.json'), JSON.stringify(opts.preCommand), 'utf8');
  }

  if (opts.config) {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(opts.config), 'utf8');
  }

  const created = [];
  function FakeBrowserWindow(opt) {
    const h = {};
    const w = {
      _opt: opt, _url: null, _destroyed: false, _closed: false,
      webContents: {
        on(ev, cb) { h['wc:' + ev] = cb; },
        emit(ev, ...a) { if (h['wc:' + ev]) h['wc:' + ev](...a); },
        insertCSS(css) { w._css = (w._css || '') + css; },
        executeJavaScript(js) { w._js = (w._js || '') + js; },
        setWindowOpenHandler(fn) { w.__openHandler = fn; },
        getUserAgent() { return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/25.0.0 AuraScreensaver/1.11.0'; },
        setUserAgent(ua) { w._ua = ua; },
      },
      on(ev, cb) { h['w:' + ev] = cb; },
      setAlwaysOnTop() {}, setMenuBarVisibility() {},
      loadURL(u) { w._url = u; },
      isDestroyed() { return w._destroyed; },
      close() { w._destroyed = true; w._closed = true; if (h['w:closed']) h['w:closed'](); },
      handlers: h,
    };
    created.push(w);
    return w;
  }

  const globalShortcut = {
    _reg: {},
    register(acc, cb) { this._reg[acc] = cb; },
    unregister(acc) { delete this._reg[acc]; },
  };

  const onMessageCalls = [];
  const controller = {
    onMessage(msg) { onMessageCalls.push(msg); },
    startScreensaver() {}, stopScreensaver() {},
  };
  const share = { share() {} };

  // 记录 webpack 模块缓存里被 delete 的 id —— 用来验证我们不会乱清官方模块缓存
  const deletedIds = [];
  const modCache = new Proxy({}, {
    deleteProperty(t, k) { deletedIds.push(String(k)); return delete t[k]; },
  });
  modCache[120] = { exports: controller };
  modCache[69] = { exports: { newWindow() {}, closeWindow() {}, resetWindow() {} } };

  delete global.__AURA_SCREENSAVER__;
  global.__AURA_REQ__ = function (id) {
    if (id === 0) {
      if (opts.noBrowserWindow) return { app: { isReady: () => true, once() {}, on() {} } };
      return {
        app: { isReady: () => true, once() {}, on() {} },
        BrowserWindow: FakeBrowserWindow,
        globalShortcut: globalShortcut,
        screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
      };
    }
    if (id === 120) { if (opts.noController) throw new Error('no 120'); return controller; }
    if (id === 69) return { newWindow() {}, closeWindow() {}, resetWindow() {} };
    if (id === 2) return share;
    if (id === 40) return { startLock() {}, startLockTask() {}, userLock() {} };
    throw new Error('no module ' + id);
  };

  global.__AURA_REQ__.c = modCache;

  delete require.cache[require.resolve(LOADER)];
  require(LOADER);

  return {
    g: global.__AURA_SCREENSAVER__, controller, onMessageCalls, created, tmp, dataDir, globalShortcut, deletedIds,
    triggerRoute() { controller.__auraOriginalOnMessage({ url: ROUTE, data: { imageList: ['x.jpg'] } }); },
    cleanup() {
      delete global.__AURA_SCREENSAVER__;
      delete global.__AURA_REQ__;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.CFG !== undefined) process.env.AURA_SCREENSAVER_CONFIG = prev.CFG;
      if (prev.HOME !== undefined) process.env.USERPROFILE = prev.HOME;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

test('★ 勾了网页屏保：/displayScreenSaver 被接管，官方控制器不被调用', () => {
  const env = boot({
    config: { screensaverEnabled: true, web: { enabled: true, url: 'https://example.com/a.html' } },
  });
  try {
    // 直接调用被包装后的 onMessage（走真实拦截路径）
    env.g.control.preview && null;
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['x.jpg'] } });
    assert.equal(env.created.length, 1, '应当创建了一个网页窗口');
    assert.equal(env.created[0]._url, 'https://example.com/a.html');
    assert.equal(env.onMessageCalls.length, 0, '官方控制器不应被调用');
  } finally { env.cleanup(); }
});

test('没勾网页屏保：放行官方屏保', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: { imageList: ['a.jpg'] }, web: { enabled: false, url: 'https://example.com' } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['a.jpg'] } });
    assert.equal(env.created.length, 0, '不应创建网页窗口');
    assert.equal(env.onMessageCalls.length, 1, '应当交给官方控制器');
  } finally { env.cleanup(); }
});

test('勾了但地址为空：放行官方屏保（不劫持）', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: { imageList: ['a.jpg'] }, web: { enabled: true, url: '' } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['a.jpg'] } });
    assert.equal(env.created.length, 0);
    assert.equal(env.onMessageCalls.length, 1);
  } finally { env.cleanup(); }
});

test('showWeb 命令：本地 HTML 路径转成 file:/// 且中文做 URL 编码', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    // 新增了本地文件存在性校验，所以这里必须造一个真实文件
    const dir = path.join(env.tmp, '动画');
    fs.mkdirSync(dir, { recursive: true });
    const real = path.join(dir, '展示 页.html');
    fs.writeFileSync(real, '<html></html>');
    const winPath = real;
    const r = env.g.control.showWeb({ url: winPath });
    assert.equal(r.ok, true, r.message);
    const u = env.created[0]._url;
    assert.ok(u.startsWith('file:///'), '应以 file:/// 开头: ' + u);
    assert.ok(!u.includes('\\'), '不应有反斜杠: ' + u);
    assert.ok(/%E5%8A%A8%E7%94%BB/.test(u), '中文应被编码: ' + u);
    assert.ok(/%20/.test(u), '空格应被编码: ' + u);
  } finally { env.cleanup(); }
});

test('showWeb 命令：已是 URL 则不二次处理', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    const r = env.g.control.showWeb({ url: 'https://example.com/x' });
    assert.equal(r.ok, true);
    assert.equal(env.created[0]._url, 'https://example.com/x');
  } finally { env.cleanup(); }
});

test('showWeb 没给地址且配置里也没有：结构化失败，不建窗口', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    const r = env.g.control.showWeb({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty-url');
    assert.equal(env.created.length, 0);
  } finally { env.cleanup(); }
});

test('★ ESC 能退出全屏（否则用户被困住）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    const r = env.g.control.showWeb({ url: 'https://example.com' });
    assert.equal(r.ok, true);
    const w = env.created[0];
    w.webContents.emit('before-input-event', {}, { key: 'Escape' });
    assert.equal(w._destroyed, true, 'ESC 应当关闭窗口');
  } finally { env.cleanup(); }
});

test('closeWeb 关闭窗口且可重复调用', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    assert.equal(env.g.control.closeWeb().ok, true);
    assert.equal(env.created[0]._destroyed, true);
    assert.equal(env.g.control.closeWeb().ok, true, '重复关闭不应抛错');
  } finally { env.cleanup(); }
});

test('★ 拿不到 BrowserWindow 时回退官方屏保（不留黑屏）', () => {
  const env = boot({
    noBrowserWindow: true,
    config: { screensaverEnabled: true, override: { imageList: ['a.jpg'] }, web: { enabled: true, url: 'https://example.com' } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['a.jpg'] } });
    assert.equal(env.created.length, 0, '没窗口可建');
    assert.equal(env.onMessageCalls.length, 1, '必须回退到官方屏保，不能什么都不显示');
  } finally { env.cleanup(); }
});

test('网页显示中再次触发：复用窗口只换地址', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com/1' });
    const r = env.g.control.showWeb({ url: 'https://example.com/2' });
    assert.equal(r.ok, true);
    assert.equal(env.created.length, 1, '应当复用同一个窗口');
    assert.equal(env.created[0]._url, 'https://example.com/2');
  } finally { env.cleanup(); }
});

test('窗口全屏且置顶（保证盖住桌面）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    const o = env.created[0]._opt;
    assert.equal(o.fullscreen, true);
    assert.equal(o.frame, false);
    assert.equal(o.width, 1920);
    assert.equal(o.height, 1080);
    assert.equal(o.webPreferences.nodeIntegration, false, '外部网页不应有 node 权限');
  } finally { env.cleanup(); }
});
test('★ 模式「不修改」：override 为空且网页关闭 → 原样放行官方屏保', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: null, web: { enabled: false, url: '' } },
  });
  try {
    const payload = { imageList: ['cloud-a.jpg', 'cloud-b.jpg'], materialSource: '屏保功能来源于希沃集控', switchInterval: 5 };
    env.controller.onMessage({ url: ROUTE, data: payload });
    assert.equal(env.created.length, 0, '不应创建网页窗口');
    assert.equal(env.onMessageCalls.length, 1, '应当交给官方控制器');
    // 不修改 = 载荷要原样传下去，一个字段都不能动
    assert.deepEqual(env.onMessageCalls[0], { url: ROUTE, data: payload });
  } finally { env.cleanup(); }
});

test('模式「自定义图集」：网页关闭时不该建网页窗口', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: { imageList: ['mine.jpg'], textList: [] }, web: { enabled: false, url: 'https://example.com' } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['cloud.jpg'] } });
    assert.equal(env.created.length, 0, '即使填了网址，没选网页模式也不该建窗');
    assert.equal(env.onMessageCalls.length, 1);
    assert.deepEqual(env.onMessageCalls[0].data.imageList, ['mine.jpg'], '应当用自定义图集覆盖');
  } finally { env.cleanup(); }
});
test('★ 本地文件不存在：报错且不建窗口（避免全屏黑屏）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    const r = env.g.control.showWeb({ url: 'D:' + String.fromCharCode(92) + 'nope' + String.fromCharCode(92) + 'missing.html' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'file-not-found');
    assert.equal(env.created.length, 0, '不该开出黑窗口');
  } finally { env.cleanup(); }
});

test('★ 路径是文件夹：报错并提示选到具体文件', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    const dir = path.join(env.tmp, 'somedir');
    fs.mkdirSync(dir, { recursive: true });
    const r = env.g.control.showWeb({ url: dir });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'is-directory');
    assert.equal(env.created.length, 0);
  } finally { env.cleanup(); }
});

test('★ 主框架加载失败：显示错误页（自带退出按钮），而不是把屏保关掉', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'http://definitely.invalid.example' });
    const w = env.created[0];
    w.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'http://definitely.invalid.example', true);
    assert.equal(w._destroyed, false, '不该直接关窗');
    assert.ok(String(w._url).startsWith('data:text/html'), '应当转到错误页: ' + w._url);
  } finally { env.cleanup(); }
});

test('★★ 子框架失败必须忽略 —— bing.com 的 about:srcdoc 就是这个（原来会把屏保关掉）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://bing.com' });
    const w = env.created[0];
    w.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'about:srcdoc', false);
    assert.equal(w._destroyed, false, '子框架失败绝不能关屏保');
    assert.equal(w._url, 'https://bing.com', '也不该跳到错误页');
  } finally { env.cleanup(); }
});

test('主框架 ERR_ABORTED(-3) 忽略（重定向/取消导航是正常现象）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    const w = env.created[0];
    w.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com', true);
    assert.equal(w._destroyed, false);
    assert.equal(w._url, 'https://example.com');
  } finally { env.cleanup(); }
});

test('★ 每次加载完成都注入可点击的退出按钮（用户要求触摸可退）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    const w = env.created[0];
    w.webContents.emit('did-finish-load');
    assert.ok(String(w._js || '').includes('__aura_exit_btn'), '应注入退出按钮');
    assert.ok(String(w._js || '').includes('退出屏保'), '按钮文字应当是「退出屏保」');
    assert.ok(String(w._css || '').includes('__aura_exit_btn'), '应注入按钮样式');
  } finally { env.cleanup(); }
});

test('★ 页面里点退出按钮（哨兵地址）能关窗，不需要 node 权限', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    const w = env.created[0];
    let prevented = false;
    w.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'aura-close://now');
    assert.equal(prevented, true, '应当拦截哨兵地址的导航');
    assert.equal(w._destroyed, true, '应当关窗');
  } finally { env.cleanup(); }
});

test('★ 全局 ESC 已注册，关窗后解绑（不长期占用快捷键）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    assert.equal(typeof env.globalShortcut._reg['Escape'], 'function', '应当注册全局 ESC');
    env.globalShortcut._reg['Escape']();
    assert.equal(env.created[0]._destroyed, true, '全局 ESC 必须能关窗');
    assert.equal(env.globalShortcut._reg['Escape'], undefined, '关窗后应解绑');
  } finally { env.cleanup(); }
});

test('★ 开机不重放旧命令（这就是「开机自动弹一次屏保」的根因）', async () => {
  const staleAt = new Date(Date.now() - 3600 * 1000).toISOString();
  const env = boot({
    config: { screensaverEnabled: true },
    preCommand: { seq: 1700000000000, cmd: 'preview', args: {}, at: staleAt },
  });
  try {
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(env.onMessageCalls.length, 0, '上次会话的命令不该被执行');
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'command.json')), '遗留命令文件应被清理');
  } finally { env.cleanup(); }
});

test('本次会话的新命令仍会被正常执行，且消费后删除', async () => {
  const env = boot({ config: { screensaverEnabled: true } });
  try {
    await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(path.join(env.dataDir, 'command.json'), JSON.stringify({
      seq: Date.now(), cmd: 'stop', args: {}, at: new Date().toISOString(),
    }));
    await new Promise(r => setTimeout(r, 1500));
    const resPath = path.join(env.dataDir, 'command-result.json');
    assert.ok(fs.existsSync(resPath), '应当写出命令结果');
    const res = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    assert.equal(res.cmd, 'stop');
    assert.equal(res.ok, true);
    assert.ok(!fs.existsSync(path.join(env.dataDir, 'command.json')), '消费后应删除命令文件');
  } finally { env.cleanup(); }
});
test('★★ 模式「不修改图片」：集控图保留，但显示参数仍生效', () => {
  const env = boot({
    config: {
      screensaverEnabled: true,
      mode: 'none',
      override: { imageList: ['should-be-ignored.jpg'], textList: [{ content: 'x' }], materialSource: 'x', switchInterval: 42, pictureSizeType: 1 },
      web: { enabled: false, url: '' },
    },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['cloud-a.jpg', 'cloud-b.jpg'], switchInterval: 5, pictureSizeType: 0, materialSource: '集控' } });
    assert.equal(env.onMessageCalls.length, 1);
    const d = env.onMessageCalls[0].data;
    assert.deepEqual(d.imageList, ['cloud-a.jpg', 'cloud-b.jpg'], '图片必须仍是集控的');
    assert.equal(d.switchInterval, 42, '切换间隔应当被覆盖');
    assert.equal(d.pictureSizeType, 1, '适配模式应当被覆盖');
    assert.equal(d.materialSource, '集控', '素材来源属于图片文案，不该被改');
  } finally { env.cleanup(); }
});

test('★ 模式「自定义图集」：图片被替换', () => {
  const env = boot({
    config: { screensaverEnabled: true, mode: 'image', override: { imageList: ['mine.jpg'], textList: [] }, web: { enabled: false, url: '' } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['cloud.jpg'], switchInterval: 5 } });
    assert.deepEqual(env.onMessageCalls[0].data.imageList, ['mine.jpg']);
  } finally { env.cleanup(); }
});

test('★ 模式「网页屏保」由 mode 字段决定（不是只看 web.enabled）', () => {
  const env = boot({
    config: { screensaverEnabled: true, mode: 'web', override: { imageList: ['mine.jpg'] }, web: { enabled: true, url: 'https://example.com' } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['cloud.jpg'] } });
    assert.equal(env.created.length, 1, '应当开网页窗口');
    assert.equal(env.onMessageCalls.length, 0);
  } finally { env.cleanup(); }
});

test('旧配置没有 mode 字段：按 web.enabled / override 推断（向后兼容）', () => {
  const env = boot({ config: { screensaverEnabled: true, override: null, web: { enabled: false, url: '' } } });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['cloud.jpg'] } });
    assert.equal(env.onMessageCalls.length, 1);
    assert.deepEqual(env.onMessageCalls[0].data.imageList, ['cloud.jpg'], '没有 override 就该原样放行');
  } finally { env.cleanup(); }
});
test('★ 点击 target="_blank" 链接要在原窗口打开（否则看着像「点了没反应」）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  return (async () => {
    try {
      env.g.control.showWeb({ url: 'https://example.com' });
      const w = env.created[0];
      assert.equal(typeof w.webContents.setWindowOpenHandler, 'function');
      assert.equal(typeof w.__openHandler, 'function', '应当注册了窗口打开处理器');
      const r = w.__openHandler({ url: 'https://example.com/sub' });
      assert.equal(r.action, 'deny', '不该另开新窗口（新窗口不在最前，用户会以为没反应）');
      // 跳转是延后一拍做的（避免在 Electron 回调里递归触发）
      await new Promise(res => setTimeout(res, 20));
      assert.equal(w._url, 'https://example.com/sub', '应当在原窗口跳转');
    } finally { env.cleanup(); }
  })();
});
test('★★ lockCascadeOnClose=true 时绝不清理模块 69 缓存', () => {
  // 实测 bug：重试循环每轮无条件 clearPoisonedCache(req,69)，
  // 把官方窗口管理器换成全新的空实例（windows 列表为空），
  // 于是 closeWindow() 找不到屏保窗口 —— 表现为「点屏幕退不出屏保，只能 Alt+F4」。
  return (async () => {
    const env = boot({ config: { screensaverEnabled: true, lockCascadeOnClose: true } });
    try {
      assert.equal(env.g.lockCascadeGuard, false, '这种配置下是故意不装守卫');
      await new Promise(r => setTimeout(r, 2600));
      assert.ok(!env.deletedIds.includes('69'), '模块 69 的缓存被删了: ' + env.deletedIds.join(','));
      assert.ok(!env.deletedIds.includes('120'), '模块 120 的缓存也不该被删');
    } finally { env.cleanup(); }
  })();
});

test('★★ 重试循环运行期间也不清模块 69 缓存（这才是 bug 的真实场景）', () => {
  // 让控制器一开始拿不到 → 强制进入重试循环；再断言重试期间绝不删模块 69。
  // 旧代码在重试里无条件 clearPoisonedCache(req,69)，会把官方窗口管理器
  // 换成全新的空实例（windows 为空），closeWindow() 就再也关不掉屏保了。
  return (async () => {
    const env = boot({ noController: true, config: { screensaverEnabled: true, lockCascadeOnClose: true } });
    try {
      await new Promise(r => setTimeout(r, 2600));
      assert.ok(!env.deletedIds.includes('69'),
        '重试期间模块 69 缓存被删了 -> ' + env.deletedIds.join(','));
    } finally { env.cleanup(); }
  })();
});

test('★★ 默认配置下重试期间同样不碰模块 69 缓存', () => {
  return (async () => {
    const env = boot({ noController: true, config: { screensaverEnabled: true } });
    try {
      await new Promise(r => setTimeout(r, 2600));
      assert.ok(!env.deletedIds.includes('69'),
        '重试期间模块 69 缓存被删了 -> ' + env.deletedIds.join(','));
    } finally { env.cleanup(); }
  })();
});
test('★ 去掉 UA 里的 Electron 标识（很多站点据此走降级分支，表现为「网页 js 不生效」）', () => {
  const env = boot({ config: { screensaverEnabled: false, web: { enabled: false, url: '' } } });
  try {
    env.g.control.showWeb({ url: 'https://example.com' });
    const ua = env.created[0]._ua;
    assert.ok(ua, '应当重设过 UA');
    assert.ok(!/Electron/.test(ua), 'UA 里不该再有 Electron: ' + ua);
    assert.ok(!/AuraScreensaver/.test(ua), 'UA 里不该有我们的名字: ' + ua);
    assert.ok(/Mozilla/.test(ua), '应当仍是正常浏览器 UA: ' + ua);
  } finally { env.cleanup(); }
});
test('★ 勾了「用系统浏览器」但机器上没有 Edge/Chrome：不崩、回退官方屏保', () => {
  // 测试环境里必然找不到 Edge —— 正好验证「找不到就优雅回退」这条路径。
  // 真实机器上会走 showWebExternal 拉起 msedge --kiosk。
  const env = boot({
    config: { screensaverEnabled: true, mode: 'web', web: { enabled: true, url: 'https://example.com', useSystemBrowser: true } },
  });
  try {
    env.controller.onMessage({ url: ROUTE, data: { imageList: ['a.jpg'] } });
    assert.equal(env.created.length, 0, '没找到系统浏览器就不该建内建窗口');
    assert.equal(env.onMessageCalls.length, 1, '必须回退到官方屏保，不能什么都不显示');
  } finally { env.cleanup(); }
});
