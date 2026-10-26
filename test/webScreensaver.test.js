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

  const onMessageCalls = [];
  const controller = {
    onMessage(msg) { onMessageCalls.push(msg); },
    startScreensaver() {}, stopScreensaver() {},
  };
  const share = { share() {} };

  delete global.__AURA_SCREENSAVER__;
  global.__AURA_REQ__ = function (id) {
    if (id === 0) {
      if (opts.noBrowserWindow) return { app: { isReady: () => true, once() {}, on() {} } };
      return {
        app: { isReady: () => true, once() {}, on() {} },
        BrowserWindow: FakeBrowserWindow,
        screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
      };
    }
    if (id === 120) return controller;
    if (id === 69) return { newWindow() {}, closeWindow() {}, resetWindow() {} };
    if (id === 2) return share;
    if (id === 40) return { startLock() {}, startLockTask() {}, userLock() {} };
    throw new Error('no module ' + id);
  };

  delete require.cache[require.resolve(LOADER)];
  require(LOADER);

  return {
    g: global.__AURA_SCREENSAVER__, controller, onMessageCalls, created, tmp, dataDir,
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
    const winPath = 'D:\\动画\\展示 页.html';
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
