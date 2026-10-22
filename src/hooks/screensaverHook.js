'use strict';
/**
 * src/hooks/screensaverHook.js —— 屏保拦截核心
 *
 * ★ 全部行为依据 main.js @159264 的屏保控制器原文：
 *
 *   const s=n(38), r=n(2), o=n(39), i=n(69), a=n(297), c="/displayScreenSaver";
 *   const u = new class {
 *     onMessage(e) {
 *       e.url === c && (
 *         r.share("screensaverTransitionList",
 *           ((e, t = 7) => { let n = [];
 *              for (let s = 0; s < e; s++) n.push(Math.floor(Math.random() * t));
 *              return n; })(e.data.imageList.length)),
 *         r.share("screensaverMessage", e.data),
 *         o.enQueue({
 *           taskName: s.SCREENSAVER,
 *           taskDependencies: [s.LIVE, s.SCHOOLANNOUNCEMENT],
 *           startTask:    this.startScreensaver,
 *           pauseTask:    this.closeWindow,
 *           coutinueTask: this.startScreensaver,   // ← 官方拼写错误，必须原样保留
 *           closedTask:   this.stopScreensaver,
 *           error: () => { o.outQueue(s.SCREENSAVER) }
 *         })
 *       );
 *     }
 *     startScreensaver() { i.newWindow("screensaver", !1); }
 *     stopScreensaver()  { this.closeWindow(); r.share("screensaverTransitionList", null); a(); o.outQueue(s.SCREENSAVER); }
 *     closeWindow()      { i.closeWindow("screensaver", !1); }
 *     onLink()           { a(); }
 *   };
 *
 * 三个必须实现的语义（task-2 硬要求）：
 *   1. 配置禁用时：**吞掉** /displayScreenSaver —— 不 share、不入队、不 newWindow。
 *   2. 自定义图集时：改写 share("screensaverMessage") 的 data，
 *      字段名严格对齐 RENDERER_CONTRACT.md（materialSource/switchInterval/
 *      pictureSizeType/imageList/textList），不自创命名。
 *   3. 转场：保持 transitionList.length === imageList.length 且值域 0..6。
 *
 * 依赖全部注入（queue/share/windowManager/logger），因此本文件可被单测直接 require，
 * 不需要 electron，也不需要真实 bundle。
 */

const schema = require('../config/schema.js');

/** 触发屏保的唯一路由（main.js 原文） */
const SCREENSAVER_ROUTE = '/displayScreenSaver';

/** 跨窗口共享总线通道名（main.js 原文） */
const CHANNEL_MESSAGE = 'screensaverMessage';
const CHANNEL_TRANSITION = 'screensaverTransitionList';

/** 任务类型常量，逐字来自 webpack module 38 */
const TASK = Object.freeze({
  SCREENLOCK: 'SCREENLOCK',
  SCHOOLANNOUNCEMENT: 'SCHOOLANNOUNCEMENT',
  LIVE: 'LIVE',
  SCREENSAVER: 'SCREENSAVER',
  POPUP_NOTIFICATION: 'POPUP_NOTIFICATION',
});

/** 转场值域上界：官方 Math.random() * 7 → 0..6 */
const TRANSITION_MAX = schema.TRANSITION_MAX;

/** 未注入 logger 时的空实现 */
function noopLogger() {
  const noop = function () {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: function () { return noopLogger(); } };
}

/**
 * 按官方算法生成转场列表。
 * 逐字对应 main.js：
 *   ((e, t = 7) => { let n = []; for (let s = 0; s < e; s++) n.push(Math.floor(Math.random() * t)); return n; })
 *
 * @param {number} count 图片数量（= imageList.length）
 * @param {number} [max=7] 上界（不含）
 * @returns {number[]} 长度恰好为 count 的数组
 */
