'use strict';
/**
 * tools/payload/aura-screensaver-loader.js —— 注入进 app.asar 的**自包含**加载器
 *
 * ★ 本文件不是普通模块：它会被 tools/patch-asar.js 原样追加到官方 app/main.js 的**文件末尾**。
 *   因此它必须满足：
 *     1) 单文件自包含 —— 不 require 任何外部文件、不依赖 node_modules（注入后不存在）
 *     2) 绝不阻断官方启动 —— 所有逻辑包在 try/catch 里，任何异常只写日志
 *     3) 幂等 —— 重复执行不会重复包装（用 Symbol 在原型/实例上打标记）
 *
 * ★ 运行时机（实测依据）：
 *   官方 main.js 的结尾是：
 *       !function(e){ ... n.p="",n(n.s=140)}([ ...modules... ]);
 *   这是一个完整的表达式语句，以 ");" 结尾。追加代码在它**之后**、
 *   同一个 CommonJS 模块作用域内执行，因此 n(n.s=140) 已经跑完，
 *   要求的模块都可以直接从 webpack require 缓存里取出**同一个单例**。
 *
 * ★ 如何拿到 webpack require（实测通过）：
 *   patch-asar.js 在 bootstrap 尾部插入一处赋值：global.__AURA_REQ__=n
 *   （锚点 n.p="",n(n.s=<id>)} 由正则定位，不硬编码入口 id）
 *   本加载器据此拿到官方模块实例：
 *       req(120) 屏保控制器   —— 有 onMessage/startScreensaver/stopScreensaver/closeWindow
 *       req(69)  窗口管理器   —— 有 newWindow/resetWindow/closeWindow（close 回调级联 startLock）
 *       req(40)  屏幕锁控制器 —— 有 startLock/startLockTask/userLock（仅用于探测，不修改）
 *
 * ★ 与 src/ 的关系：
 *   逻辑与 src/hooks/screensaverHook.js、src/hooks/lockCascadeGuard.js 一致，
 *   但**内联复制**为自包含实现（注入产物不能 require 仓库文件）。
 *
 * 依据：.work/FINDINGS.md、.work/RENDERER_CONTRACT.md、.work/CASCADE_ANALYSIS.md
 */

