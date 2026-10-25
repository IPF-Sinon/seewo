'use strict';
/**
 * 预览数据源与载荷契约测试
 *
 * 覆盖现象（用户实测）：
 *   点「保存并预览」→ 黑屏、没有任何图片，但屏保上的「素材来源」却显示出来了。
 *
 * 根因（逐字取自 public/screensaver.js）：
 *   function e(e){
 *     y(e.materialSource||""),                              // ① 先渲染"素材来自 X"
 *     s(e.imageList.map(function(e){                        // ② 再处理图片
 *         return e.replace(/\\/g,"\\\\")
 *     })||[]), ...
 *   }
 *   → imageList **必须是 string[]**。若是 undefined 或对象数组，
 *     ②的 .map/.replace 抛异常，而①已经执行完 —— 于是「素材来源显示了、图片全黑」。
 *
 * 另一个关键事实（逐字取自 SeewoAbility.log）：
 *   真实集控下发的 screenSaverSetting 是
 *     { data: { picture: [ {fileId, fileMd5, fileUrlType, imageUrl}, ... ] } }
 *   **里面根本没有 imageList**。所以「回落到上次集控载荷」这条路必须有转换，
 *   否则拿到的就是一个没有 imageList 的对象 → 恰好触发上面的黑屏。
 *
 * 本文件断言的核心不变量：
 *   A. 发出去之前必须校验 imageList 是 string[]；不合格**必须拒绝发送**
 *   B. 四种数据源按优先级依次回落，全都不可用时给出可读错误
 *   C. picture[].fileMd5 → %APPDATA%\seewo\SeewoAbility\screen_saver\<md5>
 *   D. localUrlMode='file' 时转成 file:/// 并做 URL 编码（中文/空格）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOADER = path.join(__dirname, '..', 'tools', 'payload', 'aura-screensaver-loader.js');

/** 造一个「管家主进程」环境 */
function boot(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-src-'));
  const dataDir = path.join(tmp, 'seewo', 'AuraScreensaver');
  fs.mkdirSync(dataDir, { recursive: true });

  const prevAppData = process.env.APPDATA;
  const prevCfgEnv = process.env.AURA_SCREENSAVER_CONFIG;
  const prevHome = process.env.USERPROFILE;
  process.env.APPDATA = tmp;
  delete process.env.AURA_SCREENSAVER_CONFIG;
  delete process.env.USERPROFILE;

  if (opts.config) {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(opts.config), 'utf8');
  }

  // 本机缓存的集控屏保（SeewoAbility）
  let ssDir = null;
  if (opts.screenSaver) {
    ssDir = path.join(tmp, 'seewo', 'SeewoAbility', 'screen_saver');
    fs.mkdirSync(ssDir, { recursive: true });
    for (const md5 of opts.screenSaver.files || []) {
      fs.writeFileSync(path.join(ssDir, md5), 'fake-image-bytes');
    }
    if (opts.screenSaver.json) {
      fs.writeFileSync(
        path.join(tmp, 'seewo', 'SeewoAbility', 'screen_saver.json'),
        JSON.stringify(opts.screenSaver.json), 'utf8');
    }
  }

  // 真实的图片文件（供存在性检查通过）
  const realImages = [];
  for (let i = 0; i < (opts.realImageCount || 0); i++) {
    const p = path.join(tmp, 'pic' + i + '.jpg');
    fs.writeFileSync(p, 'x');
    realImages.push(p);
  }

  const calls = [];
  const shared = [];
  const controller = {
    onMessage(msg) { calls.push(msg); },
    startScreensaver() {},
    stopScreensaver() {},
  };
  if (opts.lastPayload) controller.__auraLastPayload = opts.lastPayload;

  const share = { share(k, v) { shared.push({ k, v }); } };
  const wm = { newWindow() {}, closeWindow() {}, resetWindow() {} };
  const lock = { startLock() {}, startLockTask() {}, userLock() {} };

  delete global.__AURA_SCREENSAVER__;
  global.__AURA_REQ__ = function (id) {
    if (id === 120) return controller;
    if (id === 69) return wm;
    if (id === 2) return share;
    if (id === 40) return lock;
    throw new Error('no module ' + id);
  };

  delete require.cache[require.resolve(LOADER)];
  require(LOADER);

  return {
    g: global.__AURA_SCREENSAVER__,
    controller, calls, shared, tmp, dataDir, realImages,
    cleanup() {
      delete global.__AURA_SCREENSAVER__;
      delete global.__AURA_REQ__;
      if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
      if (prevCfgEnv !== undefined) process.env.AURA_SCREENSAVER_CONFIG = prevCfgEnv;
      if (prevHome !== undefined) process.env.USERPROFILE = prevHome;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

// ---------------------------------------------------------------------------
// A. 类型契约：这是黑屏的根因，必须拦住
// ---------------------------------------------------------------------------

test('★ imageList 是对象数组时必须拒绝发送（否则渲染器抛异常 → 黑屏）', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: null },
    lastPayload: {
      picture: [{ fileId: '1', fileMd5: 'aaaa', imageUrl: 'https://x/y' }],
      // 没有 imageList，只有 picture[] —— 但这里故意喂一个对象数组进 imageList
      imageList: [{ fileMd5: 'aaaa' }, { fileMd5: 'bbbb' }],
      materialSource: '希沃集控',
    },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, false, '对象数组必须被拒绝');
    assert.match(r.message, /imageList 不是数组|不是字符串|string\[\]/);
    assert.equal(env.calls.length, 0, '不合格时绝不能调用控制器');
  } finally { env.cleanup(); }
});