function generateTransitionList(count, max) {
  const n = Math.floor(count) || 0;
  const t = max === undefined ? TRANSITION_MAX + 1 : max;
  const out = [];
  for (let s = 0; s < n; s++) out.push(Math.floor(Math.random() * t));
  return out;
}

/**
 * 把任意转场列表规整为「长度 === imageCount、值域 0..6」。
 * ★ 对齐 RENDERER_CONTRACT.md 易错点 1/2：长度不一致会导致轮播索引错位。
 *
 * 规则：
 *   - null/undefined/非数组 -> 用官方随机算法重新生成
 *   - 长度不足 -> 用随机值补齐；长度超出 -> 截断
 *   - 值非法 -> clamp 到 0..6（负数归 0）
 *
 * @returns {number[]}
 */
function normalizeTransitionList(list, imageCount) {
  const count = Math.max(0, Math.floor(imageCount) || 0);
  if (!Array.isArray(list)) return generateTransitionList(count);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i < list.length) {
      let v = list[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) v = Math.floor(Math.random() * (TRANSITION_MAX + 1));
      v = Math.floor(v);
      if (v < 0) v = 0;
      if (v > TRANSITION_MAX) v = TRANSITION_MAX;
      out.push(v);
    } else {
      out.push(Math.floor(Math.random() * (TRANSITION_MAX + 1)));
    }
  }
  return out;
}

/**
 * 把配置里的 override 应用到原始 screensaverMessage 载荷上。
 * 只覆盖配置显式提供的字段，保留云端下发的其余字段。
 *
 * ★ 字段契约来自 RENDERER_CONTRACT.md / screensaver.js @5438：
 *     y(data.materialSource || "")
 *     f(1000 * (data.switchInterval || 15))       // 秒
 *     x(D[data.pictureSizeType || 0])             // 0|1
 *     s(data.imageList.map(p => p.replace(/\\/g,"\\\\")))
 *     C(data.textList || [])
 *
 * @param {object} original 云端下发的 e.data
 * @param {object|null} override 配置里的 override 块
 * @returns {object} 新的载荷对象（不修改入参）
 */
function applyOverride(original, override) {
  const base = (original && typeof original === 'object') ? original : {};
  const data = Object.assign({}, base);
  if (!override) return data;

  if (typeof override.materialSource === 'string') {
    data.materialSource = override.materialSource;
  }
  // switchInterval 单位是秒，渲染器内部 ×1000，这里不要换算
  if (typeof override.switchInterval === 'number' && override.switchInterval > 0) {
    data.switchInterval = override.switchInterval;
  }
  // pictureSizeType 是数字索引 0|1
  if (override.pictureSizeType === 0 || override.pictureSizeType === 1) {
    data.pictureSizeType = override.pictureSizeType;
  }
  if (Array.isArray(override.imageList) && override.imageList.length > 0) {
    data.imageList = override.imageList.slice();
  }
  if (Array.isArray(override.textList) && override.textList.length > 0) {
    data.textList = override.textList.map(function (t) {
      return Object.assign({}, t);
    });
  }
  return data;
}

/**
 * ScreensaverHook —— 包装官方屏保控制器。
 *
 * 两种工作模式（与 HugoAura-Enhanced 的注入思路一致，但这里保持纯函数式、可测试）：
 *   A. wrap(controller)：拿到真实的控制器实例，包装它的 onMessage；
 *   B. createMessageInterceptor()：拿不到实例时，提供一个纯函数供上层在最外层拦截消息。
 */