/* eslint-disable */
(function () {
  'use strict';

  var GLOBAL_KEY = '__AURA_SCREENSAVER__';
  var REQ_KEY = '__AURA_REQ__';

  // 通道/路由常量 —— 逐字来自 main.js 与 public/screensaver.js（见 RENDERER_CONTRACT.md）
  var SCREENSAVER_ROUTE = '/displayScreenSaver';
  var CHANNEL_MESSAGE = 'screensaverMessage';
  var CHANNEL_TRANSITION = 'screensaverTransitionList';
  var SCREENSAVER_WINDOW_TYPE = 'screensaver';
  var TRANSITION_MAX = 6;

  // 配置：默认路径 %APPDATA%\seewo\AuraScreensaver\config.json
  // 允许用环境变量 AURA_SCREENSAVER_CONFIG 覆盖（便于便携/调试）。
  var CONFIG_ENV = 'AURA_SCREENSAVER_CONFIG';
  var CONFIG_RELATIVE = ['seewo', 'AuraScreensaver', 'config.json'];

  /**
   * 内嵌兜底配置的全局键。
   * patch-asar.js 会在追加本加载器之前写入：
   *     globalThis.__AURA_INLINE_CONFIG__ = <--config 解析结果>
   * 这样做的原因：本加载器是被**原样追加**到 main.js 末尾的文本，
   * 补丁器不方便在 IIFE 内部注入变量，改写全局是最简单可靠的通道。
   */
  var INLINE_CONFIG_KEY = '__AURA_INLINE_CONFIG__';

  /**
   * 读取内嵌兜底配置。读不到就返回 null（后续会回落到 DEFAULT_CONFIG）。
   * 外部配置文件（%APPDATA%\seewo\AuraScreensaver\config.json）优先级**高于**内嵌配置，
   * 这样用户改配置不需要重新打补丁。

  /* ------------------------------------------------------------------ *
   * 日志：写到 %APPDATA%\seewo\AuraScreensaver\aura-screensaver.log
   * 任何写日志失败都必须被吞掉（日志是旁路，绝不影响主流程）
   * ------------------------------------------------------------------ */

  function createLog() {
    var fs, path, file = null, ready = false;

    function initPaths() {
      try {
        fs = require('fs');
        path = require('path');
      } catch (e) { return false; }
      try {
        var base = process.env.APPDATA ||
          (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null);
        if (!base) return false;
        file = path.join(base, 'seewo', 'AuraScreensaver', 'aura-screensaver.log');
        return true;
      } catch (e) { return false; }
    }

    ready = initPaths();

    function ensureDir() {
      if (!ready) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return true;
      } catch (e) { return false; }
    }

    function write(level, args) {
      var text;
      try {
        text = Array.prototype.slice.call(args).map(function (a) {
          if (typeof a === 'string') return a;
          if (a instanceof Error) return a.stack || a.message;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
      } catch (e) { text = '(unformattable)'; }
      var line = '[' + new Date().toISOString() + '] [' + level + '] [aura-screensaver] ' + text;
      // 同时打到 stdout：官方主进程日志里能看到，便于现场排查
      try { if (level === 'ERROR' || level === 'WARN') console.error(line); else console.log(line); } catch (e) {}
      try {
        if (ready && ensureDir()) fs.appendFileSync(file, line + '\n');
      } catch (e) { /* 日志失败绝不能影响主流程 */ }
    }

    return {
      path: function () { return file; },
      debug: function () { write('DEBUG', arguments); },
      info: function () { write('INFO', arguments); },
      warn: function () { write('WARN', arguments); },
      error: function () { write('ERROR', arguments); },
    };
  }

  /* ------------------------------------------------------------------ *
   * 配置读取：文件优先，失败回落到内嵌配置，再失败回落到内置默认值
   * ------------------------------------------------------------------ */

  var DEFAULT_CONFIG = {
    // 用户明确要求：关闭屏保 —— false 时吞掉 /displayScreenSaver
    screensaverEnabled: false,
    // 是否允许「关闭屏保窗口 → 级联进入屏幕锁」。官方 module 69 的 close 回调
    // 调用了自己不存在的 startLock()（确定性缺陷），但若官方修好会变成「关掉即锁屏」，
    // 故这里默认切断级联。
    lockCascadeOnClose: false,
    // 图集覆盖；null = 不改写云端下发数据
    override: null,
    logLevel: 'info',
  };

  function readConfigFile(log) {
    try {
      var fs = require('fs');
      var path = require('path');
      var file = process.env[CONFIG_ENV];
      if (!file) {
        var base = process.env.APPDATA ||
          (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null);
        if (!base) return null;
        file = path.join.apply(path, [base].concat(CONFIG_RELATIVE));
      }
      var raw = fs.readFileSync(file, 'utf8');
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      log.info('已加载外部配置: ' + file);
      return { file: file, value: parsed };
    } catch (e) {
      // 文件不存在是正常情况（用户还没配置），不吵闹
      if (e && e.code !== 'ENOENT') log.warn('读取配置失败（回落内嵌配置）: ' + (e.message || e));
      return null;
    }
  }

  function merge(base, patch) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (patch && typeof patch === 'object') {
      for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    }
    return out;
  }

  function loadConfig(log) {
    var fromFile = readConfigFile(log);
    var inline = null;
    try {
      var raw = globalThis[INLINE_CONFIG_KEY];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) inline = raw;
    } catch (e) { /* 读取内嵌配置失败 → 回落到默认值 */ }
    if (fromFile) log.info('优先级：外部配置文件 > 内嵌配置');
    var effective = fromFile ? fromFile.value : (inline || {});
    var cfg = merge(DEFAULT_CONFIG, effective);
    // 防御：类型不对就回落到默认，绝不因为脏配置改变行为
    if (typeof cfg.screensaverEnabled !== 'boolean') cfg.screensaverEnabled = DEFAULT_CONFIG.screensaverEnabled;
    if (typeof cfg.lockCascadeOnClose !== 'boolean') cfg.lockCascadeOnClose = DEFAULT_CONFIG.lockCascadeOnClose;
    return cfg;
  }

  /* ------------------------------------------------------------------ *
   * 能力 (b)：自定义图集 —— 改写 screensaverMessage 载荷
   *
   * 字段契约（RENDERER_CONTRACT.md，逐字解码自 public/screensaver.js）：
   *   materialSource  string   底部署名，空串不显示
   *   switchInterval  number   ★单位=秒（渲染器 1000 * (x || 15)），默认 15
   *   pictureSizeType number   ★0=contain(留边) 1=cover(铺满)，D=["contain","cover"]
   *   imageList       string[] 图片路径
   *   textList        {content, provenance?}[]
   *   转场数组长度必须 === imageList.length，值域 0..6
   * ------------------------------------------------------------------ */

  /** 官方算法：每个图随机 0..6（main.js 里 Math.random()*7） */
  function generateTransitionList(count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(Math.floor(Math.random() * (TRANSITION_MAX + 1)));
    return out;
  }

  /**
   * 把 override 应用到云端下发的 data 上。
   * ★ 只在 override 提供了对应字段时才覆盖，未提供的字段保持官方原值。
   */
  function applyOverride(data, override, log) {
    if (!override || typeof override !== 'object') return data;
    if (!data || typeof data !== 'object') return data;
    var out = merge(data, override);

    // switchInterval 单位是秒且必须是正整数；非法值直接丢弃以免渲染器拿到脏数据
    if (override.switchInterval !== undefined) {
      var si = Number(override.switchInterval);
      if (isFinite(si) && Math.floor(si) === si && si > 0) out.switchInterval = si;
      else { log.warn('switchInterval 非法（必须是正整数秒），已忽略: ' + override.switchInterval); delete out.switchInterval; }
      if (out.switchInterval === undefined) out.switchInterval = data.switchInterval;
    }

    // pictureSizeType 只接受 0/1，越界会让 D[x] === undefined（组件行为未定义）
    if (override.pictureSizeType !== undefined) {
      var ps = Number(override.pictureSizeType);
      if (ps === 0 || ps === 1) out.pictureSizeType = ps;
      else { log.warn('pictureSizeType 非法（只能 0 或 1），已忽略: ' + override.pictureSizeType); out.pictureSizeType = data.pictureSizeType; }
    }

    if (override.imageList !== undefined) {
      if (Array.isArray(override.imageList)) {
        out.imageList = override.imageList.filter(function (p) { return typeof p === 'string' && p.length > 0; });
      } else { log.warn('imageList 非法（必须是数组），已忽略'); out.imageList = data.imageList; }
    }

    if (override.textList !== undefined) {
      if (Array.isArray(override.textList)) {
        out.textList = override.textList.filter(function (t) {
          return t && typeof t === 'object' && typeof t.content === 'string' && t.content.length > 0;
        }).map(function (t) {
          var item = { content: t.content };
          if (typeof t.provenance === 'string') item.provenance = t.provenance;
          return item;
        });
      } else { log.warn('textList 非法（必须是数组），已忽略'); out.textList = data.textList; }
    }

    return out;
  }

  /**
   * 归一化转场数组：长度必须等于 imageList.length，值域 0..6。
   * 不符就重新生成 —— 否则渲染器轮播索引会错位（契约硬要求）。
   */
  function normalizeTransitionList(list, count) {
    if (!Array.isArray(list) || list.length !== count) return generateTransitionList(count);
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (typeof v !== 'number' || Math.floor(v) !== v || v < 0 || v > TRANSITION_MAX) {
        return generateTransitionList(count);
      }
    }
    return list.slice();
  }

  /* ------------------------------------------------------------------ *
   * 能力 (a)：关闭屏保 —— 包装控制器 onMessage，吞掉 /displayScreenSaver
   * ------------------------------------------------------------------ */

  function installScreensaverHook(controller, share, cfg, log, state) {
    if (!controller || typeof controller.onMessage !== 'function') {
      log.warn('未找到屏保控制器 onMessage —— 跳过屏保拦截（放行官方行为）');
      return false;
    }
    if (controller.__auraWrapped) {
      log.debug('屏保控制器已包装过，跳过（幂等）');
      return true;
    }

    var original = controller.onMessage;

    function wrapped(msg) {
      try {
        if (msg && msg.url === SCREENSAVER_ROUTE) {
          // ★ state.previewBypass：手动预览是明确的用户动作，应绕过「屏保已关闭」的自动拦截。
          //   否则会出现「我关了屏保，但想看看配置效果」却无法预览的悖论。
          if (!cfg.screensaverEnabled && !state.previewBypass) {
            // ★ 关闭屏保：不入队、不广播。这是最干净的拦截点 ——
            //   比"关窗口"更好，因为关窗口会触发 module 69 的 close 级联。
            state.blocked++;
            log.info('已拦截 ' + SCREENSAVER_ROUTE + '（屏保已按配置关闭）');
            return;
          }
          // 屏保开启且配置了自定义图集 → 改写载荷后再交给官方逻辑。
          // ★ 注意：必须把**改写后的 msg** 传下去，不能再用 arguments
          //   （arguments 里仍是原始消息，改写会被静默丢弃）。
          var forwarded = msg;
          if (cfg.override) {
            try {
              var data = applyOverride(msg.data, cfg.override, log);
              forwarded = merge(msg, { data: data });
              // 记录最后一次下发的载荷，供 startScreensaver 对齐转场数组长度使用
              controller.__auraLastPayload = data;
              state.overridden++;
              log.info('已应用自定义图集（图片 ' + ((data && data.imageList && data.imageList.length) || 0) + ' 张）');
            } catch (e) {
              log.warn('应用自定义图集失败，放行原始数据: ' + (e.message || e));
              forwarded = msg;
            }
          }
          // ★ 转场数组长度必须 === imageList.length（渲染器契约硬要求）。
          //   官方在 onMessage 内用原始 imageList.length 生成并广播转场数组；
          //   我们改写了 imageList，所以必须**在官方逻辑之前**用正确长度重新广播一次，
          //   否则渲染器轮播索引会错位。
          try {
            if (cfg.override && share && typeof share.share === 'function') {
              var imgs = (forwarded.data && forwarded.data.imageList) || [];
              var tlist = normalizeTransitionList(
                (cfg.override && cfg.override.transitionList) || null, imgs.length);
              share.share(CHANNEL_TRANSITION, tlist);
            }
          } catch (e) { log.warn('预广播转场数组失败（官方逻辑仍会广播）: ' + (e.message || e)); }
          return original.call(this, forwarded);
        }
      } catch (e) {
        // 任何异常都放行官方逻辑，绝不阻断
        log.error('屏保拦截异常（放行官方行为）: ' + (e && e.stack || e));
      }
      return original.apply(this, arguments);
    }

    try {
      controller.onMessage = wrapped;
      controller.__auraWrapped = true;
      controller.__auraOriginalOnMessage = original;

      // 一并包装 stopScreensaver：自定义图集时同步修正转场数组长度
      if (typeof controller.stopScreensaver === 'function' && !controller.__auraStopWrapped) {
        var origStop = controller.stopScreensaver;
        controller.stopScreensaver = function () {
          try {
            if (share && typeof share.share === 'function') {
              share.share(CHANNEL_TRANSITION, null);
            }
          } catch (e) { log.warn('清理转场列表失败: ' + (e.message || e)); }
          return origStop.apply(this, arguments);
        };
        controller.__auraStopWrapped = true;
      }
      return true;
    } catch (e) {
      log.error('包装屏保控制器失败: ' + (e && e.stack || e));
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 能力 (c)：切断 close → startLock 级联（默认开）
   *
   * 依据 .work/CASCADE_ANALYSIS.md：
   *   module 69 的 newWindow / resetWindow 里注册了
   *       r.on("close", () => { setTimeout(() => { this.closeWindow(); this.startLock(); }, 0) })
   *   而 module 69 **没有** startLock 方法（确定性缺陷）→ 必然抛 TypeError。
   *
   * ★ 安全性：只切断"屏保窗口 close → 锁屏"这一条来源。
   *   绝不动 module 40（屏幕锁控制器）的 startLock / startLockTask，
   *   因此云端远程锁屏（messageType 1211）与本地 userLock() 完全不受影响。
   * ------------------------------------------------------------------ */

  /**
   * 在窗口管理器实例上放置一个「级联拦截」的 startLock。
   *
   * ★ 原理（关键）：
   *   官方 newWindow/resetWindow 里注册的是
   *       r.on("close", () => setTimeout(() => { this.closeWindow(); this.startLock(); }, 0))
   *   注意这是**箭头函数**，this 词法绑定到 newWindow 被调用时的 this，
   *   也就是**窗口管理器实例本身**。所以只要该实例上存在一个 startLock，
   *   官方回调就会调用到它。
   *
   *   - 官方 v1.2.7 的该实例**没有** startLock（确定性缺陷）→ 现会抛 TypeError。
   *   - 我们放一个受控实现上去：既不抛错，也不会真的启动屏幕锁。
   *
   * ★ 前向兼容（重要）：
   *   若官方某版本真的给窗口管理器加了 startLock，我们**必须保留原方法**并只做
   *   计数/记录，然后调用它 —— 否则会静默改变官方语义（虽然本工具默认就是要
   *   切断级联，但显式区分「官方有实现」与「官方没实现」能让日志和文档不说谎）。
   *
   * ★ 影响面（安全边界）：
   *   只改**窗口管理器实例**。module 40（屏幕锁控制器）的 startLock /
   *   startLockTask / userLock 一概不碰 → 云端远程锁屏（messageType 1211）
   *   与本地主动锁屏完全不受影响。
   */
  function installCascadeTrap(windowManager, log, state) {
    if (windowManager.__auraCascadeTrap) {
      return { installed: true, officialHadStartLock: windowManager.__auraOfficialStartLock };
    }

    var descriptor = Object.getOwnPropertyDescriptor(windowManager, 'startLock');
    var official = typeof windowManager.startLock === 'function' ? windowManager.startLock : null;
    // 原型链上是否存在官方实现（本版本为 null）
    var onPrototype = !official && (function () {
      try {
        var proto = Object.getPrototypeOf(windowManager);
        return !!(proto && typeof proto.startLock === 'function');
      } catch (e) { return false; }
    })();

    var trap = function () {
      state.cascadeBlocked++;
      log.info('已拦截屏保窗口关闭 -> startLock 级联（未进入屏幕锁）'
        + (official ? '；官方存在同名方法，已抑制调用' : '；官方本无此方法（TypeError 缺陷，已消除）'));
      // 有意不转调 official：本工具默认语义就是切断级联。
      // 想恢复官方行为时，把 lockCascadeOnClose 设为 true（不安装本陷阱）即可。
      return undefined;
    };

    try {
      Object.defineProperty(windowManager, 'startLock', {
        configurable: true, writable: true, enumerable: false, value: trap,
      });
    } catch (e) {
      try { windowManager.startLock = trap; } catch (e2) {
        log.error('无法安装级联陷阱: ' + (e2 && e2.message || e2));
        return { installed: false, officialHadStartLock: !!official };
      }
    }

    windowManager.__auraCascadeTrap = { descriptor: descriptor, trap: trap };
    windowManager.__auraOfficialStartLock = !!official;
    if (onPrototype) log.warn('注意：窗口管理器原型链上存在 startLock —— 官方可能已修好该缺陷；级联陷阱仍按配置生效');

    return { installed: true, officialHadStartLock: !!official };
  }

  function installLockCascadeGuard(windowManager, cfg, log, state) {
    if (cfg.lockCascadeOnClose) {
      log.info('lockCascadeOnClose=true，保留官方级联行为（不安装守卫）');
      return false;
    }
    if (!windowManager || typeof windowManager.newWindow !== 'function') {
      log.warn('未找到窗口管理器 newWindow —— 跳过级联守卫（放行官方行为）');
      return false;
    }
    if (windowManager.__auraGuarded) {
      log.debug('窗口管理器已安装守卫，跳过（幂等）');
      return true;
    }

    try {
      // 1) 放置级联陷阱：newWindow 与 resetWindow 的 close 回调都以同一实例为 this，
      //    因此一个陷阱即可覆盖两条注册路径。
      var trapResult = installCascadeTrap(windowManager, log, state);
      if (!trapResult.installed) return false;

      // 2) 仅为可观测性记录屏保窗口创建，不改变官方行为
      var originalNewWindow = windowManager.newWindow;
      windowManager.newWindow = function (type) {
        try {
          if (type === SCREENSAVER_WINDOW_TYPE) state.screensaverWindowsCreated++;
        } catch (e) { /* 观测失败不影响主流程 */ }
        return originalNewWindow.apply(this, arguments);
      };
      windowManager.__auraOriginalNewWindow = originalNewWindow;
      windowManager.__auraGuarded = true;
      log.info('级联守卫已安装（官方本版本' + (trapResult.officialHadStartLock ? '存在' : '不存在')
        + ' startLock；屏幕锁控制器 module 40 未被修改）');
      return true;
    } catch (e) {
      log.error('安装级联守卫失败（放行官方行为）: ' + (e && e.stack || e));
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 控制通道：GUI（独立进程）→ 主进程 loader 的命令桥
   *
   * ★ 为什么需要命令桥：
   *   GUI 是独立的 Node HTTP 进程，而屏保窗口由管家主进程的 webpack 模块 120 渲染。
   *   跨进程无法直接调用对象方法，因此采用「命令文件 + 轮询」：
   *     GUI 写 command.json → loader 轮询执行 → 写 command-result.json → GUI 读结果
   *   不用 socket / 命名管道：文件方式在任意用户权限下都可用，出问题能直接看文件。
   * ------------------------------------------------------------------ */

  var COMMAND_RELATIVE = ['seewo', 'AuraScreensaver', 'command.json'];
  var COMMAND_RESULT_RELATIVE = ['seewo', 'AuraScreensaver', 'command-result.json'];
  var COMMAND_POLL_MS = 700;

  /** 与 readConfigFile 一致的目录解析，保证 GUI 与 loader 指向同一位置 */
  function resolveDataFile(relative) {
    try {
      var path = require('path');
      var base = process.env.APPDATA ||
        (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null);
      if (!base) {
        var os = require('os');
        base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      }
      return path.join.apply(path, [base].concat(relative));
    } catch (e) { return null; }
  }

  /**
   * 构造预览载荷。
   *   1) 配置了 override → 用 override 组装（这才是「预览我的配置」的本意）
   *   2) 否则 → 用上次集控下发的真实载荷
   *   3) 都没有 → 返回错误（绝不能弹一个空白屏保让人以为坏了）
   */
  function buildPreviewPayload(cfg, controller, log) {
    var ov = cfg && cfg.override;
    if (ov && typeof ov === 'object') {
      var imgs = Array.isArray(ov.imageList)
        ? ov.imageList.filter(function (p) { return typeof p === 'string' && p.length > 0; })
        : [];
      if (!imgs.length) {
        return { error: '预览需要至少一张图片：请在界面里添加图片，或把 override 置空以使用集控下发数据', reason: 'empty-image-list' };
      }
      var base = { imageList: imgs, textList: [], materialSource: '', switchInterval: 15, pictureSizeType: 0 };
      if (Array.isArray(ov.textList)) base.textList = ov.textList;
      if (typeof ov.materialSource === 'string') base.materialSource = ov.materialSource;
      if (typeof ov.switchInterval === 'number') base.switchInterval = ov.switchInterval;
      if (typeof ov.pictureSizeType === 'number') base.pictureSizeType = ov.pictureSizeType;
      return { data: applyOverride(base, ov, log), source: 'override' };
    }
    var last = controller && controller.__auraLastPayload;
    if (last && typeof last === 'object') return { data: last, source: 'last-payload' };
    return { error: '没有可用的预览数据：配置里 override 为空，且尚未收到集控下发', reason: 'no-payload' };
  }

  /**
   * 安装控制对象 global.__AURA_SCREENSAVER__.control
   *   preview()      立即唤起屏保（按当前配置）
   *   stop()         关闭屏保
   *   reloadConfig() 重读 config.json（免重启试配置）
   *   getState()     状态快照
   */
  function installControl(controller, share, windowManager, cfg, log, state) {
    var control = {};

    control.preview = function () {
      if (!controller || typeof controller.onMessage !== 'function') {
        return { ok: false, reason: 'no-controller', message: '屏保控制器(120)未就绪，无法预览' };
      }
      var built = buildPreviewPayload(cfg, controller, log);
      if (built.error) return { ok: false, reason: built.reason, message: built.error };

      var payload = built.data;
      state.previewBypass = true;
      try {
        controller.onMessage({ url: SCREENSAVER_ROUTE, data: payload });
        log.info('已触发屏保预览（来源=' + built.source + '，图片 ' + ((payload.imageList || []).length) + ' 张）');
        return { ok: true, source: built.source, imageCount: (payload.imageList || []).length };
      } catch (e) {
        log.warn('预览调用 onMessage 失败，尝试手动兜底: ' + (e && e.message || e));
        try {
          var imgs = payload.imageList || [];
          var tlist = normalizeTransitionList((cfg.override && cfg.override.transitionList) || null, imgs.length);
          if (share && typeof share.share === 'function') {
            share.share(CHANNEL_TRANSITION, tlist);
            share.share(CHANNEL_MESSAGE, payload);
          }
          controller.startScreensaver();
          log.info('已通过兜底路径触发屏保预览');
          return { ok: true, source: 'manual', imageCount: imgs.length };
        } catch (e2) {
          log.error('预览失败: ' + (e2 && e2.message || e2));
          return { ok: false, reason: 'exception', message: String(e2 && e2.message || e2) };
        }
      } finally {
        state.previewBypass = false;
      }
    };

    control.stop = function () {
      try {
        if (!controller) return { ok: false, reason: 'no-controller', message: '屏保控制器(120)未就绪' };
        if (typeof controller.stopScreensaver !== 'function') return { ok: false, reason: 'no-stop-method' };
        controller.stopScreensaver();
        log.info('已关闭屏保');
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'exception', message: String(e && e.message || e) };
      }
    };

    control.reloadConfig = function () {
      try {
        var fresh = loadConfig(log);
        // ★ 原地改写同一个对象：hook / guard 都捕获了这个引用，
        //   保持身份不变才能让新配置立即对所有闭包生效（免重启）。
        var k;
        for (k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k)) delete cfg[k];
        for (k in fresh) if (Object.prototype.hasOwnProperty.call(fresh, k)) cfg[k] = fresh[k];
        log.info('配置已重载: screensaverEnabled=' + cfg.screensaverEnabled);
        return { ok: true, config: cfg };
      } catch (e) {
        return { ok: false, reason: 'exception', message: String(e && e.message || e) };
      }
    };

    control.getState = function () {
      return {
        ok: true,
        installed: !!state.ok,
        state: { blocked: state.blocked, overridden: state.overridden, cascadeBlocked: state.cascadeBlocked },
        config: cfg,
        modules: { controller: !!controller, share: !!share, windowManager: !!windowManager },
      };
    };

    return control;
  }

  /**
   * 启动命令轮询。同一 seq 只执行一次（幂等），避免轮询重复触发预览。
   */
  function startCommandBridge(control, log) {
    try {
      var fs = require('fs');
      var cmdFile = resolveDataFile(COMMAND_RELATIVE);
      var resFile = resolveDataFile(COMMAND_RESULT_RELATIVE);
      if (!cmdFile || !resFile) { log.warn('命令桥：无法解析数据目录，预览按钮将不可用'); return false; }

      var lastSeq = 0;
      var timer = setInterval(function () {
        try {
          if (!fs.existsSync(cmdFile)) return;
          var cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
          if (!cmd || typeof cmd !== 'object') return;
          var seq = Number(cmd.seq) || 0;
          if (seq <= lastSeq) return;
          lastSeq = seq;

          var name = String(cmd.cmd || '');
          var result;
          if (typeof control[name] !== 'function') {
            result = { ok: false, reason: 'unknown-command', message: '未知命令: ' + name };
          } else {
            result = control[name](cmd.args || {});
          }
          result = merge({ ok: false }, result || {});
          result.seq = seq;
          result.cmd = name;
          result.at = new Date().toISOString();
          try { fs.writeFileSync(resFile, JSON.stringify(result, null, 2)); }
          catch (e) { log.warn('写命令结果失败: ' + (e && e.message || e)); }
        } catch (e) {
          // 半截 JSON / 权限问题都不该打断轮询
          if (e && e.code !== 'ENOENT') log.debug('命令桥轮询异常: ' + (e && e.message || e));
        }
      }, COMMAND_POLL_MS);

      // ★ unref：轮询不该单独把一个进程「吊住」（尤其单测里）。
      //   Electron 主进程本来就由 app 的事件循环保活，unref 不影响轮询。
      try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (e) { /* ignore */ }

      log.info('命令桥已启动（轮询 ' + COMMAND_POLL_MS + 'ms）: ' + cmdFile);
      return true;
    } catch (e) {
      log.warn('命令桥启动失败（预览按钮将不可用）: ' + (e && e.message || e));
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 模块定位（思路参考 HugoAura：模块 id 是 webpack 构建产物，换版本会漂移）
   *
   *   先试已知 id（本版为 120 / 69）；形状不符就按**工厂源码特征**扫描模块表，
   *   逐个验证形状后才采用。
   *   ★ 先按源码过滤再执行工厂 —— 避免为探测触发无关模块的副作用。
   * ------------------------------------------------------------------ */

  function getFactorySource(req, id) {
    try {
      var m = req.m;
      if (!m) return '';
      var f = m[id];
      return (typeof f === 'function') ? String(f) : '';
    } catch (e) { return ''; }
  }

  function looksLikeScreensaver(v) {
    return !!(v && typeof v.onMessage === 'function' && typeof v.startScreensaver === 'function');
  }

  function looksLikeWindowManager(v) {
    return !!(v && typeof v.newWindow === 'function' && typeof v.closeWindow === 'function');
  }

  function resolveByScan(req, needle, validator, log, label) {
    try {
      var m = req.m;
      if (!m || typeof m !== 'object') { log.warn(label + '：模块表不可用，无法扫描'); return null; }
      var ids = Object.keys(m);
      var matched = 0;
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var src = getFactorySource(req, id);
        if (!src || src.indexOf(needle) === -1) continue;
        matched++;
        if (matched <= 3) log.info(label + '：候选模块 ' + id + '（含特征 ' + needle + '）');
        var cand = null;
        try { cand = req(Number(id)); } catch (e) { continue; }
        if (validator(cand)) {
          log.info(label + '：按特征命中模块 ' + id);
          return cand;
        }
      }
      if (matched === 0) log.warn(label + '：模块表共 ' + Object.keys(m).length + ' 项，但没有工厂包含特征 "' + needle + '"');
      else log.warn(label + '：有 ' + matched + ' 个候选，但都不满足形状要求');
    } catch (e) { log.warn(label + '扫描异常: ' + (e && e.message || e)); }
    return null;
  }

  function resolveController(req, log) {
    var c = null;
    try { c = req(120); } catch (e) { }
    if (looksLikeScreensaver(c)) return c;
    return resolveByScan(req, 'screensaverTransitionList', looksLikeScreensaver, log, '屏保控制器');
  }

  function resolveWindowManager(req, log) {
    var w = null;
    try { w = req(69); } catch (e) { }
    if (looksLikeWindowManager(w)) return w;
    return resolveByScan(req, 'resetWindow', looksLikeWindowManager, log, '窗口管理器');
  }
  /* ------------------------------------------------------------------ *
   * 模块定位重试（HugoAura 的做法：模块是懒加载的，boot 时可能还没实例化）
   *   - 最多尝试 30 次，间隔 800ms 起，逐步退避到 5s
   *   - 每次只做「还没搞定」的那部分，成功即停
   * ------------------------------------------------------------------ */


  /** 定时器 unref：重试不该单独把进程吊住（Electron 主进程本来就有 app 保活） */
  function laterTick(fn, ms) {
    var t = setTimeout(fn, ms);
    try { if (t && typeof t.unref === 'function') t.unref(); } catch (e) { }
    return t;
  }

  function startResolverRetry(req, share, cfg, log, state, result) {
    var attempts = 0;
    var maxAttempts = 30;
    var delay = 800;
    var hooked = false;
    var guarded = false;

    function tick() {
      attempts++;
      try {
        if (!hooked) {
          var c = resolveController(req, log);
          if (c) {
            if (installScreensaverHook(c, share, cfg, log, state)) {
              hooked = true;
              result.hook = true;
              log.info('屏保拦截已安装（第 ' + attempts + ' 次尝试命中）');
            }
          }
        }
        if (!guarded) {
          var w = resolveWindowManager(req, log);
          if (w) {
            if (installLockCascadeGuard(w, cfg, log, state)) {
              guarded = true;
              result.lockCascadeGuard = true;
              log.info('级联守卫已安装（第 ' + attempts + ' 次尝试命中）');
            }
          }
        }
      } catch (e) {
        log.warn('重试安装异常: ' + (e && e.message || e));
      }

      if (hooked && guarded) {
        state.ok = true;
        result.installed = true;
        try {
          result.control = installControl(resolveController(req, log), share, resolveWindowManager(req, log), cfg, log, state);
        } catch (e) { }
        log.info('模块定位完成（共尝试 ' + attempts + ' 次）');
        return;
      }
      if (attempts >= maxAttempts) {
        log.warn('模块定位放弃（已尝试 ' + attempts + ' 次）—— 若功能无效请把本日志发回');
        return;
      }
      delay = Math.min(Math.round(delay * 1.5), 5000);
      laterTick(tick, delay);
    }

    laterTick(tick, delay);
  }
  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */

  function boot() {
    var log = createLog();
    try {
      var g = globalThis;

      // 幂等：同一个主进程里重复执行直接跳过
      if (g[GLOBAL_KEY] && g[GLOBAL_KEY].installed) {
        log.debug('aura-screensaver 已安装，跳过');
        return g[GLOBAL_KEY];
      }

      var cfg = loadConfig(log);
      var state = { blocked: 0, overridden: 0, cascadeBlocked: 0, ok: false };

      var req = g[REQ_KEY];
      if (typeof req !== 'function') {
        log.error('未找到 webpack require（' + REQ_KEY + '）—— 注入点可能未生效，放行官方行为');
        g[GLOBAL_KEY] = { installed: false, reason: 'no-webpack-require', state: state };
        return g[GLOBAL_KEY];
      }

      log.info('启动 aura-screensaver 加载器');

      var controller = null, windowManager = null, share = null, lockController = null;

      // 逐个 try/catch：任一模块取不到都不影响其它能力
      try { controller = resolveController(req, log); } catch (e) { log.warn('取屏保控制器失败: ' + (e.message || e)); }
      try { windowManager = resolveWindowManager(req, log); } catch (e) { log.warn('取窗口管理器失败: ' + (e.message || e)); }
      if (!controller) log.warn('屏保控制器未定位到（模块 id 可能随版本漂移，已尝试按特征扫描）');
      if (!windowManager) log.warn('窗口管理器未定位到（已尝试按特征扫描）');
      try { share = req(2); } catch (e) { log.warn('取 share 总线(2)失败: ' + (e.message || e)); }
      try { lockController = req(40); } catch (e) { log.warn('取屏幕锁控制器(40)失败: ' + (e.message || e)); }

      var hookOk = installScreensaverHook(controller, share, cfg, log, state);
      var alignOk = !!(controller && controller.__auraWrapped); // 转场对齐已并入 onMessage 包装
      var guardOk = installLockCascadeGuard(windowManager, cfg, log, state);

      state.ok = hookOk || guardOk;
      var hooksReady = hookOk && guardOk;

      // 控制通道：让 GUI 能「立即预览 / 关闭 / 重载配置」
      var control = installControl(controller, share, windowManager, cfg, log, state);
      var bridgeOk = startCommandBridge(control, log);
      var result = {
        installed: state.ok,
        state: state,
        config: cfg,
        hook: hookOk,
        transitionAligner: alignOk,
        lockCascadeGuard: guardOk,
        control: control,
        commandBridge: bridgeOk,
        modules: {
          controller: !!controller,
          windowManager: !!windowManager,
          share: !!share,
          lockController: !!lockController,
        },
        logFile: log.path(),
        version: '1.0.0',
      };
      g[GLOBAL_KEY] = result;
      // 模块可能还没实例化：启动带退避的重试（HugoAura 同思路）
      if (!hooksReady) { startResolverRetry(req, share, cfg, log, state, result); }
      log.info('aura-screensaver 已安装: ' + JSON.stringify({
        hook: hookOk, guard: guardOk, screensaverEnabled: cfg.screensaverEnabled,
      }));
      return result;
    } catch (e) {
      // 最外层兜底：绝不让注入代码阻断官方启动
      try { log.error('aura-screensaver 启动失败（放行官方行为）: ' + (e && e.stack || e)); } catch (_) {}
      try { globalThis[GLOBAL_KEY] = { installed: false, reason: String(e && e.message || e) }; } catch (_) {}
      return globalThis[GLOBAL_KEY];
    }
  }

  // 暴露 boot 供补丁器追加的「兜底重试」调用（幂等，可重复调用）。
  // 放在全局上而不是返回值里，是因为加载器被追加在文件末尾、没有外层接收者。
  try { globalThis.__AURA_BOOT__ = boot; } catch (e) { /* ignore */ }

  try { boot(); } catch (e) { /* 终极兜底：静默失败，官方 main.js 继续运行 */ }
})();