test('★ imageList 含非字符串元素时必须拒绝发送', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: null },
    lastPayload: { imageList: ['ok.jpg', 123, null], materialSource: '' },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, false);
    assert.match(r.message, /不是字符串/);
    assert.equal(env.calls.length, 0);
  } finally { env.cleanup(); }
});

test('校验通过时，交给控制器的载荷 imageList 一定是 string[]', () => {
  const env = boot({ realImageCount: 2 });
  try {
    const cfgImgs = env.realImages;
    const cfg = { screensaverEnabled: true, override: { imageList: cfgImgs, textList: [] } };
    fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify(cfg), 'utf8');
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    assert.equal(env.calls.length, 1);
    const sent = env.calls[0].data;
    assert.ok(Array.isArray(sent.imageList));
    sent.imageList.forEach(p => assert.equal(typeof p, 'string'));
    assert.equal(sent.imageList.length, 2);
  } finally { env.cleanup(); }
});

// ---------------------------------------------------------------------------
// B/C. 四级数据源
// ---------------------------------------------------------------------------

test('★ ④ 没有任何 override/集控数据时，从本地 screen_saver.json 预览（离线可用）', () => {
  const md5a = '4968945ad0a3d95b765bf9d630989247';
  const md5b = '4efee2e732c7126b67d57a3436c25ef7';
  const env = boot({
    config: { screensaverEnabled: true, override: null },
    screenSaver: {
      files: [md5a, md5b],
      json: {
        materialSource: '屏保功能来源于希沃集控',
        picture: [md5a, md5b],
        switchInterval: 5,
        pictureSizeType: 0,
        text: [],
      },
    },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, true, '应当能从本地缓存预览: ' + r.message);
    assert.equal(env.calls.length, 1);
    const d = env.calls[0].data;

    // md5 → screen_saver\<md5>，且必须是完整路径
    assert.equal(d.imageList.length, 2);
    d.imageList.forEach(p => {
      assert.equal(path.basename(p), p === d.imageList[0] ? md5a : md5b);
      assert.ok(path.isAbsolute(p), '必须是绝对路径: ' + p);
      assert.ok(p.includes('screen_saver'), '必须指向 screen_saver 目录: ' + p);
      assert.ok(fs.existsSync(p), '映射出来的文件应当真实存在: ' + p);
    });
    // 其它字段也要带过来
    assert.equal(d.materialSource, '屏保功能来源于希沃集控');
    assert.equal(d.switchInterval, 5);
    assert.equal(d.pictureSizeType, 0);
  } finally { env.cleanup(); }
});

test('③ 集控载荷是 picture[]（真实形态，没有 imageList）→ 映射到本地缓存', () => {
  const md5a = 'dda3f4413a1798a1c4013efd175cc35d';
  const env = boot({
    config: { screensaverEnabled: true, override: null },
    screenSaver: { files: [md5a], json: { picture: [md5a] } },
    lastPayload: {
      // 逐字取自 SeewoAbility.log 的真实结构
      picture: [{ fileId: '713209543528210432', fileMd5: md5a, fileUrlType: 1, imageUrl: 'https://ali-pro-pub.jikstatic.com/x' }],
      materialSource: '屏保功能来源于希沃集控',
      switchInterval: 8,
    },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    const d = env.calls[0].data;
    assert.equal(d.imageList.length, 1);
    assert.equal(path.basename(d.imageList[0]), md5a);
    assert.equal(d.switchInterval, 8);
  } finally { env.cleanup(); }
});

test('② 集控载荷已有合法 imageList 时优先用它', () => {
  const env = boot({
    config: { screensaverEnabled: true, override: null },
    lastPayload: { imageList: ['C:/cloud1.jpg', 'C:/cloud2.jpg'], materialSource: '集控', switchInterval: 20 },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(env.calls[0].data.imageList, ['C:/cloud1.jpg', 'C:/cloud2.jpg']);
    assert.equal(env.calls[0].data.switchInterval, 20);
  } finally { env.cleanup(); }
});

test('① 用户自定义图集优先级最高，压过集控和本地缓存', () => {
  const md5 = 'aaaa1111bbbb2222cccc3333dddd4444';
  const env = boot({ realImageCount: 1 });
  try {
    fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({
      screensaverEnabled: true,
      override: { imageList: env.realImages, textList: [] },
    }), 'utf8');
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(env.calls[0].data.imageList, env.realImages);
  } finally { env.cleanup(); }
});

test('⑤ 四种来源都不可用时给出可读错误，且逐项说明缺什么', () => {
  const env = boot({ config: { screensaverEnabled: true, override: null } });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-payload');
    assert.match(r.message, /没有可用的预览数据/);
    assert.match(r.message, /自定义图集/);
    assert.match(r.message, /集控/);
    assert.equal(env.calls.length, 0);
  } finally { env.cleanup(); }
});