class ScreensaverHook {
  /**
   * @param {object} options
   * @param {object} [options.configManager] ConfigManager 实例（读取实时配置）
   * @param {object} [options.logger] 日志器
   * @param {object} [options.queue] 任务队列桩，需有 enQueue/outQueue
   * @param {object} [options.share] 广播总线桩，需有 share(name, data, windowName?)
   * @param {object} [options.windowManager] 窗口管理桩，需有 newWindow/closeWindow
   * @param {object} [options.controller] 可选：直接注入真实控制器
   * @param {Function} [options.onBlock] 拦截回调（审计用）
   */
  constructor(options) {
    const opts = options || {};
    this.configManager = opts.configManager || null;
    this.log = opts.logger || noopLogger();
    this.queue = opts.queue || null;
    this.share = opts.share || null;
    this.windowManager = opts.windowManager || null;
    this.onBlock = typeof opts.onBlock === 'function' ? opts.onBlock : null;

    /** 原始（未被包装的）onMessage，供卸载时还原 */
    this.originalOnMessage = null;
    /** 被包装的控制器实例 */
    this.controller = null;
    /** 统计信息，供 IPC status 使用 */
    this.stats = {
      intercepted: 0,   // 收到 /displayScreenSaver 的次数
      blocked: 0,       // 因禁用被吞掉的次数
      overridden: 0,    // 应用了自定义图集的次数
      started: 0,       // 实际放行启动的次数
    };
    if (opts.controller) this.wrap(opts.controller);
  }

  /** 读取当前配置（configManager 缺失时退回默认值，保证不抛） */
  getConfig() {
    if (this.configManager && typeof this.configManager.getConfig === 'function') {
      try { return this.configManager.getConfig(); } catch (_) { /* fallthrough */ }
    }
    return schema.deepClone(schema.DEFAULT_CONFIG);
  }

  /**
   * 断点 A：包装真实控制器实例的 onMessage。
   *
   * 幂等：重复 wrap 同一个实例不会叠加包装（否则一次消息会被处理多次）。
   * 可回滚：uninstall() 会把 onMessage 还原成原始函数。
   *
   * @param {object} controller 官方屏保控制器实例
   * @returns {boolean} 是否成功包装
   */
  wrap(controller) {
    if (!controller || typeof controller.onMessage !== 'function') {
      this.log.warn('wrap 失败：控制器缺少 onMessage，降级为不修改（放行原行为）');
      return false;
    }
    if (this.controller === controller) {
      this.log.debug('同一控制器已包装，跳过（幂等）');
      return true;
    }
    if (this.controller) this.uninstall();

    this.controller = controller;
    this.originalOnMessage = controller.onMessage;
    const self = this;

    controller.onMessage = function (message) {
      const handled = self.handleMessage(message, function (msg) {
        // 放行：调用原始实现，行为与官方完全一致
        return self.originalOnMessage.call(controller, msg);
      });
      return handled;
    };
    this.log.info('屏保控制器已包装 (onMessage hook 已安装)');
    return true;
  }

  /**
   * 卸载包装，还原官方行为。
   * @returns {boolean}
   */
  uninstall() {
    if (this.controller && this.originalOnMessage) {
      this.controller.onMessage = this.originalOnMessage;
      this.log.info('屏保控制器包装已卸载，已还原官方行为');
    }
    this.controller = null;
    this.originalOnMessage = null;
    return true;
  }

