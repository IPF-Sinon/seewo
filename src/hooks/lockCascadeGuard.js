'use strict';
/**
 * src/hooks/lockCascadeGuard.js —— 拦截「屏保窗口 close → startLock()」级联
 *
 * ★ 根因依据（main.js @76173，webpack module 69 窗口管理器 newWindow 原文）：
 *
 *   newWindow(e, t = !0) {
 *     const { screen: c } = n(0);
 *     let u = c.getAllDisplays();
 *     t && r.SetKeyboardHook();
 *     for (let t = 0; t < u.length; t++) {
 *       ...
 *       let r = s.addOne(e, e + "_" + t);          // 窗口名 "screensaver_0" / "screensaver_1"
 *       this.windowsList[e].push(e + "_" + t);
 *       r.setBounds({ width, height, x, y });
 *       r.show();
 *       r.on("close", () => {                       // ★ 级联入口
 *         setTimeout(() => { this.closeWindow(); this.startLock(); }, 0)
 *       });
 *     }
 *   }
 *
 *   同一个 module 69 的 resetWindow() 里也有等价回调（窗口被销毁后重建路径）。
 *
 * ★ 另一条等价路径（main.js @44706，屏幕锁模块自己的窗口）：
 *   r.on("close", () => { a.error("screenLock_"+e+"窗口崩溃了"),
 *                         setTimeout(() => { this.closeWindow(), this.startLock() }, 0) })
 *
 * 这是「关掉屏保就自动锁屏」的根因：我们吞掉 /displayScreenSaver 只是不让它启动，
 * 但用户手动点屏幕（渲染器发 closeScreenSaver）或窗口被销毁时，
 * 官方 close 回调依然会把屏保关掉并立即进入 SCREENLOCK。
 *
 * 本模块的做法：包装窗口管理器的 newWindow / resetWindow，
 * 对屏保窗口注册的 close 回调做**替换**（而不是叠加），
 * 使其只关窗、不调用 startLock。
 *
 * 设计原则：
 *   - 不修改官方源码文本，只在运行期替换回调引用 —— 可完全回滚。
 *   - 只影响 e === "screensaver" 的窗口，绝不动 screenLock_* 自身窗口的 close 回调
 *     （那才是锁屏自己的崩溃自愈逻辑，动了会导致锁屏窗口崩溃后无法恢复）。
 *   - 所有依赖注入，找不到就降级为不修改。
 */

/** 屏保窗口的类别名（main.js newWindow("screensaver", !1) 的第一个参数） */
const SCREENSAVER_WINDOW_TYPE = 'screensaver';

/** 窗口名规则：类别 + "_" + 显示器序号，如 screensaver_0（main.js 原文） */
const WINDOW_NAME_RE = /^screensaver_\d+$/;

function noopLogger() {
  const noop = function () {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: function () { return noopLogger(); } };
}

/**
 * 判断某个「窗口管理器的私有方法」是否属于屏保窗口。
 *
 * 判定顺序：
 *   1) 显式传入的 typeHint（包装时已知的参数）优先；
 *   2) 用 this.windowsList[...] 的内容匹配 screensaver_<n>；
 *   3) 用 closeWindow 的调用记录回溯（见 isScreensaverCloseCallback）。
 *
 * @param {object} thisArg 被包装方法运行时的 this（窗口管理器实例）
 * @param {string} [typeHint]
 * @returns {boolean}
 */
function looksLikeScreensaverContext(thisArg, typeHint) {
  if (typeHint === SCREENSAVER_WINDOW_TYPE) return true;
  if (!thisArg || typeof thisArg !== 'object') return false;
  const list = thisArg.windowsList;
  if (list && typeof list === 'object') {
    if (Array.isArray(list[SCREENSAVER_WINDOW_TYPE]) && list[SCREENSAVER_WINDOW_TYPE].length > 0) {
      return true;
    }
    for (const key of Object.keys(list)) {
      if (key === SCREENSAVER_WINDOW_TYPE) return true;
    }
  }
  return false;
}

