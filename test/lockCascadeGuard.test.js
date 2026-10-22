'use strict';
/**
 * 「关屏保 → 自动锁屏」级联防护测试
 *
 * 覆盖现象（这是希沃屏保最核心的干扰来源）：
 *   官方 module 69 的 newWindow 里，给屏保窗口注册了
 *     win.on("close", () => { this.closeWindow(); this.startLock(); })
 *   → 用户一关屏保，官方立刻把屏幕锁打开。用户想「只看屏保/关掉不锁屏」时体验极差。
 *
 * 期望行为：
 *   - 默认（lockCascadeOnClose=false）：拦截级联，只关窗、不调用 startLock
 *   - 配置开启（true）：保留官方行为（startLock 被调用）
 *   - 只作用于 "screensaver" 窗口，绝不干扰 screenLock_* 自身的崩溃自愈回调
 *   - uninstall 后可完整回滚
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { LockCascadeGuard, SCREENSAVER_WINDOW_TYPE } = require('../src/hooks/lockCascadeGuard.js');
const { makeWindowManager, makeConfigManager } = require('./helpers/fixtures.js');

test('窗口类型常量应为 "screensaver"（官方 newWindow("screensaver", false)）', () => {
  assert.equal(SCREENSAVER_WINDOW_TYPE, 'screensaver');
});

test('默认拦截：屏保窗口 close 不再触发 startLock', () => {
  const wm = makeWindowManager();
  const guard = new LockCascadeGuard({
    windowManager: wm,
    configManager: makeConfigManager({ lockCascadeOnClose: false }),
  });

  wm.newWindow('screensaver', false);        // 官方 createScreensaverWindow 路径
  const win = wm.createdWindows[wm.createdWindows.length - 1];
  win.emit('close');                          // 模拟窗口被关闭

  assert.equal(wm.calls.startLock, 0, '★ 不应调用 startLock（级联已被拦截）');
  assert.ok(guard.getStatus().stats.suppressed >= 1, '应记录 1 次拦截');
});

test('配置开启时保留官方行为：close 仍会触发 startLock', () => {
  const wm = makeWindowManager();
  new LockCascadeGuard({
    windowManager: wm,
    configManager: makeConfigManager({ lockCascadeOnClose: true }),
  });

  wm.newWindow('screensaver', false);
  const win = wm.createdWindows[wm.createdWindows.length - 1];
  win.emit('close');

  assert.equal(wm.calls.startLock, 1, '配置允许时应保留官方级联');
});

test('绝不干扰非屏保窗口（例如 screenLock 自身的崩溃自愈）', () => {
  const wm = makeWindowManager();
  new LockCascadeGuard({
    windowManager: wm,
    configManager: makeConfigManager({ lockCascadeOnClose: false }),
  });

  wm.newWindow('screenLock', true);           // 非屏保窗口：应完全走原逻辑
  const win = wm.createdWindows[wm.createdWindows.length - 1];
  win.emit('close');

  assert.equal(wm.calls.startLock, 1, 'screenLock 窗口的 close 应保持官方行为（不被拦截）');
});

test('resetWindow 路径同样被保护（窗口销毁后重建）', () => {
  const wm = makeWindowManager();
  new LockCascadeGuard({
    windowManager: wm,
    configManager: makeConfigManager({ lockCascadeOnClose: false }),
  });

  wm.resetWindow('screensaver');
  const win = wm.createdWindows[wm.createdWindows.length - 1];
  win.emit('close');

  assert.equal(wm.calls.startLock, 0, 'resetWindow 注册的 close 也应被拦截');
});

test('uninstall 完整回滚 windowManager 方法', () => {
  const wm = makeWindowManager();
  const originalNew = wm.newWindow;
  const guard = new LockCascadeGuard({ windowManager: wm });

  assert.notEqual(wm.newWindow, originalNew, '安装后方法应被包装');
  guard.uninstall();
  assert.equal(wm.newWindow, originalNew, '卸载后应还原');

  // 回滚后级联行为恢复官方
  wm.newWindow('screensaver', false);
  const win = wm.createdWindows[wm.createdWindows.length - 1];
  win.emit('close');
  assert.equal(wm.calls.startLock, 1, '回滚后应恢复官方级联');
});

test('缺少 windowManager 时优雅降级（返回 false，不抛）', () => {
  assert.doesNotThrow(() => new LockCascadeGuard({}));
  const guard = new LockCascadeGuard({});
  assert.equal(guard.install(null), false);
});

test('幂等：同一 windowManager 重复 install 不叠加包装', () => {
  const wm = makeWindowManager();
  const guard = new LockCascadeGuard({ windowManager: wm });
  assert.equal(guard.install(wm), true, '重复安装应返回 true');
  wm.newWindow('screensaver', false);
  wm.createdWindows[wm.createdWindows.length - 1].emit('close');
  assert.equal(wm.calls.startLock, 0);
  assert.ok(guard.getStatus().stats.suppressed <= 2, '不应重复计数导致叠加');
});
