'use strict';
/**
 * 预览/控制通道测试（针对真实注入产物 tools/payload/aura-screensaver-loader.js）
 *
 * 覆盖现象：
 *   1. 「立即预览」必须真的把 /displayScreenSaver 交给官方控制器，且用当前配置渲染。
 *   2. 手动预览必须能绕过 screensaverEnabled=false —— 否则「关了屏保想看看效果」是死路。
 *   3. 没有控制器 / 没有图片 / 没有数据时必须返回结构化失败，绝不能弹空白屏保或抛异常。
 *   4. GUI 是独立进程，靠 command.json 命令桥与主进程通信；同一 seq 只能执行一次。
 *   5. reloadConfig 必须免重启生效（原地改写配置对象，让所有闭包看到新值）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOADER = path.join(__dirname, '..', 'tools', 'payload', 'aura-screensaver-loader.js');

/** 造一个独立的「管家主进程」环境，返回 { g, controller, calls, shared, dataDir } */
function bootLoader(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-preview-'));
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

  const calls = [];
  const shared = [];
  const controller = {
    onMessage(msg) { calls.push({ fn: 'onMessage', msg }); },
    startScreensaver() { calls.push({ fn: 'startScreensaver' }); },
    stopScreensaver() { calls.push({ fn: 'stopScreensaver' }); },
  };
  if (opts.lastPayload) controller.__auraLastPayload = opts.lastPayload;
  const share = { share(k, v) { shared.push({ k, v }); } };
  const windowManager = { newWindow() {}, closeWindow() {}, resetWindow() {} };
  const lockController = { startLock() {}, startLockTask() {}, userLock() {} };

  delete global.__AURA_SCREENSAVER__;
  global.__AURA_REQ__ = function (id) {
    if (id === 120) { if (opts.noController) throw new Error('no module 120'); return controller; }
    if (id === 69) return windowManager;
    if (id === 2) return share;
    if (id === 40) return lockController;
    throw new Error('no module ' + id);
  };

  delete require.cache[require.resolve(LOADER)];
  require(LOADER);

  const g = global.__AURA_SCREENSAVER__;
  return {
    g, controller, calls, shared, dataDir, tmp,
    cleanup() {
      delete global.__AURA_SCREENSAVER__;
      delete global.__AURA_REQ__;
      if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
      if (prevCfgEnv !== undefined) process.env.AURA_SCREENSAVER_CONFIG = prevCfgEnv;
      if (prevHome !== undefined) process.env.USERPROFILE = prevHome;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

const OVERRIDE_CONFIG = {
  screensaverEnabled: false,
  lockCascadeOnClose: false,
  override: {
    materialSource: '七班素材',
    switchInterval: 20,
    pictureSizeType: 1,
    imageList: ['C:/p1.jpg', 'C:/p2.jpg', 'C:/p3.jpg'],
    textList: [{ content: '今日值日：李同学' }],
    transitionList: [1, 2, 3],
  },
};

test('控制对象已挂到全局，包含 preview/stop/reloadConfig/getState', () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    assert.equal(env.g.installed, true);
    assert.equal(typeof env.g.control, 'object');
    for (const k of ['preview', 'stop', 'reloadConfig', 'getState']) {
      assert.equal(typeof env.g.control[k], 'function', '缺少 control.' + k);
    }
  } finally { env.cleanup(); }
});

test('preview 用当前配置唤起屏保：路由、字段、图片数都正确', () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'override');
    assert.equal(r.imageCount, 3);

    const om = env.calls.find((c) => c.fn === 'onMessage');
    assert.ok(om, '必须调用官方控制器 onMessage');
    assert.equal(om.msg.url, '/displayScreenSaver');
    assert.equal(om.msg.data.materialSource, '七班素材');
    assert.equal(om.msg.data.switchInterval, 20);
    assert.equal(om.msg.data.pictureSizeType, 1);
    assert.deepEqual(om.msg.data.imageList, ['C:/p1.jpg', 'C:/p2.jpg', 'C:/p3.jpg']);
    assert.equal(om.msg.data.textList[0].content, '今日值日：李同学');
  } finally { env.cleanup(); }
});

test('★ preview 必须能绕过 screensaverEnabled=false', () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    assert.equal(env.g.control.getState().config.screensaverEnabled, false);
    const r = env.g.control.preview();
    assert.equal(r.ok, true, '关闭屏保时手动预览仍应工作');
    assert.ok(env.calls.some((c) => c.fn === 'onMessage'));
    // 拦截计数不应因为这次预览而增加
    assert.equal(env.g.state.blocked, 0);
  } finally { env.cleanup(); }
});

test('官方 /displayScreenSaver 在关闭态下仍被拦截（预览不影响正常拦截）', () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    const before = env.calls.length;
    env.controller.onMessage({ url: '/displayScreenSaver', data: { imageList: ['x.jpg'] } });
    assert.equal(env.calls.length, before, '关闭态下官方消息不应被转发');
    assert.equal(env.g.state.blocked, 1);
  } finally { env.cleanup(); }
});