/**
 * 判断一个 close 回调是否是「窗口管理器注册的级联回调」。
 *
 * 官方回调的源码特征（逐字）：
 *   () => { setTimeout(() => { this.closeWindow(), this.startLock() }, 0) }
 * 注意：被 packer 压缩后箭头函数参数名会变，因此**不能**靠参数名匹配；
 * 可靠做法是看函数源码里同时出现 closeWindow 与 startLock。
 *
 * @param {Function} fn
 * @returns {boolean}
 */
function isCascadeCloseCallback(fn) {
  if (typeof fn !== 'function') return false;
  const src = Function.prototype.toString.call(fn);
  // 官方回调必然同时引用这两个方法（顺序可能因压缩而不同）
  const hasClose = src.indexOf('closeWindow') !== -1;
  const hasLock = src.indexOf('startLock') !== -1;
  // 排除锁屏窗口自己的崩溃自愈回调：它带 "窗口崩溃了" 文案
  const isScreenLockSelfHeal = src.indexOf('窗口崩溃了') !== -1;
  return hasClose && hasLock && !isScreenLockSelfHeal;
}

/**
 * LockCascadeGuard —— 阻止屏保关闭后级联进入屏幕锁。
 */
class LockCascadeGuard {
  /**
   * @param {object} options
   * @param {object} [options.configManager] 读取 lockCascadeOnClose（true = 保留官方级联行为）
   * @param {object} [options.logger]
   * @param {object} [options.windowManager] module 69 窗口管理器的实例（注入）
   * @param {Function} [options.onBlocked] 拦截回调（审计）
   */
  constructor(options) {
    const opts = options || {};
    this.configManager = opts.configManager || null;
    this.log = opts.logger || noopLogger();
    this.windowManager = opts.windowManager || null;
    this.onBlocked = typeof opts.onBlocked === 'function' ? opts.onBlocked : null;

    /** 原始方法引用，供卸载时还原 */
    this.originals = null;
    this.installed = false;
    this.stats = { suppressed: 0, allowed: 0, examined: 0 };
    if (this.windowManager) this.install(this.windowManager);
  }

  /** 读取配置：lockCascadeOnClose 为 true 时表示「保留官方级联行为」 */
  isCascadeEnabled() {
    if (this.configManager && typeof this.configManager.getConfig === 'function') {
      try {
        const cfg = this.configManager.getConfig();
        return cfg.lockCascadeOnClose === true;
      } catch (_) { /* fallthrough */ }
    }
    return false; // 默认拦截（对应 DEFAULT_CONFIG.lockCascadeOnClose = false）
  }

  /**
   * 安装守卫。
   *
   * 实现方式：同时包装 newWindow 与 resetWindow，
   * 在它们执行期间把「注册到屏保窗口上的 close 回调」替换掉。
   *
   * 之所以不直接遍历 windowsList 去 off('close')：
   *   Electron 的 removeListener 需要拿到原始回调引用，而官方回调是内联箭头函数、
   *   外部拿不到；且 windowsList 里存的是窗口名而非窗口对象。
   *   因此最稳妥的做法是在**注册的那一刻**就决定这个回调是什么。
   *
   * 具体做法：临时介入 addOne（窗口工厂）返回的对象，包装它的 on('close')。
   *
   * @param {object} windowManager module 69 实例
   * @returns {boolean}
   */
  install(windowManager) {
    if (!windowManager || typeof windowManager !== 'object') {
      this.log.warn('安装级联守卫失败：未提供窗口管理器，降级为不修改');
      return false;
    }
    if (this.installed && this.windowManager === windowManager) {
      this.log.debug('级联守卫已安装（幂等）');
      return true;
    }
    if (this.installed) this.uninstall();

    this.windowManager = windowManager;
    this.originals = {
      newWindow: windowManager.newWindow,
      resetWindow: windowManager.resetWindow,
    };
    const self = this;

    const wrapMethod = function (name) {
      const original = windowManager[name];
      if (typeof original !== 'function') return;
      windowManager[name] = function (type) {
        const args = Array.prototype.slice.call(arguments);
        // 只有屏保窗口才需要介入；其它窗口（seewoDesktop / screenLock / assistant）
        // 完全走原始逻辑，零影响。
        if (type !== SCREENSAVER_WINDOW_TYPE) {
          return original.apply(this, args);
        }
        return self._invokeWithGuard(this, original, args);
      };
    };
    wrapMethod('newWindow');
    wrapMethod('resetWindow');

    this.installed = true;
    this.log.info('级联锁屏守卫已安装：已包装 newWindow/resetWindow（仅作用于 "' + SCREENSAVER_WINDOW_TYPE + '" 窗口）');
    return true;
  }

