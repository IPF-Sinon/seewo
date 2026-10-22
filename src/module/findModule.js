'use strict';
/**
 * src/module/findModule.js —— 在 webpack bundle 文本里按「源码锚点」定位模块 id
 *
 * 背景（来自 .work/app/main.js 的真实结构）：
 *   main.js 是 webpack 4 打包产物，模块形如：
 *       function(e, t, n){ ... e.exports = u },          // 顺序数组形式
 *   模块内通过 `n(38)`、`n(69)` 这类调用引用其它模块。
 *   官方没有模块名表，只能靠**源码里的特征字符串**反查 id。
 *
 * 已验证的真实锚点（逐字来自 main.js）：
 *   - 任务常量模块 38 @40739：
 *       e.exports={SCREENLOCK:"SCREENLOCK",SCHOOLANNOUNCEMENT:"SCHOOLANNOUNCEMENT",
 *                  LIVE:"LIVE",SCREENSAVER:"SCREENSAVER",POPUP_NOTIFICATION:"POPUP_NOTIFICATION"}
 *   - 屏保控制器模块 @159264（紧随其后，id 未硬编码，靠锚点推断）：
 *       const s=n(38),r=n(2),o=n(39),i=n(69),a=n(297),c="/displayScreenSaver";
 *
 * 设计约束：
 *   - 纯文本匹配，**不 require electron、不 eval bundle**（HugoAura 的 dumpModuleIds 同样只读解析）。
 *   - 找不到返回 null，绝不抛异常 —— hook 必须能降级为「不修改、放行原有行为」。
 */

/** 预置锚点表：每条都有 main.js 中的真实依据 */
const ANCHORS = {
  /**
   * 任务类型常量模块（main.js @40739）。
   * 五个常量全部逐字出现，误匹配概率极低。
   */
  taskConstants: {
    id: 'taskConstants',
    description: 'webpack 模块 38：任务类型常量（SCREENLOCK/LIVE/SCREENSAVER/...）',
    patterns: [
      'SCREENLOCK:"SCREENLOCK"',
      'SCREENSAVER:"SCREENSAVER"',
      'POPUP_NOTIFICATION:"POPUP_NOTIFICATION"',
    ],
    // 该模块导出对象里同时含 5 个常量，任一缺失即视为不是目标模块
    requireAll: true,
  },
  /**
   * 屏保控制器（main.js @159264）。
   * `"/displayScreenSaver"` 在整个 bundle 中唯一，是最可靠的锚点。
   */
  screensaverController: {
    id: 'screensaverController',
    description: '屏保控制器：onMessage 监听 /displayScreenSaver 并入队 SCREENSAVER',
    patterns: [
      '"/displayScreenSaver"',
      'screensaverTransitionList',
      'screensaverMessage',
    ],
    requireAll: true,
  },
  /**
   * 任务队列模块（main.js @43395 之前的 n(39)）。
   * 特征："waiting"/"running"/"pause" 三态 + enQueue。
   */
  taskQueue: {
    id: 'taskQueue',
    description: '任务队列：enQueue/outQueue/checkTaskCanRun',
    patterns: ['checkTaskCanRun', 'outQueue', 'enQueue'],
    requireAll: true,
  },
  /**
   * 窗口管理模块（main.js @76173，n(69)）。
   * 特征：newWindow(e,t=!0) + windowsList + addOne。
   */
  windowManager: {
    id: 'windowManager',
    description: '窗口管理：newWindow/closeWindow/resetWindow',
    patterns: ['newWindow(', 'windowsList', 'closeWindow('],
    requireAll: true,
  },
  /**
   * 屏幕锁控制器（main.js @43395）。
   * ★ lockCascadeGuard 依赖它：close 回调里的 startLock() 就是级联锁屏的根因。
   */
  screenLock: {
    id: 'screenLock',
    description: '屏幕锁控制器：startLock/stopLockTask/userLock',
    patterns: ['startLock()', 'stopLockTask', 'forceCloseTaskList'],
    requireAll: true,
  },
};

/*
 * Node 形式的模块头。
 * ★ 实测要点：模块参数个数并不固定。
 *   - 需要 n 的模块：`function(e,t,n){...}`（如屏保控制器，main.js @159264）
 *   - 只导出常量的模块：`function(e,t){...}`（如任务常量模块，main.js @40663）
 * 早期版本只匹配 3 参数，会漏掉常量模块并导致顺序下标整体错位 —— 必须接受 1..4 个参数。
 */
