'use strict';
/**
 * src/index.js —— 装配入口，导出公共 API
 *
 * 定位：这是给「注入器」调用的工厂。它把各子系统组装起来，但**不做任何 Electron 依赖**：
 *   注入 electron / 窗口管理器 / 任务队列 / share 总线 → 得到真实工具；
 *   什么都不注入（全走默认桩） → 得到可在纯 Node 下单测的空壳。
 *
 * 典型用法（真实注入场景，由注入器在官方 main.js 被 require 之后调用）：
 *
 *   const { createTool } = require('./src/index.js');
 *   const tool = createTool({
 *     configManager,                 // 可选，缺省自动建
 *     ipcMain,                       // Electron ipcMain
 *     controller,                    // module @159264 屏保控制器实例
 *     windowManager,                 // module 69 窗口管理器实例
 *   });
 *   tool.start();                    // 安装 hook + 守卫 + 注册 IPC
 *
 * 关键结论出处（逐字来自 .work/app/main.js）：
 *   - 屏保控制器 @159264：onMessage 监听 "/displayScreenSaver" 并入队 SCREENSAVER
 *   - 窗口管理器 @76173：newWindow/closeWindow，close 回调里级联 startLock()
 *   - 任务常量 module 38 @40739：{SCREENLOCK, SCHOOLANNOUNCEMENT, LIVE, SCREENSAVER, POPUP_NOTIFICATION}
 */

const { createLogger } = require('./logger.js');
const schema = require('./config/schema.js');
const { ConfigManager, defaultConfigDir } = require('./config/configManager.js');
const { findModule, dumpModuleIds, ANCHORS } = require('./module/findModule.js');
const {
  ScreensaverHook,
  SCREENSAVER_ROUTE,
  CHANNEL_MESSAGE,
  CHANNEL_TRANSITION,
  TASK,
  generateTransitionList,
  normalizeTransitionList,
  applyOverride,
} = require('./hooks/screensaverHook.js');
const { LockCascadeGuard, SCREENSAVER_WINDOW_TYPE } = require('./hooks/lockCascadeGuard.js');
const { CHANNELS, createHandlers, registerHandlers, unregisterHandlers } = require('./ipc/handler.js');

/**
 * 默认桩：任务队列。
 * 接口对齐 main.js module 39 的真实方法名（enQueue / outQueue，官方原拼写）。
 */
function createStubQueue(logger) {
  const inner = [];
  const log = logger || createLogger({ level: 'silent' });
  return {
    enQueue(task) { inner.push(task); log.debug('[stubQueue] enQueue ' + (task && task.taskName)); },
    outQueue(name) {
      const i = inner.findIndex(function (t) { return t && t.taskName === name; });
      if (i >= 0) inner.splice(i, 1);
      log.debug('[stubQueue] outQueue ' + name);
    },
    get tasks() { return inner.slice(); },
  };
}

/**
 * 默认桩：share 广播总线。
 * 接口对齐 main.js 中随处可见的 r.share(name, data, windowName?)。
 */
function createStubShare(logger) {
  /** @type {Map<string, Array<{data:any, windowName?:string}>>} */
  const emitted = new Map();
  const log = logger || createLogger({ level: 'silent' });
  return {
    share(name, data, windowName) {
      const list = emitted.get(name) || [];
      list.push({ data: data, windowName: windowName });
      emitted.set(name, list);
      log.debug('[stubShare] ' + name);
    },
    setData() {},
    getData() { return null; },
    /** 测试辅助：取某通道最后一次广播 */
    lastEmit(name) {
      const list = emitted.get(name);
      return list && list.length ? list[list.length - 1].data : undefined;
    },
    /** 测试辅助：取某通道广播次数 */
    emitCount(name) { return (emitted.get(name) || []).length; },
  };
}

/**
 * 默认桩：窗口管理器。
 * 接口对齐 main.js module 69 的 newWindow / closeWindow / addOne，但不真的开窗。
 */