  /**
   * 在受控环境下执行官方方法：把 addOne 临时包一层，
   * 拦截它返回的窗口对象上的 on('close', cb)，替换掉级联回调。
   *
   * @private
   */
  _invokeWithGuard(ctx, original, args) {
    const self = this;
    const wm = ctx;
    const originalAddOne = wm.addOne;
    if (typeof originalAddOne !== 'function') {
      // 拿不到窗口工厂：降级，直接原样执行（不修改行为）
      this.log.warn('无法包装 addOne（窗口工厂缺失），本次不干预');
      return original.apply(ctx, args);
    }

    wm.addOne = function () {
      const addArgs = Array.prototype.slice.call(arguments);
      const win = originalAddOne.apply(this, addArgs);
      return self._guardWindow(win);
    };
    try {
      return original.apply(ctx, args);
    } finally {
      // 无论成功失败都还原 addOne，避免污染其它窗口路径
      wm.addOne = originalAddOne;
    }
  }

  /**
   * 包装单个窗口对象的 on('close')。
   *
   * @private
   * @param {object} win 官方窗口对象（通常 Electron BrowserWindow）
   * @returns {object} 同一个对象（已可能被包装）
   */
  _guardWindow(win) {
    if (!win || typeof win !== 'object' || typeof win.on !== 'function') return win;
    if (win.__auraCascadeGuarded) return win; // 幂等
    const self = this;
    const originalOn = win.on;
    win.on = function (event, handler) {
      const args = Array.prototype.slice.call(arguments);
      if (event !== 'close') return originalOn.apply(this, args);
      self.stats.examined++;
      if (!isCascadeCloseCallback(handler)) {
        // 不是级联回调：原样放行（例如用户自定义的日志回调）
        return originalOn.apply(this, args);
      }
      if (self.isCascadeEnabled()) {
        // 配置要求保留级联：放行官方行为
        self.stats.allowed++;
        self.log.debug('级联锁屏：配置允许，保留官方 close→startLock 行为');
        return originalOn.apply(this, args);
      }
      // ★ 拦截：注册一个只关窗、不锁屏的回调
      self.stats.suppressed++;
      self.log.info('已拦截屏保窗口 close 级联：不再调用 startLock()');
      if (self.onBlocked) {
        try { self.onBlocked({ window: win, handler: handler }); } catch (_) { /* 审计失败不影响主流程 */ }
      }
      const safeHandler = function () {
        try {
          if (typeof win.close === 'function' && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
            win.close();
          }
        } catch (err) {
          self.log.warn('安全关闭屏保窗口失败: ' + err.message);
        }
      };
      return originalOn.call(this, event, safeHandler);
    };
    win.__auraCascadeGuarded = true;
    return win;
  }

  /**
   * 卸载守卫，还原官方方法引用（完整回滚）。
   * @returns {boolean}
   */
  uninstall() {
    if (this.windowManager && this.originals) {
      if (typeof this.originals.newWindow === 'function') {
        this.windowManager.newWindow = this.originals.newWindow;
      }
      if (typeof this.originals.resetWindow === 'function') {
        this.windowManager.resetWindow = this.originals.resetWindow;
      }
      this.log.info('级联锁屏守卫已卸载，已还原官方 windowManager 方法');
    }
    this.originals = null;
    this.installed = false;
    return true;
  }

  /** 运行期状态快照 */
  getStatus() {
    return {
      installed: this.installed,
      cascadeEnabled: this.isCascadeEnabled(),
      windowType: SCREENSAVER_WINDOW_TYPE,
      stats: Object.assign({}, this.stats),
    };
  }
}

module.exports = {
  LockCascadeGuard: LockCascadeGuard,
  SCREENSAVER_WINDOW_TYPE: SCREENSAVER_WINDOW_TYPE,
  WINDOW_NAME_RE: WINDOW_NAME_RE,
  isCascadeCloseCallback: isCascadeCloseCallback,
  looksLikeScreensaverContext: looksLikeScreensaverContext,
};