const MODULE_HEAD_RE = /,function\(\s*([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?(?:\s*,\s*([A-Za-z_$][\w$]*))?(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*\)\s*\{/g;

/**
 * 扫描 bundle 文本，返回所有「模块体」的起止下标。
 *
 * 采用括号配对计数：从模块头 `{` 开始，遇到 `{` 深度 +1、`}` 深度 -1，
 * 归零处即模块结束。注意跳过字符串与模板串，避免字符串里的花括号干扰计数。
 *
 * @param {string} source bundle 文本
 * @returns {Array<{start:number, end:number, body:string}>}
 */
function scanModuleBodies(source) {
  const bodies = [];
  if (typeof source !== 'string' || source.length === 0) return bodies;

  MODULE_HEAD_RE.lastIndex = 0;
  let match;
  while ((match = MODULE_HEAD_RE.exec(source)) !== null) {
    // match.index 指向逗号，'){' 之后是模块体起点
    const braceStart = MODULE_HEAD_RE.lastIndex - 1; // 指向 '{'
    const end = findMatchingBrace(source, braceStart);
    if (end > braceStart) {
      bodies.push({
        start: braceStart,
        end: end,
        body: source.slice(braceStart, end + 1),
        params: [match[1], match[2], match[3], match[4]].filter(function (p) { return p !== undefined; }),
      });
    }
    // 从模块尾部之后继续，避免嵌套误扫
    MODULE_HEAD_RE.lastIndex = Math.max(MODULE_HEAD_RE.lastIndex, end + 1);
  }
  return bodies;
}

/**
 * 从 `{` 开始做括号配对，返回匹配 `}` 的下标；找不到返回 -1。
 * 会跳过 ' " ` 三类字符串字面量以及行/块注释，避免误判。
 */
function findMatchingBrace(source, openIndex) {
  if (source[openIndex] !== '{') return -1;
  let depth = 0;
  let i = openIndex;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 跳过字符串字面量，返回结束引号的下一个下标 */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; } // 转义
    if (ch === quote) return i + 1;
    i++;
  }
  return source.length;
}

/**
 * 计算模块顺序下标 -> 模块 id 的映射。
 *
 * webpack 4 的「函数数组」形式里，模块 id 就是它在数组中的下标（0 起）。
 * 我们无法 100% 还原官方 id，因此额外提供「按锚点定位 + 用 n(<id>) 交叉验证」的策略：
 * 见 resolveModule()。
 *
 * @returns {Array<{index:number, start:number, end:number, body:string}>}
 */
function indexModules(source) {
  return scanModuleBodies(source).map(function (m, i) {
    return { index: i, start: m.start, end: m.end, body: m.body };
  });
}

/**
 * 在 bundle 中按锚点查找模块。
 *
 * 返回结构包含：
 *   - moduleId：尽量还原的官方模块 id（优先用交叉验证得到，其次退回顺序下标）
 *   - verified：moduleId 是否通过与 `n(<id>)` 的交叉验证
 *   - index：扫描出的顺序下标（永远可用，作为降级依据）
 *
 * @param {string} source bundle 文本
 * @param {string|object} anchor 锚点名（ANCHORS 的键）或自定义锚点对象
 * @param {object} [options]
 * @param {(text:string)=>any} [options.parser] 可选：注入自定义解析器（测试用）
 * @returns {object|null} 找到返回描述对象，找不到返回 null（绝不抛）
 */
function findModule(source, anchor, options) {
  try {
    const opts = options || {};
    if (typeof opts.parser === 'function') {
      const custom = opts.parser(source);
      if (custom !== undefined && custom !== null) return custom;
    }
    if (typeof source !== 'string' || source.length === 0) return null;

    const spec = typeof anchor === 'string' ? ANCHORS[anchor] : anchor;
    if (!spec || !Array.isArray(spec.patterns) || spec.patterns.length === 0) return null;

    const modules = indexModules(source);
    for (const mod of modules) {
      if (!matchesAnchor(mod.body, spec)) continue;
      const resolved = resolveModuleId(source, mod);
      return {
        anchorId: spec.id || null,
        description: spec.description || '',
        moduleId: resolved.moduleId,
        verified: resolved.verified,
        deps: resolved.deps,
        calibration: resolved.calibration,
        index: mod.index,
        start: mod.start,
        end: mod.end,
        body: mod.body,
        evidence: spec.patterns.filter(function (p) { return mod.body.indexOf(p) !== -1; }),
      };
    }
    return null;
  } catch (err) {
    // 任何解析异常都降级为 null —— hook 侧据此放弃修改，放行原行为
    return null;
  }
}

/** 锚点匹配：requireAll 时要求全部 pattern 命中 */
function matchesAnchor(body, spec) {
  if (spec.requireAll === false) {
    return spec.patterns.some(function (p) { return body.indexOf(p) !== -1; });
  }
  return spec.patterns.every(function (p) { return body.indexOf(p) !== -1; });
}

/**
 * 交叉验证模块 id。
 *
 * 背景：webpack 4 的「函数数组」形式里，模块 id 通常等于它在数组中的顺序下标。
 * 但顺序下标只有在扫描器**没有漏掉任何模块**时才等于官方 id，因此需要独立证据。
 *
 * 验证方法（利用了官方代码里可观察的引用关系）：
 *   屏保控制器（main.js @159264）开头是 `const s=n(38),r=n(2),o=n(39),i=n(69),a=n(297)`，
 *   其中 `n(38)` 指向任务常量模块（该模块体含 SCREENLOCK/SCREENSAVER 常量）。
 *   若「按常量锚点找到的模块」的顺序下标正好是 38，则说明顺序下标 === 官方 id，
 *   此时对任意模块的 index 都可以标记为 verified=true。
 *
 * 这是一个**自校准**过程：不依赖任何硬编码的期望值，全部从源码本身推出。
 *
 * @param {string} source bundle 文本
 * @param {object} mod 目标模块（含 index/body）
 * @returns {{moduleId:number, verified:boolean, deps:number[], calibration:object}}
 */
function resolveModuleId(source, mod) {
  // 本模块体内所有 n(<数字>) 引用
  const deps = extractDeps(mod.body);
  const calibration = calibrateModuleIds(source);
  return {
    moduleId: mod.index,
    verified: calibration.verified,
    deps: deps,
    calibration: calibration,
  };
}

/** 提取模块体里所有 n(<数字>) 引用（去重、升序） */
function extractDeps(body) {
  const deps = [];
  const re = /n\((\d+)\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const v = parseInt(m[1], 10);
    if (deps.indexOf(v) === -1) deps.push(v);
  }
  return deps.sort(function (a, b) { return a - b; });
}

/**
 * 自校准：用「常量模块的顺序下标是否等于控制器里引用的 n(38)」来判定
 * 顺序下标是否可信。结果按 source 长度缓存在内部 Map 上，避免重复扫描。
 *
 * @returns {{verified:boolean, expected:number|null, actual:number|null, reason:string}}
 */
const calibrationCache = new Map();
function calibrateModuleIds(source) {
  if (calibrationCache.has(source)) return calibrationCache.get(source);

  let result = { verified: false, expected: null, actual: null, reason: '未找到校准锚点' };
  const constants = findModuleByAnchor(source, 'taskConstants');
  const controller = findModuleByAnchor(source, 'screensaverController');
  if (constants && controller) {
    const refs = extractDeps(controller.body);
    // 控制器形如 const s=n(38),... 其中 38 应指向常量模块
    if (refs.indexOf(constants.index) !== -1) {
      result = {
        verified: true,
        expected: constants.index,
        actual: constants.index,
        reason: '屏保控制器引用了 n(' + constants.index + ')，与常量模块顺序下标一致',
      };
    } else {
      result = {
        verified: false,
        expected: null,
        actual: constants.index,
        reason: '常量模块顺序下标 ' + constants.index + ' 未被控制器引用，扫描可能漏模块',
      };
    }
  }
  calibrationCache.set(source, result);
  // 防止长驻进程缓存无限增长（bundle 文本很大）
  if (calibrationCache.size > 8) {
    const firstKey = calibrationCache.keys().next().value;
    calibrationCache.delete(firstKey);
  }
  return result;
}

/**
 * 仅按锚点找模块（不做 id 解析），供校准过程内部使用，避免递归。
 * @returns {{index:number, body:string, start:number, end:number}|null}
 */
function findModuleByAnchor(source, anchorKey) {
  const spec = ANCHORS[anchorKey];
  if (!spec) return null;
  const modules = indexModules(source);
  for (const mod of modules) {
    if (matchesAnchor(mod.body, spec)) return mod;
  }
  return null;
}

/**
 * 一次性解析所有已知锚点，供 dumpModuleIds 类诊断使用。
 * 对应 HugoAura-Enhanced 的 scripts/dumpModuleIds.js 用途（只读提取，不执行）。
 *
 * @param {string} source bundle 文本
 * @returns {object} { anchorId: moduleId|null }
 */
function dumpModuleIds(source) {
  const out = {};
  for (const key of Object.keys(ANCHORS)) {
    const found = findModule(source, key);
    out[key] = found ? found.moduleId : null;
  }
  return out;
}

module.exports = {
  ANCHORS: ANCHORS,
  findModule: findModule,
  indexModules: indexModules,
  scanModuleBodies: scanModuleBodies,
  findMatchingBrace: findMatchingBrace,
  dumpModuleIds: dumpModuleIds,
  calibrateModuleIds: calibrateModuleIds,
  extractDeps: extractDeps,
};