test('转场数组长度必须等于图片数（与 imageList 对齐）', () => {
  const env = bootLoader({
    config: {
      screensaverEnabled: true,
      override: {
        imageList: ['a.jpg', 'b.jpg'],
        switchInterval: 10,
        pictureSizeType: 0,
        transitionList: [0, 5],
      },
    },
  });
  try {
    env.g.control.preview();
    const tr = env.shared.filter((s) => s.k === 'screensaverTransitionList').pop();
    assert.ok(tr, '必须广播转场数组');
    assert.equal(tr.v.length, 2);
    for (const v of tr.v) assert.ok(v >= 0 && v <= 6, '值域必须 0..6');
  } finally { env.cleanup(); }
});

test('没有控制器时 preview 返回结构化失败，不抛异常', () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG, noController: true });
  try {
    let r;
    assert.doesNotThrow(() => { r = env.g.control.preview(); });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-controller');
  } finally { env.cleanup(); }
});

test('★ override 有值但图片为空 → 继续回落其它数据源，全都没有才报错', () => {
  // 行为变更（修复「override 为空就说没有可用预览数据」）：
  // 自定义图集为空不再直接判死，而是依次尝试
  //   ②集控最后下发 ③picture[] 映射 ④本地 screen_saver.json
  // 这样用户「没配图集也想知道屏保长什么样」有路可走。
  // 本用例环境里 ②③④ 都没有 → 最终仍是失败，且错误信息要提到空图集。
  const env = bootLoader({
    config: { screensaverEnabled: true, override: { imageList: [], textList: [] } },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-payload');
    assert.match(r.message, /图片列表是空的/, '错误信息应说明自定义图集为空');
    assert.equal(env.calls.length, 0, '失败时不应调用控制器');
  } finally { env.cleanup(); }
});

test('override 为 null 时回落到上次集控下发的载荷', () => {
  const env = bootLoader({
    config: { screensaverEnabled: true, override: null },
    lastPayload: { imageList: ['cloud1.jpg', 'cloud2.jpg'], switchInterval: 15, pictureSizeType: 0, materialSource: '希沃集控' },
  });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'last-payload');
    const om = env.calls.find((c) => c.fn === 'onMessage');
    assert.deepEqual(om.msg.data.imageList, ['cloud1.jpg', 'cloud2.jpg']);
  } finally { env.cleanup(); }
});

test('override 为 null 且无历史载荷 → no-payload', () => {
  const env = bootLoader({ config: { screensaverEnabled: true, override: null } });
  try {
    const r = env.g.control.preview();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-payload');
  } finally { env.cleanup(); }
});

test('stop() 调用官方 stopScreensaver', () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    const r = env.g.control.stop();
    assert.equal(r.ok, true);
    assert.ok(env.calls.some((c) => c.fn === 'stopScreensaver'));
  } finally { env.cleanup(); }
});

test('★ reloadConfig 免重启生效（原地改写，闭包可见）', () => {
  const env = bootLoader({ config: { screensaverEnabled: false, override: null } });
  try {
    assert.equal(env.g.control.getState().config.screensaverEnabled, false);

    fs.writeFileSync(
      path.join(env.dataDir, 'config.json'),
      JSON.stringify({ screensaverEnabled: true, override: null }),
      'utf8'
    );

    const r = env.g.control.reloadConfig();
    assert.equal(r.ok, true);
    assert.equal(r.config.screensaverEnabled, true);
    assert.equal(env.g.control.getState().config.screensaverEnabled, true);

    // 配置真的生效了：官方消息现在应该被放行
    env.controller.onMessage({ url: '/displayScreenSaver', data: { imageList: ['y.jpg'] } });
    assert.equal(env.g.state.blocked, 0, '开启后不应再拦截');
  } finally { env.cleanup(); }
});

test('命令桥：写 command.json 会被消费并回写 command-result.json', async () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    const cmdFile = path.join(env.dataDir, 'command.json');
    const resFile = path.join(env.dataDir, 'command-result.json');
    const seq = Date.now();
    fs.writeFileSync(cmdFile, JSON.stringify({ seq, cmd: 'preview', args: {} }), 'utf8');

    const deadline = Date.now() + 4000;
    let result = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(resFile)) {
        const parsed = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        if (Number(parsed.seq) === seq) { result = parsed; break; }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(result, '命令桥必须在超时前回写结果');
    assert.equal(result.cmd, 'preview');
    assert.equal(result.ok, true);
    assert.equal(result.source, 'override');
  } finally { env.cleanup(); }
});

test('命令桥：未知命令返回 unknown-command，而不是静默失败', async () => {
  const env = bootLoader({ config: OVERRIDE_CONFIG });
  try {
    const cmdFile = path.join(env.dataDir, 'command.json');
    const resFile = path.join(env.dataDir, 'command-result.json');
    const seq = Date.now();
    fs.writeFileSync(cmdFile, JSON.stringify({ seq, cmd: 'dropDatabase', args: {} }), 'utf8');

    const deadline = Date.now() + 4000;
    let result = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(resFile)) {
        const parsed = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        if (Number(parsed.seq) === seq) { result = parsed; break; }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(result);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown-command');
  } finally { env.cleanup(); }
});