  /**
   * ★ 核心分发逻辑（纯函数式，便于单测直接调用）。
   *
   * @param {object} message 形如 { url, data }
   * @param {Function} proceed 放行回调，接收（可能已改写的）message
   * @returns {boolean} true=已放行/已处理，false=被吞掉
   */
  handleMessage(message, proceed) {
    const url = message && message.url;
    if (url !== SCREENSAVER_ROUTE) {
      // 非屏保路由：原样放行，绝不干扰其它业务（SCREENLOCK/LIVE/...）
      return typeof proceed === 'function' ? (proceed(message), true) : false;
    }

    this.stats.intercepted++;
    const cfg = this.getConfig();

    // ---- 语义 1：配置禁用 → 吞掉，不下发、不入队 ----
    if (cfg.screensaverEnabled === false) {
      this.stats.blocked++;
      this.log.info('已拦截 ' + SCREENSAVER_ROUTE + '：配置禁用屏保，丢弃消息（不 share、不入队）');
      if (this.onBlock) {
        try { this.onBlock({ reason: 'disabled', message: message }); } catch (_) { /* 审计失败不影响主流程 */ }
      }
      return false;
    }

    // ---- 语义 2/3：放行但改写载荷 ----
    const override = cfg.override || null;
    if (!override) {
      // 无自定义：走官方原始路径，零侵入
      this.stats.started++;
      this.log.debug('放行 ' + SCREENSAVER_ROUTE + '：无自定义配置');
      if (typeof proceed === 'function') proceed(message);
      return true;
    }

    this.stats.overridden++;
    const rewritten = this.rewriteMessage(message, override);
    this.log.info(
      '放行 ' + SCREENSAVER_ROUTE + '：已应用自定义图集（图片 ' +
      (rewritten.data.imageList ? rewritten.data.imageList.length : 0) + ' 张，间隔 ' +
      rewritten.data.switchInterval + ' 秒，适配 ' + rewritten.data.pictureSizeType + '）'
    );
    if (typeof proceed === 'function') proceed(rewritten);
    return true;
  }

  /**
   * 把一条屏保消息改写为「官方 onMessage 会消费的形态」。
   *
   * 注意：这里**不直接调用 queue/share**，而是把改写后的 message 交给 proceed
   * （即官方原始 onMessage）。这样官方原有的入队/dependency/share 逻辑全部保留，
   * 我们只替换数据 —— 侵入面最小，也不会与官方拼写错误 coutinueTask 之类的细节脱节。
   *
   * @param {object} message { url, data }
   * @param {object} override 配置 override 块
   * @returns {object} 新的 message 对象
   */
  rewriteMessage(message, override) {
    const original = (message && message.data) || {};
    const data = applyOverride(original, override);

    // 图片数量以「改写后的 imageList」为准
    const imageCount = Array.isArray(data.imageList) ? data.imageList.length : 0;

    // ★ 转场列表：长度必须 === imageList.length，值域 0..6
    let transition = null;
    if (override.transitionList !== null && override.transitionList !== undefined) {
      // 配置里显式给了转场：规整长度与值域
      transition = normalizeTransitionList(override.transitionList, imageCount);
    } else if (imageCount > 0) {
      // 未配置：沿用官方随机算法
      transition = generateTransitionList(imageCount);
    }

    // 把转场列表挂到 message 上，供上层在最外层直接 share；
    // 若上层选择走原始 onMessage，则原始逻辑会自己再生成一次（长度一致，行为等价）。
    const out = Object.assign({}, message, { data: data });
    out.__auraTransitionList = transition;
    out.__auraImageCount = imageCount;
    return out;
  }

  /**
   * 断点 B：当无法拿到控制器实例时，提供一个最外层消息拦截器。
   * 调用方在「消息进入控制器之前」调用它。
   *
   * @returns {(message:object, next:Function) => boolean}
   */
  createMessageInterceptor() {
    const self = this;
    return function (message, next) {
      return self.handleMessage(message, next);
    };
  }

  /** 运行期状态快照（IPC status 用） */
  getStatus() {
    return {
      wrapped: this.controller !== null,
      route: SCREENSAVER_ROUTE,
      channels: { message: CHANNEL_MESSAGE, transition: CHANNEL_TRANSITION },
      stats: Object.assign({}, this.stats),
    };
  }
}

module.exports = {
  ScreensaverHook: ScreensaverHook,
  SCREENSAVER_ROUTE: SCREENSAVER_ROUTE,
  CHANNEL_MESSAGE: CHANNEL_MESSAGE,
  CHANNEL_TRANSITION: CHANNEL_TRANSITION,
  TASK: TASK,
  TRANSITION_MAX: TRANSITION_MAX,
  generateTransitionList: generateTransitionList,
  normalizeTransitionList: normalizeTransitionList,
  applyOverride: applyOverride,
};