function createStubWindowManager(logger) {
  const log = logger || createLogger({ level: 'silent' });
  return {
    windowsList: {},
    opened: [],
    addOne(type, name) { return { name: name, type: type }; },
    newWindow(type) { this.opened.push(type); log.debug('[stubWindowManager] newWindow ' + type); },
    resetWindow(type) { log.debug('[stubWindowManager] resetWindow ' + type); },
    closeWindow(type) { log.debug('[stubWindowManager] closeWindow ' + type); },
  };
}

/** 默认桩：ipcMain。只记录注册过的通道。 */
function createStubIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    /** 测试辅助：模拟渲染进程调用 */
    invoke(channel, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error('未注册的通道: ' + channel);
      return fn({}, payload);
    },
    channels() { return Array.from(handlers.keys()); },
  };
}

/**
 * 装配一个完整工具实例。
 *
 * @param {object} [ctx]
 * @param {object} [ctx.configManager] 已有 ConfigManager（缺省自动创建并 load）
 * @param {string} [ctx.configDir] 配置目录（未传 configManager 时生效）
 * @param {string} [ctx.logLevel='info']
 * @param {object} [ctx.logger] 自定义日志器
 * @param {object} [ctx.ipcMain] Electron ipcMain 或桩
 * @param {object} [ctx.queue] 任务队列（缺省桩）
 * @param {object} [ctx.share] share 总线（缺省桩）
 * @param {object} [ctx.windowManager] 窗口管理器（缺省桩）
 * @param {object} [ctx.controller] 屏保控制器实例（用于 wrap）
 * @param {boolean} [ctx.autoRegisterIpc=false] start() 时是否自动注册 IPC 通道
 * @param {boolean} [ctx.readOnly=false] 只读模式（不落盘）
 * @param {(evt:object)=>void} [ctx.onBlock] 拦截审计回调
 * @returns {object} tool 实例
 */
