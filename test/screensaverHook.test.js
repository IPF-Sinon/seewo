'use strict';
/**
 * 屏保拦截核心测试
 *
 * 覆盖现象：
 *   1. 「禁用屏保」必须真的什么都不做 —— 不下发 screensaverMessage、不 share 转场、不入队。
 *      只关窗口是不够的：关窗口会触发官方 close 级联把屏幕锁打开（见 lockCascadeGuard 测试）。
 *   2. 「自定义图集」必须在放行的同时改写载荷，且字段名严格对齐渲染器契约。
 *   3. 转场数组长度必须 === imageList.length（否则轮播索引错位）。
 *   4. 非屏保路由绝不能被干扰（否则会误伤 SCREENLOCK / LIVE 等业务）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ScreensaverHook,
  SCREENSAVER_ROUTE,
  CHANNEL_MESSAGE,
  CHANNEL_TRANSITION,
  TASK,
} = require('../src/hooks/screensaverHook.js');
const { makeController, makeConfigManager } = require('./helpers/fixtures.js');

/** 组装一个已包装的 hook，返回 { hook, controller } */
function setup(config) {
  const controller = makeController();
  const hook = new ScreensaverHook({
    configManager: makeConfigManager(config),
    controller,
  });
  return { hook, controller };
}

/** 官方一条 /displayScreenSaver 消息的最小形态 */
function screenSaverMessage(imageList) {
  return {
    url: SCREENSAVER_ROUTE,
    data: {
      materialSource: '希沃集控',
      switchInterval: 15,
      pictureSizeType: 0,
      imageList: imageList || ['C:\\p1.png'],
      textList: [],
    },
  };
}

test('路由常量与通道名必须与官方原文一致', () => {
  assert.equal(SCREENSAVER_ROUTE, '/displayScreenSaver');
  assert.equal(CHANNEL_MESSAGE, 'screensaverMessage');
  assert.equal(CHANNEL_TRANSITION, 'screensaverTransitionList');
  assert.equal(TASK.SCREENSAVER, 'SCREENSAVER');
  assert.equal(TASK.SCREENLOCK, 'SCREENLOCK');
});

test('禁用屏保：消息被吞掉，不 share 也不入队', () => {
  const { hook, controller } = setup({ screensaverEnabled: false, override: null });

  controller.onMessage(screenSaverMessage());

  assert.equal(controller.calls.shared.length, 0, '不应 share 任何数据');
  assert.equal(controller.calls.enqueued.length, 0, '不应入队 SCREENSAVER');
  assert.equal(hook.getStatus().stats.blocked, 1, '应记录 1 次拦截');
});

test('启用且无 override：完整放行，行为与官方一致', () => {
  const { hook, controller } = setup({ screensaverEnabled: true, override: null });

  controller.onMessage(screenSaverMessage(['a.png', 'b.png']));

  const names = controller.calls.shared.map((c) => c.name);
  assert.ok(names.includes(CHANNEL_MESSAGE), '应下发 screensaverMessage');
  assert.ok(names.includes(CHANNEL_TRANSITION), '应下发 screensaverTransitionList');
  assert.equal(controller.calls.enqueued.length, 1, '应入队一次');
  assert.equal(controller.calls.enqueued[0].taskName, 'SCREENSAVER');
  assert.deepEqual(
    controller.calls.enqueued[0].taskDependencies,
    ['LIVE', 'SCHOOLANNOUNCEMENT'],
    '依赖必须与官方一致'
  );
});

test('自定义图集：载荷被改写为配置内容，且字段名对齐渲染器契约', () => {
  const { hook, controller } = setup({
    screensaverEnabled: true,
    override: {
      materialSource: '我的素材',
      switchInterval: 30,
      pictureSizeType: 1,
      imageList: ['C:\\my1.png', 'C:\\my2.png', 'C:\\my3.png'],
      textList: [{ content: '你好', provenance: '测试' }],
    },
  });

  controller.onMessage(screenSaverMessage(['old.png']));

  const msg = controller.calls.shared.find((c) => c.name === CHANNEL_MESSAGE);
  assert.ok(msg, '应下发 screensaverMessage');
  assert.equal(msg.data.materialSource, '我的素材');
  assert.equal(msg.data.switchInterval, 30, 'switchInterval 单位=秒，应原样下发');
  assert.equal(msg.data.pictureSizeType, 1, '数字索引 1=cover');
  assert.deepEqual(msg.data.imageList, ['C:\\my1.png', 'C:\\my2.png', 'C:\\my3.png']);
  assert.equal(msg.data.textList.length, 1);
  assert.equal(msg.data.textList[0].content, '你好');
  assert.equal(hook.getStatus().stats.overridden, 1);
});