// ---------------------------------------------------------------------------
// D. 路径形式
// ---------------------------------------------------------------------------

test('★ localUrlMode=file 时把 Windows 路径转成 file:/// 并 URL 编码', () => {
  const env = boot({ realImageCount: 1 });
  try {
    const winPath = 'D:\\杂项\\美化 背景\\自然-鸟.jpg';
    fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({
      screensaverEnabled: true,
      localUrlMode: 'file',
      override: { imageList: [winPath], textList: [] },
    }), 'utf8');
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    const sent = env.calls[0].data.imageList[0];
    assert.ok(sent.startsWith('file:///'), '应以 file:/// 开头: ' + sent);
    assert.ok(!sent.includes('\\'), '不应残留反斜杠: ' + sent);
    assert.ok(/%E6%9D%82%E9%A1%B9/.test(sent), '中文应按 UTF-8 百分号编码: ' + sent);
    assert.ok(/%20/.test(sent), '空格应编码为 %20: ' + sent);
    assert.ok(sent.includes('D:/'), '盘符应保留: ' + sent);
  } finally { env.cleanup(); }
});

test('localUrlMode=raw（默认）时路径原样保留反斜杠', () => {
  const env = boot({ realImageCount: 1 });
  try {
    const winPath = 'D:\\a\\b.jpg';
    fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({
      screensaverEnabled: true,
      override: { imageList: [winPath], textList: [] },
    }), 'utf8');
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    assert.equal(env.calls[0].data.imageList[0], winPath);
  } finally { env.cleanup(); }
});

test('已是 URL 的路径不会被 localUrlMode=file 二次处理', () => {
  const env = boot({ realImageCount: 1 });
  try {
    const url = 'https://ali-pro-pub.jikstatic.com/seewo-remote-v2/abc';
    fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({
      screensaverEnabled: true,
      localUrlMode: 'file',
      override: { imageList: [url], textList: [] },
    }), 'utf8');
    const r = env.g.control.preview();
    assert.equal(env.calls[0].data.imageList[0], url);
  } finally { env.cleanup(); }
});

test('部分图片文件不存在只警告、不阻断预览（存在性检查可能误判）', () => {
  const env = boot({ config: { screensaverEnabled: true, override: null } });
  try {
    fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({
      screensaverEnabled: true,
      override: { imageList: ['C:/definitely-not-here-1.jpg', 'C:/definitely-not-here-2.jpg'], textList: [] },
    }), 'utf8');
    const r = env.g.control.preview();
    assert.equal(r.ok, true, '不应因文件不存在而阻断: ' + r.message);
    assert.equal(env.calls.length, 1);
  } finally { env.cleanup(); }
});

// ---------------------------------------------------------------------------
// 与渲染器契约对齐
// ---------------------------------------------------------------------------

test('发出去的载荷字段类型符合渲染器契约', () => {
  const md5 = '11112222333344445555666677778888';
  const env = boot({
    config: { screensaverEnabled: true, override: null },
    screenSaver: {
      files: [md5],
      json: { materialSource: '屏保功能来源于希沃集控', picture: [md5], switchInterval: 5, pictureSizeType: 1, text: ['正文|出处'] },
    },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, true, r.message);
    const d = env.calls[0].data;
    assert.ok(Array.isArray(d.imageList));
    assert.ok(d.imageList.every(x => typeof x === 'string'), 'imageList 必须 string[]');
    assert.equal(typeof d.materialSource, 'string');
    assert.equal(typeof d.switchInterval, 'number');
    assert.ok(d.switchInterval > 0, 'switchInterval 必须是正数（渲染器内部 ×1000）');
    assert.ok(d.pictureSizeType === 0 || d.pictureSizeType === 1, 'pictureSizeType 只能是 0/1');
    assert.ok(Array.isArray(d.textList));
    if (d.textList.length) {
      assert.equal(typeof d.textList[0].content, 'string');
    }
  } finally { env.cleanup(); }
});
