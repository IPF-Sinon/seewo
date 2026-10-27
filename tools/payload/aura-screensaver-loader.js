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
    // 预览时本地路径的形式：'raw' = 原样反斜杠路径（跟随官方形态）
    //                     'file' = 转成 file:///D:/... 并做 URL 编码
    // 实测依据：渲染器两项 bundle 里没有任何 file:// 拼接，且主动把反斜杠翻倍，
    // 故默认 raw。若真机上 CSS url() 加载失败，改成 'file' 即可。
    localUrlMode: 'raw',
    // 网页屏保：enabled=true 时 /displayScreenSaver 不走官方图片渲染器，
    //   而是弹出我们自己的全屏窗口加载 url。
    //   这样动画与版式完全由网页决定（CSS/JS/视频都行），
    //   不必去改官方渲染器里那 7 种写死的转场。
    web: { enabled: false, url: '', closeOnClick: false },
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
    // merge 是浅合并：文件里给了 web 就会整体覆盖默认值，这里补齐缺的字段
    // mode 不在默认配置里 —— 缺省时由 resolveMode 按 web.enabled / override 推断，
    // 这样旧配置（没有 mode 字段）仍然按老行为走。非法值一律清掉。
    if (cfg.mode !== 'web' && cfg.mode !== 'image' && cfg.mode !== 'none') { delete cfg.mode; }

    if (!cfg.web || typeof cfg.web !== 'object' || Array.isArray(cfg.web)) {
      cfg.web = { enabled: false, url: '', closeOnClick: false };
    } else {
      if (typeof cfg.web.enabled !== 'boolean') cfg.web.enabled = false;
      if (typeof cfg.web.url !== 'string') cfg.web.url = '';
      if (typeof cfg.web.closeOnClick !== 'boolean') cfg.web.closeOnClick = false;
    }
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

  /* ------------------------------------------------------------------ *
   * 预览数据源辅助：集控下发的 picture[] / 本地 screen_saver.json
   *   → 统一成渲染器要的 imageList（string[]）
   *
   * 实测依据（SeewoAbility.log 逐字）：集控下发的 screenSaverSetting 是
   *   { data: { picture: [ {fileId, fileMd5, fileUrlType, imageUrl}, ... ] } }
   * 里面**没有 imageList**。而本地 %APPDATA%\seewo\SeewoAbility\screen_saver.json
   * 的 picture[] 是 md5 字符串，图片文件就在同目录下、文件名 === md5。
   * 渲染器 screensaver.js 读的是 imageList 且必须是 string[]，
   * 否则 e.imageList.map(...) 抛异常 —— 而它前一行已经渲染了 materialSource，
   * 于是表现为「素材来源显示了、图片全黑」。这里就是把数据源对齐。
   * ------------------------------------------------------------------ */

  function getScreenSaverDir() {
    try {
      var path = require('path');
      var base = process.env.APPDATA ||
        (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null);
      if (!base) return null;
      return path.join(base, 'seewo', 'SeewoAbility', 'screen_saver');
    } catch (e) { return null; }
  }

  /**
   * 本地路径 → 渲染器可加载的形式。
   *   raw  : 原样返回（交给渲染器的反斜杠翻倍逻辑，跟随官方形态）
   *   file : file:///D:/a%20b/x.jpg（UNC 走 file://server/share）
   * 已是 URL 的（http/file 等）一律不动。
   */
  function toLocalUrl(p, mode) {
    if (typeof p !== 'string' || !p) return p;
    if (mode !== 'file') return p;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return p;
    try {
      var s2 = p.replace(/\\/g, '/');
      if (/^\/\//.test(s2)) return 'file:' + encodeURI(s2);
      if (/^[A-Za-z]:\//.test(s2)) return 'file:///' + encodeURI(s2);
      return 'file:///' + encodeURI(s2.replace(/^\//, ''));
    } catch (e) { return p; }
  }

  /**
   * picture[] → 本地绝对路径数组。
   * 元素可以是 string（md5 或已是绝对路径），也可以是 {fileMd5|md5|fileName|name}。
   */
  function mapPictureEntries(picture, dir) {
    var res = [];
    if (!Array.isArray(picture)) return res;
    var path = null;
    try { path = require('path'); } catch (e) { }
    for (var i = 0; i < picture.length; i++) {
      var e = picture[i], name = null;
      if (typeof e === 'string') name = e;
      else if (e && typeof e === 'object') name = e.fileMd5 || e.md5 || e.fileName || e.name || null;
      if (!name || typeof name !== 'string') continue;
      if (/^[A-Za-z]:[\\\/]/.test(name) || /^\\\\\\\\/.test(name)) { res.push(name); continue; }
      if (!dir || !path) continue;
      res.push(path.join(dir, name));
    }
    return res;
  }

  /**
   * 读本机缓存的 screen_saver.json 作为**离线可用**的预览数据源。
   * 这样即使用户没配 override、集控也还没下发过，也能预览到真实内容。
   */
  function readScreenSaverJson(log) {
    try {
      var fs2 = require('fs'), path2 = require('path');
      var dir = getScreenSaverDir();
      if (!dir) return null;
      var file = path2.join(path2.dirname(dir), 'screen_saver.json');
      if (!fs2.existsSync(file)) return null;
      var j = JSON.parse(fs2.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object') return null;
      var imgs = mapPictureEntries(j.picture, dir);
      if (!imgs.length) return null;
      var texts = [];
      if (Array.isArray(j.text)) {
        for (var i = 0; i < j.text.length; i++) {
          var t = j.text[i];
          if (typeof t === 'string' && t) texts.push({ content: t });
          else if (t && typeof t === 'object' && t.content) {
            var item = { content: String(t.content) };
            if (t.provenance) item.provenance = String(t.provenance);
            texts.push(item);
          }
        }
      }
      var si = Number(j.switchInterval);
      if (!(isFinite(si) && si > 0)) si = 15;
      return {
        file: file, dir: dir,
        data: {
          imageList: imgs,
          textList: texts,
          materialSource: typeof j.materialSource === 'string' ? j.materialSource : '',
          switchInterval: si,
          pictureSizeType: (Number(j.pictureSizeType) === 1) ? 1 : 0
        }
      };
    } catch (e) {
      log.warn('读取 screen_saver.json 失败: ' + (e && e.message || e));
      return null;
    }
  }

  /**
   * 发送前的硬校验。渲染器对 imageList 的要求是 string[]，
   * 不满足时它会在渲染完 materialSource 之后抛异常 → 黑屏。
   * 所以宁可不发，也要给出明确原因。
   */
  function validatePreviewPayload(data, log) {
    var details = [];
    if (!data || typeof data !== 'object') {
      return { ok: false, reason: 'payload-invalid', message: '预览载荷不是对象', details: ['data 类型 = ' + (typeof data)] };
    }
    var imgs = data.imageList;
    if (!Array.isArray(imgs)) {
      var ty = (imgs === undefined) ? 'undefined' : (imgs === null ? 'null' : typeof imgs);
      return {
        ok: false, reason: 'payload-invalid',
        message: '预览载荷里的 imageList 不是数组（实际是 ' + ty + '）。渲染器要求 string[]，否则会抛异常导致黑屏。',
        details: details
      };
    }
    if (!imgs.length) {
      return { ok: false, reason: 'empty-image-list', message: '预览载荷里一张图片都没有。', details: details };
    }
    var bad = 0, missing = 0;
    var fs3 = null;
    try { fs3 = require('fs'); } catch (e) { }
    for (var i = 0; i < imgs.length; i++) {
      if (typeof imgs[i] !== 'string' || !imgs[i]) {
        bad++;
        if (details.length < 4) details.push('第 ' + (i + 1) + ' 项不是非空字符串（类型 ' + (typeof imgs[i]) + '）');
        continue;
      }
      if (details.length < 4 && i < 3) details.push(imgs[i]);
    }
    if (bad > 0) {
      return { ok: false, reason: 'payload-invalid', message: bad + ' 个图片路径不是字符串；渲染器要求 string[]。', details: details };
    }
    if (fs3) {
      for (var j = 0; j < imgs.length; j++) {
        var p = imgs[j];
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) continue;
        try { if (!fs3.existsSync(p)) missing++; } catch (e) { }
      }
    }
    if (details.length < 4) {
      for (var k = 0; k < imgs.length && details.length < 4; k++) details.push(imgs[k]);
    }
    // ★ 文件存在性只作为**警告**，不作为硬失败：
    //   类型契约（string[]）才是黑屏的根因，必须拦住；
    //   而 existsSync 在跨盘符/符号链接/网络盘/权限受限时可能误判，
    //   拿它阻断预览会制造假阴性。缺失数量回传给调用方展示。
    return { ok: true, total: imgs.length, missing: missing, details: details };
  }
  /**
   * 把 override 应用到云端下发的 data 上。
   * ★ 只在 override 提供了对应字段时才覆盖，未提供的字段保持官方原值。
   */
  /**
   * 把 override 叠加到集控载荷上。
   * mode: 'raw' | 'file' —— 决定最终 imageList 里本地路径的形式。
   *   ★ 必须在这里归一化：本函数是「最终 imageList 长什么样」的唯一决策点。
   *   渲染器的 wrapped onMessage 会再次调用 applyOverride，
     若只在调用方转换，hook 重新叠加原始 override 时会把转换结果丢掉。
   * toLocalUrl 对已是 URL 的值是恒等的，所以重复调用安全。
   */
  function applyOverride(data, override, log, mode) {
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

    // 统一把本地路径转成目标形式（file:/// 或原样）。
    // 对已经是 URL 的值恒等，故幂等。
    if (Array.isArray(out.imageList)) {
      out.imageList = out.imageList.map(function (p) { return toLocalUrl(p, mode); });
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
          // ★ 网页屏保：开了就用网页替代官方图片屏保
          try {
            if (resolveMode(cfg) === 'web' && cfg.web && cfg.web.url) {
              var wr = showWebWindow(cfg.web.url, cfg, log, state);
              if (wr && wr.ok) {
                state.blocked++;
                log.info('已用网页屏保替代官方屏保');
                return;
              }
              log.warn('网页屏保失败，回退官方屏保: ' + (wr && wr.message || ''));
            }
          } catch (e) { log.warn('网页屏保异常，回退官方: ' + (e && e.message || e)); }

          // 屏保开启且配置了自定义图集 → 改写载荷后再交给官方逻辑。
          // ★ 注意：必须把**改写后的 msg** 传下去，不能再用 arguments
          //   （arguments 里仍是原始消息，改写会被静默丢弃）。
          var forwarded = msg;
          // ★ 无论有没有自定义图集，都记下集控最后下发的**原始**载荷。
          //   否则 override 为空时预览会说「尚未收到集控下发」，
          //   可实际上屏幕上正在放集控屏保 —— 逻辑死结。
          try {
            if (msg && msg.data && typeof msg.data === 'object') {
              controller.__auraLastPayload = msg.data;
              log.info('已记录集控下发载荷（图片 ' + (((msg.data.imageList) || []).length) + ' 张）');
            }
          } catch (e) { }
          var effOverride = effectiveOverride(cfg);
          if (effOverride) {
            try {
              var data = applyOverride(msg.data, effOverride, log, (cfg.localUrlMode === 'file') ? 'file' : 'raw');
              forwarded = merge(msg, { data: data });
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
            if (effOverride && share && typeof share.share === 'function') {
              var imgs = (forwarded.data && forwarded.data.imageList) || [];
              var tlist = normalizeTransitionList(
                (effOverride && effOverride.transitionList) || null, imgs.length);
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
   * 网页屏保：用网页 / 本地 HTML 当屏保
   *
   * 为什么走这条路而不是加转场类型：
   *   官方的 7 种转场是写在 public/vendor.js 里的固定 CSS 关键帧 + JS 映射，
   *   想加新的必须改渲染器 bundle（1.3MB，类名带构建期哈希），
   *   每次希沃升级都可能失配 —— 风险和收益不成比例。
   *   而网页屏保把「动画怎么放」完全交给网页自己（CSS/JS/视频/Canvas），
   *   既能实现无限自定义动画，又完全不碰官方渲染器。
   *
   * 安全网：任何一步失败都只记日志并返回失败，
   *         由调用方回退到官方屏保 —— 绝不让用户卡在黑屏。
   * ------------------------------------------------------------------ */

  /** 从全局拿 webpack require，再取 electron 模块（req 只在 boot 作用域里，这里要自己取） */
  function getElectronModule() {
    try {
      var r = globalThis[REQ_KEY];
      if (typeof r === 'function') return r(0);
    } catch (e) { }
    return null;
  }

  function normalizeWebUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (v === '') return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return v;
    if (/^[A-Za-z]:[\\\/]/.test(v) || /^\\\\\\\\/.test(v)) {
      try { return 'file:///' + encodeURI(v.replace(/\\/g, '/')); } catch (e) { return v; }
    }
    // POSIX 绝对路径与 //server/share 写法（便携场景/测试环境）
    if (/^\/\//.test(v)) { try { return 'file:' + encodeURI(v); } catch (e) { return v; } }
    if (/^\//.test(v)) { try { return 'file://' + encodeURI(v); } catch (e) { return v; } }
    return v;
  }

  /** 网页打不开时显示的错误页（自带退出按钮，触屏也能点） */
  function buildWebErrorPage(code, desc, url) {
    function esc(x) {
      return String(x == null ? '' : x)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    var css = 'html,body{margin:0;height:100%;background:#111;color:#eee;' +
      'font-family:"Microsoft YaHei UI",system-ui,sans-serif;display:flex;' +
      'align-items:center;justify-content:center}' +
      '.b{max-width:760px;padding:32px;text-align:center}' +
      'h1{font-size:26px;margin:0 0 8px;font-weight:600}' +
      'p{font-size:15px;line-height:1.8;color:#aaa;margin:6px 0}' +
      'code{color:#ffd479;word-break:break-all}' +
      'button{margin-top:26px;padding:16px 44px;font-size:18px;border:0;' +
      'border-radius:10px;background:#2d7ff9;color:#fff;cursor:pointer}' +
      'button:active{background:#1f66cc}';
    var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<style>' + css + '</style></head><body><div class="b">' +
      '<h1>网页打不开</h1>' +
      '<p>错误：<code>' + esc(code) + ' ' + esc(desc) + '</code></p>' +
      '<p>地址：<code>' + esc(url) + '</code></p>' +
      '<p>常见原因：网址写错、域名解析不了、或这台机器访问不了该站点。</p>' +
      '<p>换一个地址后点「保存配置」，再点「预览屏保」。</p>' +
      '<button onclick="auraExit()">退出屏保</button>' +
      '<script>function auraExit(){try{window.close()}catch(e){}' +
      'try{location.href="aura-close://now"}catch(e){}}<\/script>' +
      '</div></body></html>';
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  }

  /**
   * 在页面右下角注入可点击的退出按钮。
   * 用户明确要求「触摸退出的按钮」—— 不能只靠键盘 ESC。
   */
  function injectWebExitButton(w, log) {
    try {
      w.webContents.insertCSS(
        '#__aura_exit_btn{position:fixed;right:20px;bottom:20px;z-index:2147483647;' +
        'background:rgba(0,0,0,.62);color:#fff;border:1px solid rgba(255,255,255,.35);' +
        'border-radius:10px;padding:14px 22px;font:16px/1 "Microsoft YaHei UI",sans-serif;' +
        'cursor:pointer;opacity:.5;transition:opacity .2s;user-select:none;' +
'pointer-events:auto;' +
        '-webkit-user-select:none}' +
        '#__aura_exit_btn:hover,#__aura_exit_btn:active{opacity:1}');
      var js = '(function(){try{' +
        'if(document.getElementById("__aura_exit_btn"))return;' +
        'var b=document.createElement("div");b.id="__aura_exit_btn";' +
        'b.textContent="退出屏保";b.setAttribute("role","button");' +
        'b.onclick=function(ev){try{ev.stopPropagation();ev.preventDefault()}catch(e){};' +
        'try{window.close()}catch(e){};' +
        'try{location.href="aura-close://now"}catch(e){}};' +
        '(document.body||document.documentElement).appendChild(b);' +
        '}catch(e){}})()';
      w.webContents.executeJavaScript(js);
    } catch (e) { log.debug('注入退出按钮失败: ' + (e && e.message || e)); }
  }

  function closeWebWindow(state, log) {
    try {
      // 先解绑全局快捷键，避免屏保关掉后 ESC 还被我们占着
      if (state && state.webShortcut) {
        try { state.webShortcut.unregister('Escape'); } catch (e) { }
        try { state.webShortcut.unregister('CommandOrControl+Alt+Q'); } catch (e) { }
        state.webShortcut = null;
      }
      if (state && state.webWin) {
        try { if (!state.webWin.isDestroyed()) state.webWin.close(); } catch (e) { }
        state.webWin = null;
        log.info('网页屏保已关闭');
      }
      return { ok: true, lastError: (state && state.webLastError) || null };
    } catch (e) { return { ok: true }; }
  }

  /**
   * 挂上网页诊断：把页面加载过程、跳转、失败、页面报错都写进日志。
   *   ★ 用户反馈「有些页面只加载一半」「点热搜不跳转」——
   *     没有这些日志就只能靠猜，所以这里尽量把关键事件都记下来。
   */
  /**
   * 页面脚本语法不被当前内核支持时，显示一条横幅说明。
   * 实测：bbs.lty.fan 的主 bundle 在希沃自带的 Electron/Chromium 上直接
   *   Uncaught SyntaxError: Unexpected token '='
   * 语法错误**运行时无法补救** —— 站点自己的 JS 解析不了，应用就起不来，
   * 只剩 CSS 背景图，看着像「卡住」。这里至少把原因说清楚。
   */
  function showWebCompatBanner(w, log) {
    try {
      w.webContents.insertCSS('#__aura_compat{position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#b3261e;color:#fff;font:14px/1.7 sans-serif;padding:10px 16px;text-align:center;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)}');
      var js = '(function(){try{' +
        'if(document.getElementById("__aura_compat"))return;' +
        'var d=document.createElement("div");d.id="__aura_compat";' +
        'd.textContent="此网站的脚本语法不受希沃自带浏览器内核支持，页面可能只显示一部分";' +
        '(document.body||document.documentElement).appendChild(d);' +
        '}catch(e){}})()';
      var p = w.webContents.executeJavaScript(js);
      if (p && typeof p.then === 'function') { p.catch(function () { }); }
      log.error('已在页面顶部标注「脚本语法不受支持」');
    } catch (e) { log.debug('注入兼容提示失败: ' + (e && e.message || e)); }
  }

  function attachWebDiagnostics(w, cfg, log, state) {
    var wc = w && w.webContents;
    if (!wc) return;

    function on(ev, fn) {
      try { wc.on(ev, fn); } catch (e) { }
    }

    // 1) 跳转：发起（可拦截）、真正开始、完成、页内跳转
    on('will-navigate', function (ev, url) {
      try {
        if (url && url.indexOf('aura-close:') === 0) {
          ev.preventDefault();
          log.info('网页[跳转] 命中退出哨兵，关闭屏保');
          closeWebWindow(state, log);
          return;
        }
        log.info('网页[跳转] will-navigate: ' + url);
      } catch (e) { }
    });
    on('did-start-navigation', function (ev, url, isInPlace, isMainFrame) {
      try {
        if (isMainFrame) log.info('网页[跳转] 开始导航: ' + url + (isInPlace ? '（页内）' : ''));
      } catch (e) { }
    });
    on('did-navigate', function (ev, url, httpCode) {
      try { log.info('网页[跳转] 已到达: ' + url + '  HTTP ' + httpCode); } catch (e) { }
    });
    on('did-navigate-in-page', function (ev, url, isMainFrame) {
      try { if (isMainFrame) log.info('网页[跳转] 页内跳转: ' + url); } catch (e) { }
    });

    // 2) 加载阶段
    on('did-start-loading', function () { try { log.info('网页[加载] 开始'); } catch (e) { } });
    on('did-stop-loading', function () { try { log.info('网页[加载] 结束'); } catch (e) { } });
    on('dom-ready', function () { try { log.info('网页[加载] DOM 就绪'); } catch (e) { } });
    on('did-frame-finish-load', function (ev, isMainFrame) {
      try { if (!isMainFrame) log.debug('网页[加载] 子框架完成'); } catch (e) { }
    });

    // 3) 失败：主框架记 error，子框架也记（但过滤掉正常的 ERR_ABORTED）
    on('did-fail-load', function (ev, code, desc, failedUrl, isMainFrame) {
      try {
        if (code === -3) { log.debug('网页[失败] 忽略 ERR_ABORTED: ' + failedUrl); return; }
        var t = (isMainFrame === false) ? '子框架' : '主框架';
        log.warn('网页[失败] ' + t + ' ' + code + ' ' + desc + ': ' + failedUrl);
        // 子框架失败只记日志；主框架失败要给出可见的错误页 + 退出按钮，
        // 否则用户只看到「闪一下回到桌面」，什么信息都没有。
        if (isMainFrame !== false) {
          state.webLastError = code + ' ' + desc;
          try { w.loadURL(buildWebErrorPage(code, desc, failedUrl)); } catch (e) { }
        }
      } catch (e) { }
    });
    on('did-fail-provisional-load', function (ev, code, desc, failedUrl) {
      try { log.warn('网页[失败] 预加载失败 ' + code + ' ' + desc + ': ' + failedUrl); } catch (e) { }
    });
    on('certificate-error', function (ev, url, err, cert, cb) {
      try { log.warn('网页[证书] 错误 ' + err + ': ' + url); } catch (e) { }
    });
    on('render-process-gone', function (ev, details) {
      try { log.error('网页[崩溃] 渲染进程退出: ' + JSON.stringify(details || {})); } catch (e) { }
    });
    on('unresponsive', function () { try { log.warn('网页[卡死] 无响应'); } catch (e) { } });

    // 3.5) 窗口有焦点时的 ESC（全局快捷键是另一层兜底）
    on('before-input-event', function (ev, input) {
      try {
        if (input && (input.key === 'Escape' || input.keyCode === 'Escape')) closeWebWindow(state, log);
      } catch (e) { }
    });

    // 4) 新窗口请求（bing 热搜这类 target=_blank 就走这里）
    try {
      if (typeof wc.setWindowOpenHandler === 'function') {
        wc.setWindowOpenHandler(function (details) {
          try {
            var u = details && details.url;
            log.info('网页[新窗口] ' + u + ' -> 改为在当前窗口打开');
            if (u && u !== 'about:blank') {
              // 延后一拍再跳，避免在 Electron 的回调里递归触发
              setTimeout(function () { try { w.loadURL(u); } catch (e) { } }, 0);
            } else {
              log.warn('网页[新窗口] 目标地址为空或 about:blank，站点可能在用 window.open 后再赋值');
            }
          } catch (e) { }
          return { action: 'deny' };
        });
      }
    } catch (e) { }

    // 5) 页面自己的报错（console-message 抓不到 window.onerror 之外的未处理 Promise）
    on('did-finish-load', function () {
      try {
        var hook = '(function(){try{' +
          'if(window.__auraErrHooked)return "已挂钩";window.__auraErrHooked=1;' +
          'window.addEventListener("error",function(e){' +
          'console.error("[AURA_PAGE_ERROR] "+(e.message||"")+" @ "+(e.filename||"")+":"+(e.lineno||0));});' +
          'window.addEventListener("unhandledrejection",function(e){' +
          'var r=e&&e.reason;console.error("[AURA_PAGE_ERROR] unhandledrejection: "+((r&&r.message)||r));});' +
          'return "ok";}catch(e){return "ERR:"+e.message}})()';
        var p = wc.executeJavaScript(hook);
        if (p && typeof p.then === 'function') { p.catch(function () { }); }
      } catch (e) { }
    });
    on('did-finish-load', function () {
      try {
        var probe = '(function(){try{' +
          'var rs=(performance&&performance.getEntriesByType)?performance.getEntriesByType("resource"):[];' +
          'var bad=rs.filter(function(x){return x.responseStatus&&x.responseStatus>=400});' +
          'return JSON.stringify({readyState:document.readyState,title:document.title,' +
          'resources:rs.length,badResources:bad.length,' +
          'badSample:bad.slice(0,5).map(function(x){return x.name+"("+x.responseStatus+")"})});' +
          '}catch(e){return "ERR:"+e.message}})()';
        var p2 = wc.executeJavaScript(probe);
        if (p2 && typeof p2.then === 'function') {
          p2.then(function (v) { log.info('网页[概况] ' + v); })
            .catch(function (e) { log.warn('网页[概况] 取不到: ' + (e && e.message || e)); });
        }
      } catch (e) { }
    });

    // 6) target=_blank 的 <a>：在捕获阶段直接原地跳转。
    //    bing 热搜这类点击走的是 window.open，单一依赖 setWindowOpenHandler
    //    会在「先开空白窗口再赋值」的站点上失效，所以这里再兜一层。
    on('did-finish-load', function () {
      try {
        var clickHook = '(function(){try{' +
          'if(window.__auraClickHooked)return "已挂钩";window.__auraClickHooked=1;' +
          'document.addEventListener("click",function(ev){' +
          'try{var n=ev.target;while(n&&n.tagName!=="A"){n=n.parentElement}' +
          'if(!n)return;var t=(n.getAttribute("target")||"").toLowerCase();' +
          'if(t!=="_blank")return;var h=n.href;if(!h)return;' +
          'ev.preventDefault();ev.stopPropagation();location.href=h;' +
          '}catch(e){}},true);return "ok";}catch(e){return "ERR:"+e.message}})()';
        var p3 = wc.executeJavaScript(clickHook);
        if (p3 && typeof p3.then === 'function') { p3.catch(function () { }); }
      } catch (e) { }
    });
  }

  function showWebWindow(url, cfg, log, state) {
    var target = normalizeWebUrl(url);
    if (!target) return { ok: false, reason: 'empty-url', message: '没有填网页地址或本地 HTML 路径' };

    // 本地文件先校验：坏路径直接报错，不要开出全屏黑窗口
    if (/^file:\/\//i.test(target)) {
      try {
        var fsx = require('fs');
        var raw = decodeURI(target.replace(/^file:\/\//i, ''));
        if (/^[A-Za-z]:/.test(raw)) { raw = raw.replace(/\//g, '\\'); }
        if (!fsx.existsSync(raw)) {
          return { ok: false, reason: 'file-not-found', message: '这个文件不存在：' + raw };
        }
        if (fsx.statSync(raw).isDirectory()) {
          return { ok: false, reason: 'is-directory', message: '这是文件夹，不是网页文件：' + raw + '（请选到具体的 .html 文件）' };
        }
      } catch (e) { }
    }

    try {
      var el = getElectronModule();
      var BW = el && el.BrowserWindow;
      if (!BW) return { ok: false, reason: 'no-browserwindow', message: '拿不到 Electron BrowserWindow，无法显示网页' };

      if (state.webWin && !state.webWin.isDestroyed()) {
        state.webWin.loadURL(target);
        log.info('网页屏保已切换地址: ' + target);
        return { ok: true, url: target, reused: true };
      }

      var bounds = null;
      try { if (el.screen) bounds = el.screen.getAllDisplays()[0].bounds; } catch (e) { }

      var opt = {
        frame: false,
        fullscreen: true,
        backgroundColor: '#000000',
        title: 'AuraScreensaver-Web',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      };
      if (bounds) { opt.x = bounds.x; opt.y = bounds.y; opt.width = bounds.width; opt.height = bounds.height; }

      var w = new BW(opt);
      state.webWin = w;
      state.webLastError = null;
      state.webCompatNotified = false;

      // 很多站点会检测 UA 里的 Electron 而走降级分支（JS 行为异常/功能不可用）。
      // 这里把 Electron 标识去掉，让页面认为自己是普通 Chrome。
      try {
        var ua = w.webContents.getUserAgent();
        if (ua) {
          var ua2 = ua.replace(/\sElectron\/[0-9.]+/g, '').replace(/\sAuraScreensaver\/[0-9.]+/g, '');
          if (ua2 !== ua) { w.webContents.setUserAgent(ua2); log.info('已去掉 UA 里的 Electron 标识'); }
        }
      } catch (e) { }
      try { w.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { }

      // 统一挂上网页诊断（加载/跳转/失败/页面报错）
      attachWebDiagnostics(w, cfg, log, state);
      try { w.setMenuBarVisibility(false); } catch (e) { }

      // ★ 加载超时保护：60 秒还没渲染出来就显示错误页（网络卡住也有出口）
      var loaded = false;
      try { w.webContents.on('did-finish-load', function () { loaded = true; }); } catch (e) { }
      try {
        var t = setTimeout(function () {
          try {
            if (!loaded && state.webWin === w) {
              log.warn('网页 60 秒内没有加载完成，转到错误页');
              state.webLastError = 'load-timeout';
              try { w.loadURL(buildWebErrorPage('timeout', '加载超时', target)); } catch (e) { }
            }
          } catch (e) { }
        }, 60000);
        if (t && typeof t.unref === 'function') t.unref();
      } catch (e) { }

      // ★ 全局快捷键：不依赖窗口焦点 —— 这是「什么都操作不了」的兜底出口
      try {
        var gs = el.globalShortcut;
        if (gs) {
          try { gs.register('Escape', function () { closeWebWindow(state, log); }); } catch (e) { }
          try { gs.register('CommandOrControl+Alt+Q', function () { closeWebWindow(state, log); }); } catch (e) { }
          state.webShortcut = gs;
        }
      } catch (e) { }

      // 可选：点一下鼠标就关（默认关，避免误触）
      if (cfg && cfg.web && cfg.web.closeOnClick) {
        try {
          w.webContents.on('before-input-event', function (ev, input) {
            try { if (input && input.type === 'mouseDown') closeWebWindow(state, log); } catch (e) { }
          });
        } catch (e) { }
      }

      try { w.on('closed', function () { state.webWin = null; }); } catch (e) { }

      w.loadURL(target);
      try { w.focus(); } catch (e) { }

      // ★ 把页面自己的 console 转发到我们的日志。
      //   用户反馈「网页 js 似乎不生效」—— 只有拿到页面报错才能定位，不能靠猜。
      try {
        w.webContents.on('console-message', function () {
          try {
            var av = Array.prototype.slice.call(arguments);
            var lv = av[1], msg = av[2], src = av[4];
            var m = String(msg);
            log.info('页面控制台[' + lv + '] ' + m.slice(0, 300) + (src ? ' @ ' + src : ''));
            // 语法错误运行时无法补救：站点自己的 JS 解析不了，应用就不会启动
            // （常见表现：只剩背景图、点了没反应）。
            if (/SyntaxError/i.test(m) && !state.webCompatNotified) {
              state.webCompatNotified = true;
              log.error('网页脚本语法不被当前浏览器内核支持（希沃自带内核较旧），该网站无法在这里正常运行');
              showWebCompatBanner(w, log);
            }
          } catch (e) { }
        });
      } catch (e) { }

      // 渲染进程崩溃 / 无响应也要记下来
      try {
        w.webContents.on('render-process-gone', function (ev, details) {
          try { log.error('网页渲染进程退出: ' + JSON.stringify(details || {})); } catch (e) { }
        });
        w.webContents.on('unresponsive', function () {
          try { log.warn('网页无响应'); } catch (e) { }
        });
      } catch (e) { }

      // ★ JS 自检：正常应返回 2。若返回 ERR 或整体失败，说明页面 JS 被禁/被拦。
      try {
        w.webContents.on('did-finish-load', function () {
          try {
            var p = w.webContents.executeJavaScript('(function(){try{return String(1+1)}catch(e){return "ERR:"+e.message}})()');
            if (p && typeof p.then === 'function') {
              p.then(function (v) { log.info('网页 JS 自检: ' + v + '（2 = 正常）'); })
               .catch(function (e) { log.warn('网页 JS 自检失败: ' + (e && e.message || e)); });
            }
          } catch (e) { log.warn('网页 JS 自检异常: ' + (e && e.message || e)); }
        });
      } catch (e) { }

      // 每次加载完成都注入退出按钮（页面内跳转后按钮会被清掉）
      try {
        w.webContents.on('did-finish-load', function () {
          try { injectWebExitButton(w, log); } catch (e) { }
        });
      } catch (e) { }

      log.info('网页屏保已显示: ' + target);
      return { ok: true, url: target };
    } catch (e) {
      log.error('显示网页屏保失败: ' + (e && e.message || e));
      return { ok: false, reason: 'exception', message: String(e && e.message || e) };
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
  /** 解析当前模式；兼容没有 mode 字段的旧配置 */
  function resolveMode(cfg) {
    var m = cfg && cfg.mode;
    if (m === 'web' || m === 'image' || m === 'none') return m;
    if (cfg && cfg.web && cfg.web.enabled) return 'web';
    if (cfg && cfg.override) return 'image';
    return 'none';
  }

  /**
   * 当前模式实际要叠加的 override。
   *   image -> 原样（含 imageList，替换图片与文案）
   *   none  -> 只取「显示参数」（切换间隔/图片适配/转场），图片与文案仍用集控的
   *   web   -> 不用 override
   * 这样「不修改」也能调参数，而且切模式不会丢设置。
   */
  function effectiveOverride(cfg) {
    var ov = cfg && cfg.override;
    if (!ov || typeof ov !== 'object') return null;
    if (resolveMode(cfg) === 'image') return ov;
    if (resolveMode(cfg) === 'web') return null;
    var only = {};
    if (typeof ov.switchInterval === 'number') only.switchInterval = ov.switchInterval;
    if (ov.pictureSizeType === 0 || ov.pictureSizeType === 1) only.pictureSizeType = ov.pictureSizeType;
    if (Array.isArray(ov.transitionList)) only.transitionList = ov.transitionList;
    var k = 0, kk;
    for (kk in only) { if (Object.prototype.hasOwnProperty.call(only, kk)) k++; }
    return k ? only : null;
  }

  function buildPreviewPayload(cfg, controller, log) {
    var mode = (cfg && cfg.localUrlMode === 'file') ? 'file' : 'raw';
    var attempts = [];
    var last = controller && controller.__auraLastPayload;

    function finish(data, source, note) {
      var out2 = data;
      // 「不修改图片」模式下只把显示参数叠上去（图片与文案仍用集控的）
      if (source !== 'override') {
        var ovp = cfg && cfg.override;
        if (ovp && typeof ovp === 'object') {
          var po = {};
          if (typeof ovp.switchInterval === 'number') po.switchInterval = ovp.switchInterval;
          if (ovp.pictureSizeType === 0 || ovp.pictureSizeType === 1) po.pictureSizeType = ovp.pictureSizeType;
          if (Array.isArray(ovp.transitionList)) po.transitionList = ovp.transitionList;
          var hasP = false, kp;
          for (kp in po) { if (Object.prototype.hasOwnProperty.call(po, kp)) { hasP = true; break; } }
          if (hasP) {
            try { out2 = applyOverride(out2, po, log, mode); log.info('已叠加显示参数（切换间隔/适配/转场）'); } catch (e) { }
          }
        }
      }
      if (Array.isArray(out2.imageList)) {
        out2.imageList = out2.imageList.map(function (p) { return toLocalUrl(p, mode); });
      }
      if (note) log.info(note);
      return { data: out2, source: source };
    }

    // ① 用户在界面里配的自定义图集（最高优先级）
    var ov = effectiveOverride(cfg);
    if (ov && typeof ov === 'object') {
      var imgs = Array.isArray(ov.imageList)
        ? ov.imageList.filter(function (p) { return typeof p === 'string' && p.length > 0; })
        : [];
      if (imgs.length) {
        var base = { imageList: imgs, textList: [], materialSource: '', switchInterval: 15, pictureSizeType: 0 };
        if (Array.isArray(ov.textList)) base.textList = ov.textList;
        if (typeof ov.materialSource === 'string') base.materialSource = ov.materialSource;
        if (typeof ov.switchInterval === 'number') base.switchInterval = ov.switchInterval;
        if (typeof ov.pictureSizeType === 'number') base.pictureSizeType = ov.pictureSizeType;
        return finish(applyOverride(base, ov, log, mode), 'override', '预览数据源：界面自定义图集（' + imgs.length + ' 张）');
      }
      attempts.push('配置里勾选了自定义图集，但图片列表是空的');
    } else {
      attempts.push('配置里没有自定义图集（override 为空）');
    }

    // ② 集控最后下发的载荷（已经是渲染器要的 imageList）
    if (last && typeof last === 'object') {
      if (Array.isArray(last.imageList) && last.imageList.length) {
        var d2 = merge(last, {});
        return finish(d2, 'last-payload', '预览数据源：集控最后下发的 imageList（' + last.imageList.length + ' 张）');
      }
      attempts.push('集控下发载荷里没有可用的 imageList');

      // ③ 集控载荷是 picture[]（实测真实形态，没有 imageList）→ 映射到本地缓存文件
      var mapped = mapPictureEntries(last.picture, getScreenSaverDir());
      if (mapped.length) {
        var si = Number(last.switchInterval);
        if (!(isFinite(si) && si > 0)) si = 15;
        var ps = (Number(last.pictureSizeType) === 1) ? 1 : 0;
        return finish({
          imageList: mapped,
          textList: Array.isArray(last.textList) ? last.textList : [],
          materialSource: typeof last.materialSource === 'string' ? last.materialSource : '',
          switchInterval: si,
          pictureSizeType: ps
        }, 'cloud-picture', '预览数据源：集控 picture[] 映射到本地缓存（' + mapped.length + ' 张）');
      }
      attempts.push('集控载荷的 picture[] 没能映射出本地图片文件');
    } else {
      attempts.push('尚未收到任何集控下发');
    }

    // ④ 本机缓存的 screen_saver.json —— 离线也能预览（不需要 override、不需要等集控）
    var ss = readScreenSaverJson(log);
    if (ss) {
      var d4 = merge(ss.data, {});
      d4.imageList = ss.data.imageList.slice();
      return finish(d4, 'screen-saver-json',
        '预览数据源：本地缓存 ' + ss.file + '（' + d4.imageList.length + ' 张）');
    }
    attempts.push('本机 %APPDATA%\\seewo\\SeewoAbility\\screen_saver.json 不存在或没有图片');

    return {
      error: '没有可用的预览数据。' + attempts.join('；') + '。' +
        '可在界面里勾选「使用自定义图集」并添加图片，或等集控下发一次。',
      reason: 'no-payload',
      attempts: attempts
    };
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

    control.preview = function (args) {
      if (!controller || typeof controller.onMessage !== 'function') {
        return { ok: false, reason: 'no-controller', message: '屏保控制器(120)未就绪，无法预览' };
      }
      // ★ 预览前先重读磁盘配置：GUI 保存后 loader 里的 cfg 还是 boot 时的旧值，
      //   不重载就会出现「界面里明明填了图片，却说 override 为空」。
      try {
        var freshCfg = loadConfig(log);
        var k;
        for (k in cfg) { if (Object.prototype.hasOwnProperty.call(cfg, k)) { delete cfg[k]; } }
        for (k in freshCfg) { if (Object.prototype.hasOwnProperty.call(freshCfg, k)) { cfg[k] = freshCfg[k]; } }
        log.info('预览前已重载配置: override=' + (cfg.override ? '有' : '空'));
      } catch (e) { log.warn('预览前重载配置失败: ' + (e && e.message || e)); }
      var mode0 = (cfg.localUrlMode === 'file') ? 'file' : 'raw';
      var built = null;

      // ★ 界面可以把「当前编辑中的配置」直接当载荷传进来，
      //   这样预览不必先把配置写盘 —— 「保存」与「预览」彻底独立。
      var provided = args && args.payload;
      if (provided && typeof provided === 'object' &&
          Array.isArray(provided.imageList) && provided.imageList.length) {
        var p0 = merge(provided, {});
        p0.imageList = provided.imageList
          .filter(function (p) { return typeof p === 'string' && p.length > 0; })
          .map(function (p) { return toLocalUrl(p, mode0); });
        if (!Array.isArray(p0.textList)) p0.textList = [];
        if (typeof p0.materialSource !== 'string') p0.materialSource = '';
        var si0 = Number(p0.switchInterval);
        p0.switchInterval = (isFinite(si0) && si0 > 0) ? si0 : 15;
        if (p0.pictureSizeType !== 0 && p0.pictureSizeType !== 1) p0.pictureSizeType = 0;
        built = { data: p0, source: 'provided' };
        log.info('预览使用界面直传载荷（' + p0.imageList.length + ' 张），不依赖已保存的配置');
      } else {
        built = buildPreviewPayload(cfg, controller, log);
      }
      if (built.error) return { ok: false, reason: built.reason, message: built.error };

      // ★ 发送前硬校验：渲染器要求 imageList 是 string[]，
      //   不满足时它会在渲染完 materialSource 之后抛异常 → 黑屏。
      //   宁可不发，也要把原因说清楚。
      var check = validatePreviewPayload(built.data, log);
      if (!check.ok) {
        log.error('预览载荷不合格，已中止: ' + check.message);
        if (check.details && check.details.length) log.error('  详情: ' + check.details.join(' | '));
        return { ok: false, reason: check.reason, message: check.message, details: check.details || [] };
      }

      var firstImg = built.data.imageList[0];
      log.info('预览载荷: 来源=' + built.source + ' 图片=' + built.data.imageList.length + ' 张(缺失 ' + (check.missing || 0) + ')' +
        ' materialSource="' + String(built.data.materialSource || '') + '" switchInterval=' + built.data.switchInterval + ' pictureSizeType=' + built.data.pictureSizeType);
      log.info('路径形式对比（localUrlMode=' + ((cfg.localUrlMode === 'file') ? 'file' : 'raw') + '）: raw="' + firstImg + '" | file="' + toLocalUrl(firstImg, 'file') + '"');
      if (check.missing) log.warn('有 ' + check.missing + ' 张图片文件不存在，屏保上会显示空白');

      var payload = built.data;
      state.previewBypass = true;
      try {
        controller.onMessage({ url: SCREENSAVER_ROUTE, data: payload });
        log.info('已触发屏保预览（来源=' + built.source + '，图片 ' + ((payload.imageList || []).length) + ' 张）');
        return { ok: true, source: built.source, imageCount: (payload.imageList || []).length, missingCount: (check.missing || 0) };
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

    control.showWeb = function (a) {
      var u = (a && a.url) || (cfg.web && cfg.web.url) || '';
      return showWebWindow(u, cfg, log, state);
    };

    control.closeWeb = function () { return closeWebWindow(state, log); };

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
      var bridgeStartMs = Date.now();

      // ★ 启动时清掉上一次会话遗留的命令文件。
      //   否则每次重启都会把「上次点过的命令」再执行一遍：
      //   实测证据（SeewoServiceAssistant_20261026.log）：
      //     06:41:34.940 程序启动
      //     06:41:36.313 SCREENSAVER指令入队   <- 1.4 秒后，且日志里没有任何用户操作
      //   原因就是 lastSeq 每次启动都从 0 开始，而 command.json 还留在磁盘上。
      try {
        if (fs.existsSync(cmdFile)) {
          fs.unlinkSync(cmdFile);
          log.info('已清理上次会话遗留的命令文件（避免开机重放旧命令）');
        }
      } catch (e) { log.warn('清理遗留命令文件失败: ' + (e && e.message || e)); }

      var timer = setInterval(function () {
        try {
          if (!fs.existsSync(cmdFile)) return;
          var cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
          if (!cmd || typeof cmd !== 'object') return;
          var seq = Number(cmd.seq) || 0;
          if (seq <= lastSeq) return;
          lastSeq = seq;

          // 双保险：命令时间早于本进程启动时间的一律忽略（跨会话的旧命令）
          if (cmd.at) {
            var atMs = Date.parse(cmd.at);
            if (isFinite(atMs) && atMs < bridgeStartMs) {
              log.info('忽略跨会话的旧命令: ' + cmd.cmd + '（' + cmd.at + '）');
              try { fs.unlinkSync(cmdFile); } catch (e) { }
              return;
            }
          }

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
          // 消费完就删：同一命令绝不能被下个会话重放
          try { fs.unlinkSync(cmdFile); } catch (e) { }
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

  /**
   * 解包导出：兼容三种形态
   *   1) 直接是实例           { onMessage, startScreensaver }
   *   2) ES module 包装        { __esModule:true, default: 实例 }
   *   3) { default: 实例 }（没有 __esModule 标记）
   */
  function unwrapExport(v) {
    if (!v) return null;
    try {
      if (v.__esModule && v.default) return v.default;
      if (v.default && typeof v.default === 'object' && typeof v.onMessage !== 'function') return v.default;
    } catch (e) { }
    return v;
  }

  /** 沿原型链判断这些方法是否都是函数（希沃部分类在构造器里 bind，方法可能在原型上） */
  function hasAllMethods(obj, names) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
    var targets = [obj];
    try {
      var p = Object.getPrototypeOf(obj);
      var guard = 0;
      while (p && p !== Object.prototype && guard < 8) {
        targets.push(p);
        p = Object.getPrototypeOf(p);
        guard++;
      }
    } catch (e) { }
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var ok = true;
      for (var j = 0; j < names.length; j++) {
        if (!t || typeof t[names[j]] !== 'function') { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  function looksLikeScreensaver(v) {
    return hasAllMethods(unwrapExport(v), ['onMessage', 'startScreensaver']);
  }

  function looksLikeWindowManager(v) {
    return hasAllMethods(unwrapExport(v), ['newWindow', 'closeWindow']);
  }

  function resolveByScan(req, needle, validator, log, label) {
    try {
      var m = req.m;
      if (!m || typeof m !== 'object') { log.warn(label + '：模块表不可用，无法扫描'); return null; }
      var ids = Object.keys(m);
      var matched = 0;
      var lastFailedId = null;
      var lastFailedKeys = '(n/a)';
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var src = getFactorySource(req, id);
        if (!src || src.indexOf(needle) === -1) continue;
        matched++;
        if (matched <= 3) log.info(label + '：候选模块 ' + id + '（含特征 ' + needle + '）');
        var cand = null;
        try {
          cand = req(Number(id));
        } catch (e) {
          // ★ 别静默吞掉：依赖链没就绪时 req() 会抛（例如模块 24 的原生绑定），
          //   这正是「有候选但都不满足形状」的真实原因。记下来便于诊断。
          lastFailedId = id;
          lastFailedKeys = 'req() 抛错 -> ' + (e && e.message || e);
          continue;
        }
        if (!validator(cand)) {
          lastFailedId = id;
          try {
            var u = unwrapExport(cand);
            if (u && typeof u === 'object') { lastFailedKeys = Object.keys(u).slice(0, 12).join(',') || '(空对象)'; }
            else { lastFailedKeys = 'typeof=' + (typeof u); }
          } catch (e) { lastFailedKeys = '(读取键失败)'; }
          continue;
        }
        if (validator(cand)) {
          log.info(label + '：按特征命中模块 ' + id);
          return unwrapExport(cand) || cand;
        }
      }
      if (matched === 0) log.warn(label + '：模块表共 ' + Object.keys(m).length + ' 项，但没有工厂包含特征 "' + needle + '"');
      else log.warn(label + '：有 ' + matched + ' 个候选，但都不满足形状要求');

        if (lastFailedId !== null) {
          log.warn(label + '：候选 ' + lastFailedId + ' 诊断 = ' + lastFailedKeys);
        }
    } catch (e) { log.warn(label + '扫描异常: ' + (e && e.message || e)); }
    return null;
  }

  function resolveController(req, log) {
    var c = null;
    try { c = req(120); } catch (e) { log.debug('req(120) 抛错: ' + (e && e.message || e)); }
    if (looksLikeScreensaver(c)) return unwrapExport(c) || c;
    // 空壳 = 工厂曾抛异常被缓存；清掉缓存后重取一次
    if (isPoisoned(c)) {
      if (clearPoisonedCache(req, 120)) {
        log.info('已清除模块 120 的污染缓存，重新执行工厂');
        try {
          var c2 = req(120);
          if (looksLikeScreensaver(c2)) return unwrapExport(c2) || c2;
        } catch (e2) { log.warn('重取 req(120) 仍失败: ' + (e2 && e2.message || e2)); }
      }
    }
    return resolveByScan(req, 'screensaverTransitionList', looksLikeScreensaver, log, '屏保控制器');
  }

  function resolveWindowManager(req, log) {
    var w = null;
    try { w = req(69); } catch (e) { log.debug('req(69) 抛错: ' + (e && e.message || e)); }
    if (looksLikeWindowManager(w)) return unwrapExport(w) || w;
    if (isPoisoned(w)) {
      if (clearPoisonedCache(req, 69)) {
        log.info('已清除模块 69 的污染缓存，重新执行工厂');
        try {
          var w2 = req(69);
          if (looksLikeWindowManager(w2)) return unwrapExport(w2) || w2;
        } catch (e2) { log.warn('重取 req(69) 仍失败: ' + (e2 && e2.message || e2)); }
      }
    }
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

  /* ------------------------------------------------------------------ *
   * 等待 Electron app ready 后再定位模块（★ 这是真正的根因修复）
   *
   * 实测日志：req(120) 抛错 "The 'screen' module can't be used before the
   * app 'ready' event"。模块 69/120 在工厂里就访问了 electron.screen，
   * 而我们的加载器在文件末尾执行时 app 还没 ready。
   *
   * ★ 致命之处：webpack 的 n(s) 是
   *     if(t[s]) return t[s].exports;
   *     var r = t[s] = {i:s, l:!1, exports:{}};   // 先塞缓存
   *     e[s].call(r.exports, r, r.exports, n)     // 抛异常也没回滚缓存
   *   所以第一次失败后，缓存里留下了空 exports —— 之后永远返回那个空对象。
   *   单纯重试毫无意义（这正是之前 30 次重试全部拿到 (空对象) 的原因）。
   *
   * 正确做法：
   *   1) 等 app ready（或已有的 browser-window-created 等生命周期事件）
   *   2) 清掉被污染的缓存条目 n.c[id]，强制 webpack 重新执行工厂
   *   3) 再取模块
   * ------------------------------------------------------------------ */

  function getElectronApp(req) {
    try {
      var el = req(0);              // 模块 0 = electron
      return (el && el.app) || null;
    } catch (e) { return null; }
  }

  /** 清掉某模块被污染的缓存，让 webpack 下次重新执行它的工厂 */
  function clearPoisonedCache(req, id) {
    try {
      var cache = req.c;
      if (cache && Object.prototype.hasOwnProperty.call(cache, id)) {
        delete cache[id];
        return true;
      }
    } catch (e) { }
    return false;
  }

  /** 判断某个模块当前取到的是不是「被污染的空壳」 */
  function isPoisoned(v) {
    if (!v) return true;
    if (typeof v !== 'object' && typeof v !== 'function') return true;
    try { return Object.keys(v).length === 0; } catch (e) { return false; }
  }

  /**
   * 在 app ready 之后执行 fn。已是 ready 状态就直接执行。
   * 不依赖 app.whenReady 的 Promise（不同 Electron 版本行为略有差异），
   * 优先用事件 + isReady 轮询双保险。
   */
  function whenAppReady(req, log, fn) {
    var app = getElectronApp(req);
    if (!app) { log.warn('取不到 electron.app —— 直接尝试定位模块'); fn(); return; }

    var done = false;
    function run() {
      if (done) return;
      done = true;
      try { fn(); } catch (e) { log.warn('ready 后定位异常: ' + (e && e.message || e)); }
    }

    try {
      if (app.isReady && app.isReady()) { run(); return; }
    } catch (e) { }

    try {
      if (typeof app.once === 'function') app.once('ready', run);
    } catch (e) { }

    // 兜底轮询：某些宿主时序不同，事件可能已错过
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var r = false;
      try { r = !!(app.isReady && app.isReady()); } catch (e) { }
      if (r || tries > 100) {
        clearInterval(timer);
        if (r) run();
        else { log.warn('等待 app ready 超时 —— 仍尝试定位模块'); run(); }
      }
    }, 200);
    try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (e) { }
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
          // ★ 不要在这里无条件清缓存。
          //   resolveController 内部只在「确实拿到空壳」时才清，
          //   而无条件清会让下一次 require 重新执行工厂 —— 官方代码若在
          //   close 时 require 一次，就会拿到一个全新的空实例。
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
          if (cfg && cfg.lockCascadeOnClose) {
            // ★ 这是「故意不装守卫」，不是失败。
            //   之前这里继续走 resolveWindowManager 并每轮 clearPoisonedCache(req,69)，
            //   把官方窗口管理器换成了全新的空实例（windows 列表为空）——
            //   于是 closeWindow() 找不到屏保窗口，表现为
            //   「点屏幕退不出屏保，只能 Alt+F4」。实测日志里就是这样狂刷的。
            guarded = true;
            result.lockCascadeGuard = false;
            log.info('lockCascadeOnClose=true：跳过级联守卫，且不再触碰模块 69');
          } else {
            var w = resolveWindowManager(req, log);
            if (w) {
              if (installLockCascadeGuard(w, cfg, log, state)) {
                guarded = true;
                result.lockCascadeGuard = true;
                log.info('级联守卫已安装（第 ' + attempts + ' 次尝试命中）');
              }
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

      // ★ 必须等 app ready：模块 69/120 的工厂会访问 electron.screen，
      //   未 ready 时取模块会抛异常，且 webpack 会把空 exports **永久缓存**
      //   （n(s): 先 t[s]={exports:{}} 再执行工厂，抛异常不回滚）——
      //   一次失败就永久失败，所以必须等到 ready 再取第一次。
      var appReady = false;
      try {
        var elApp = getElectronApp(req);
        appReady = !!(elApp && elApp.isReady && elApp.isReady());
      } catch (e) { }
      log.info('app ready = ' + appReady);

      var controller = null, windowManager = null, share = null, lockController = null;

      if (!appReady) {
        // 未 ready：先只装 share/命令桥，模块定位交给 ready 回调
        log.info('尚未 app ready —— 推迟模块定位，等 ready 后再挂钩');
        try { share = req(2); } catch (e) { }
        var early = {
          installed: false, deferred: true, state: state, config: cfg,
          hook: false, lockCascadeGuard: false, modules: { controller: false, windowManager: false, share: !!share },
          logFile: log.path(), version: '1.0.0'
        };
        g[GLOBAL_KEY] = early;
        whenAppReady(req, log, function () {
          log.info('app ready 达成 —— 开始定位模块');
          try {
            var c0 = resolveController(req, log);
            var w0 = resolveWindowManager(req, log);
            var s0 = null; try { s0 = req(2); } catch (e) { }
            var h0 = installScreensaverHook(c0, s0, cfg, log, state);
            var gd0 = installLockCascadeGuard(w0, cfg, log, state);
            state.ok = h0 || gd0;
            var ctl0 = installControl(c0, s0, w0, cfg, log, state);
            early.installed = state.ok;
            early.deferred = false;
            early.hook = h0;
            early.lockCascadeGuard = gd0;
            early.control = ctl0;
            early.modules = { controller: !!c0, windowManager: !!w0, share: !!s0 };
            early.commandBridge = startCommandBridge(ctl0, log);
            log.info('aura-screensaver 已安装(ready后): ' + JSON.stringify({ hook: h0, guard: gd0 }));
            var needGuard = !(cfg && cfg.lockCascadeOnClose);
            if (!(h0 && (gd0 || !needGuard))) { startResolverRetry(req, s0 || {}, cfg, log, state, early); }
          } catch (e) {
            log.error('ready 后安装失败: ' + (e && e.message || e));
          }
        });
        return early;
      }

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
      // lockCascadeOnClose=true 时守卫是「故意不装」，不算没准备好
      var needGuard = !(cfg && cfg.lockCascadeOnClose);
      var hooksReady = hookOk && (guardOk || !needGuard);

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