test('转场数组长度必须等于 imageList.length（否则轮播索引错位）', () => {
  for (const n of [1, 3, 7]) {
    const images = Array.from({ length: n }, (_, i) => 'p' + i + '.png');
    const { controller } = setup({
      screensaverEnabled: true,
      override: { imageList: images, transitionList: null },
    });
    controller.onMessage(screenSaverMessage());
    const tr = controller.calls.shared.find((c) => c.name === CHANNEL_TRANSITION);
    assert.ok(tr, '应下发转场列表');
    assert.equal(tr.data.length, n, '转场长度应 == 图片数 ' + n);
  }
});

test('转场值域被约束在 0..6', () => {
  const { controller } = setup({
    screensaverEnabled: true,
    override: {
      imageList: ['a.png', 'b.png', 'c.png', 'd.png'],
      transitionList: [99, -5, 6, 0], // 越界值应被 clamp
    },
  });
  controller.onMessage(screenSaverMessage());
  const tr = controller.calls.shared.find((c) => c.name === CHANNEL_TRANSITION);
  assert.equal(tr.data.length, 4);
  for (const v of tr.data) {
    assert.ok(v >= 0 && v <= 6, '转场值应在 0..6，实际 ' + v);
  }
});

test('改写后的 message.data 必须与 override 一致（经 rewriteMessage 直测）', () => {
  const hook = new ScreensaverHook({ configManager: makeConfigManager({ override: null }) });
  const out = hook.rewriteMessage(screenSaverMessage(['x.png']), { switchInterval: 9 });
  assert.equal(out.data.switchInterval, 9);
});

test('非屏保路由完全不受影响（不误伤其它业务）', () => {
  const { hook, controller } = setup({ screensaverEnabled: false, override: null });
  const other = { url: '/displayScreenLock', data: { screenLockStatus: 1 } };

  let proceeded = false;
  const handled = hook.handleMessage(other, () => { proceeded = true; });

  assert.equal(handled, true, '非屏保路由应放行');
  assert.equal(proceeded, true, '应调用放行回调');
  assert.equal(hook.getStatus().stats.blocked, 0, '不应记为拦截');
  assert.equal(controller.calls.shared.length, 0);
});

test('wrap 幂等：重复包装同一个控制器不会重复处理', () => {
  const controller = makeController();
  const hook = new ScreensaverHook({ configManager: makeConfigManager({ screensaverEnabled: true, override: null }) });

  assert.equal(hook.wrap(controller), true);
  assert.equal(hook.wrap(controller), true, '重复 wrap 应返回 true 且不叠加');
  hook.handleMessage(screenSaverMessage(), () => controller.calls.enqueued.push({ taskName: 'SCREENSAVER' }));
  assert.equal(controller.calls.enqueued.length, 1, '只应入队一次');
});

test('uninstall 完整回滚到官方 onMessage', () => {
  const controller = makeController();
  const original = controller.onMessage;
  const hook = new ScreensaverHook({ configManager: makeConfigManager({ screensaverEnabled: false, override: null }) });

  hook.wrap(controller);
  assert.notEqual(controller.onMessage, original, '包装后应不同');
  hook.uninstall();
  assert.equal(controller.onMessage, original, '卸载后应还原为原始函数');
});

test('控制器缺少 onMessage 时优雅降级（返回 false，不抛）', () => {
  const hook = new ScreensaverHook({ configManager: makeConfigManager({}) });
  assert.equal(hook.wrap({}), false);
  assert.equal(hook.wrap(null), false);
});

test('无 configManager 时退回默认配置，不抛异常', () => {
  const controller = makeController();
  const hook = new ScreensaverHook({ controller });
  assert.doesNotThrow(() => controller.onMessage(screenSaverMessage()));
  assert.equal(controller.calls.enqueued.length, 1, '默认放行');
});