function createTool(ctx) {
  const c = ctx || {};
  const logger = c.logger || createLogger({ level: c.logLevel || 'info', namespace: 'seewo-aura' });

  const configManager = c.configManager || new ConfigManager({
    configDir: c.configDir || defaultConfigDir(),
    logger: logger.child('config'),
    readOnly: c.readOnly === true,
  });
  // 若外部传入的是尚未 load 的 manager，这里补一次 load（已 load 也安全：幂等读取）
  if (c.configManager && typeof configManager.load === 'function' && !configManager.__loaded) {
    configManager.load();
    configManager.__loaded = true;
  }
  // 让日志级别跟随配置
  try { logger.setLevel(configManager.getConfig().logLevel); } catch (_) { /* 忽略 */ }

  const queue = c.queue || createStubQueue(logger.child('queue'));
  const share = c.share || createStubShare(logger.child('share'));
  const windowManager = c.windowManager || createStubWindowManager(logger.child('window'));
  const ipcMain = c.ipcMain || createStubIpcMain();

  const hook = new ScreensaverHook({
    configManager: configManager,
    logger: logger.child('hook'),
    queue: queue,
    share: share,
    windowManager: windowManager,
    controller: c.controller || null,
    onBlock: c.onBlock || null,
  });

  const guard = new LockCascadeGuard({
    configManager: configManager,
    logger: logger.child('guard'),
    windowManager: c.windowManager || null, // 只在真实注入时才安装（桩无需守卫）
    onBlocked: c.onBlock || null,
  });

  const handlers = createHandlers({
    configManager: configManager,
    screensaverHook: hook,
    lockCascadeGuard: guard,
    logger: logger,
  });

  let started = false;
  let registeredChannels = [];

  const tool = {
    // ---- 子系统（供高级用法直接访问） ----
    logger: logger,
    configManager: configManager,
    hook: hook,
    guard: guard,
    handlers: handlers,
    queue: queue,
    share: share,
    windowManager: windowManager,
    ipcMain: ipcMain,

    /**
     * 启动：安装 hook、安装守卫、（可选）注册 IPC 通道。
     * 幂等：重复调用不会重复安装。
     * @returns {{ok:boolean, channels:string[], hookWrapped:boolean, guardInstalled:boolean}}
     */
    start() {
      if (started) {
        logger.debug('工具已启动，跳过（幂等）');
        return {
          ok: true,
          channels: registeredChannels.slice(),
          hookWrapped: hook.getStatus().wrapped,
          guardInstalled: guard.getStatus().installed,
        };
      }
      if (c.controller) hook.wrap(c.controller);
      if (c.autoRegisterIpc) registeredChannels = registerHandlers(ipcMain, handlers);
      started = true;
      logger.info('seewo-aura 屏保工具已启动 (IPC 通道 ' + registeredChannels.length + ' 个)');
      return {
        ok: true,
        channels: registeredChannels.slice(),
        hookWrapped: hook.getStatus().wrapped,
        guardInstalled: guard.getStatus().installed,
      };
    },

    /**
     * 停止并完整回滚：卸载 hook、卸载守卫、注销 IPC 通道。
     * @returns {{ok:boolean, removedChannels:string[]}}
     */
    stop() {
      hook.uninstall();
      guard.uninstall();
      const removed = unregisterHandlers(ipcMain);
      registeredChannels = [];
      started = false;
      logger.info('seewo-aura 屏保工具已停止，已回滚全部修改');
      return { ok: true, removedChannels: removed };
    },

    /** 运行期状态汇总 */
    getStatus() {
      return {
        started: started,
        channels: CHANNELS,
        registeredChannels: registeredChannels.slice(),
        config: configManager.getStatus(),
        hook: hook.getStatus(),
        guard: guard.getStatus(),
      };
    },

    /** 手动注册 IPC 通道（start() 未开 autoRegisterIpc 时使用） */
    registerIpc() {
      registeredChannels = registerHandlers(ipcMain, handlers);
      return registeredChannels.slice();
    },

    /**
     * 便捷配置操作（等价于 IPMartin 的 setConfig/patchConfig，但直接返回结果）
     */
    setConfig(next) { return handlers.setConfig(next); },
    patchConfig(patch) { return handlers.patchConfig(patch); },
    getConfig() { return configManager.getConfig(); },
    resetConfig() { return handlers.resetConfig(); },
    rollback(steps) { return handlers.rollback({ steps: steps }); },
    preview(payload) { return handlers.preview(payload); },
  };
  return tool;
}

/** 版本号（与 package.json 保持独立，避免循环读取） */
const VERSION = '0.1.0';

module.exports = {
  VERSION: VERSION,
  createTool: createTool,

  // 子系统构造器
  createLogger: createLogger,
  ConfigManager: ConfigManager,
  ScreensaverHook: ScreensaverHook,
  LockCascadeGuard: LockCascadeGuard,

  // 配置相关
  schema: schema,

  // 模块定位
  findModule: findModule,
  dumpModuleIds: dumpModuleIds,
  ANCHORS: ANCHORS,

  // IPC
  CHANNELS: CHANNELS,
  createHandlers: createHandlers,
  registerHandlers: registerHandlers,
  unregisterHandlers: unregisterHandlers,

  // 桩（测试/无 Electron 环境使用）
  createStubQueue: createStubQueue,
  createStubShare: createStubShare,
  createStubWindowManager: createStubWindowManager,
  createStubIpcMain: createStubIpcMain,

  // 常量（逐字来自 main.js）
  SCREENSAVER_ROUTE: SCREENSAVER_ROUTE,
  CHANNEL_MESSAGE: CHANNEL_MESSAGE,
  CHANNEL_TRANSITION: CHANNEL_TRANSITION,
  SCREENSAVER_WINDOW_TYPE: SCREENSAVER_WINDOW_TYPE,
  TASK: TASK,

  // 工具函数
  generateTransitionList: generateTransitionList,
  normalizeTransitionList: normalizeTransitionList,
  applyOverride: applyOverride,
};
