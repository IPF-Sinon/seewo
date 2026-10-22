/**
 * tools/patch-asar.js —— 把「关闭屏保 + 深度配置屏保」hook 注入希沃管家 app.asar
 *
 * ★ 设计依据（全部来自 .work/ 的一手逆向结论，并已在真实 bundle 上实测）
 *
 *   1) app/main.js 是标准 webpack 4「函数数组」式 bundle，整体结构为：
 *        !function(e){
 *          var t={};
 *          function n(s){ if(t[s])return t[s].exports;
 *                        var r=t[s]={i:s,l:!1,exports:{}};
 *                        return e[s].call(r.exports, r, r.exports, n), r.l=!0, r.exports }
 *          n.m=e, n.c=t, ... , n.p="", n(n.s=140)
 *        }([ function(e,t){...}, function(e,t,n){...}, ... ]);
 *
 *   2) 模块 id === 数组下标。实测（.work/app/main.js，共 378 个模块）：
 *        模块 120 = 屏保控制器实例（e.exports = u，有 onMessage/startScreensaver/stopScreensaver/closeWindow）
 *        模块  69 = 窗口管理器实例（e.exports = c，有 newWindow/resetWindow/closeWindow）
 *        模块  40 = 屏幕锁控制器实例（有 startLock/startLockTask/userLock）
 *        模块 140 = 入口（n(n.s=140)）
 *
 *   3) ★ 注入点有两个，缺一不可：
 *
 *      (A) bootstrap 尾部插一处 global 赋值，把 webpack require 暴露出来：
 *            n.p="",n(n.s=140)}([   ->   n.p="",global.__AURA_REQ__=n,n(n.s=140)}([
 *
 *          为什么必须在这里：webpack require（变量 n）与模块表（e / t）都是外层 IIFE 的
 *          **局部变量**，外部代码无法访问，必须从 IIFE 内部把它挂出去。
 *          锚点用正则定位（/n\.p="",n\(n\.s=(\d+)\)\}\(\[/），**不硬编码入口 id**。
 *
 *      (B) 文件**末尾追加**加载器。
 *
 *          为什么末尾合法：整个 bundle 是一条完整表达式语句，以 "]);" 结尾
 *          （实测末尾 3 个字符依次为 ']' ')' ';'），追加的是独立语句，语法合法；
 *          且此时 n(n.s=140) 已执行完，所需模块可从 require 缓存取出**同一个单例**。
 *
 *   4) 实测证据（在真实 .work/app/main.js 上跑通；仅桩掉 Linux 下无法加载的
 *      原生 DLL 模块 193/90 与入口 140）：
 *        typeof __AURA_REQ__        = function   ✅
 *        req(120).onMessage         = function   ✅ 真实屏保控制器实例
 *        req(69).newWindow          = function   ✅ 真实窗口管理器实例
 *        req(40).startLock          = function   ✅ 真实屏幕锁控制器实例
 *        拦截 /displayScreenSaver   = 成功，其余路由正常放行 ✅
 *        req(120) === req(120)      = true（实例身份稳定）✅
 *
 * ★ Verify.json 可行性：只校验 43 项（DLL + 2 个 exe + resources/assets/dlls/*.dll），
 *   **app.asar 不在校验清单内** → 重打包可行。**绝不要改 .exe**（在清单内）。
 *
 * 用法：
 *   node tools/patch-asar.js --dry-run                  # 只输出计划，不写任何文件
 *   node tools/patch-asar.js --target <app.asar>        # 指定 asar 路径
 *   node tools/patch-asar.js --config <config.json>     # 指定注入的初始配置
 *   node tools/patch-asar.js --out <new.asar>           # 输出到别的路径（自测用）
 *   node tools/patch-asar.js --restore                  # 从 app.asar.bak 还原
 *
 * 默认行为：备份 app.asar → app.asar.bak（已存在则**保留不覆盖**），然后写出新的 app.asar。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 注入后暴露 webpack require 的全局键（loader 侧同名） */
const REQ_KEY = '__AURA_REQ__';

/**
 * bootstrap 尾部锚点。
 * 实测原文（.work/app/main.js @894）：n.p="",n(n.s=140)}([
 * 捕获组 1 = 入口模块 id（不硬编码，随版本变化也能命中）。
 */
const BOOTSTRAP_RE = /n\.p="",n\(n\.s=(\d+)\)\}\(\[/;

/** 注入开始标记（用于识别已打补丁的 asar，保证幂等） */
const MARK_BEGIN = '/* ===== aura-screensaver injection BEGIN ===== */';
const MARK_END = '/* ===== aura-screensaver injection END ===== */';

/** asar 内的主入口文件名 */
const MAIN_ENTRY = 'main.js';

/** 内嵌配置的全局键（loader 会读取） */
const INLINE_CONFIG_KEY = '__AURA_INLINE_CONFIG__';

/** 默认注入配置（对应 loader 的 DEFAULT_CONFIG） */
const DEFAULT_INJECTED_CONFIG = {
  screensaverEnabled: false,
  lockCascadeOnClose: false,
  override: null,
  logLevel: 'info',
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function log(msg) { process.stdout.write(String(msg) + '\n'); }
function warn(msg) { process.stderr.write('WARN  ' + msg + '\n'); }
function fail(msg) { process.stderr.write('ERROR ' + msg + '\n'); }

/** 人类可读字节数 */
function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** 零依赖参数解析 */
function parseArgs(argv) {
  const opts = { dryRun: false, target: null, config: null, out: null, restore: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--restore') opts.restore = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a.indexOf('--target=') === 0) opts.target = a.slice(9);
    else if (a.indexOf('--config=') === 0) opts.config = a.slice(9);
    else if (a.indexOf('--out=') === 0) opts.out = a.slice(6);
    else if (a.charAt(0) === '-') warn('未知参数: ' + a);
  }
  return opts;
}

function printHelp() {
  log([
    '用法: node tools/patch-asar.js [选项]',
    '',
    '选项:',
    '  --dry-run            只输出计划，不写任何文件',
    '  --target <path>      指定 app.asar 路径（默认自动探测希沃安装目录）',
    '  --out <path>         输出到指定路径（默认原地替换 --target；自测用可避免污染原文件）',
    '  --config <json>      指定注入的初始配置（JSON 文件路径）',
    '  --restore            从 <target>.bak 还原',
    '  --force              备份已存在时覆盖备份（默认保留旧备份）',
    '  -h, --help           显示本帮助',
    '',
    '默认行为: 备份 app.asar -> app.asar.bak（已存在则保留，不覆盖），然后写出新的 app.asar。',
    '产物可逆: 用 --restore，或手工把 app.asar.bak 改回 app.asar，即可完全还原。',
  ].join('\n'));
}

/* ------------------------------------------------------------------ *
 * 目标探测
 * ------------------------------------------------------------------ */

/**
 * 自动探测希沃管家安装目录下的 resources/app.asar。
 *
 * 候选来源：SEEWO_HOME 环境变量、ProgramFiles、(x86) ProgramFiles、
 * LocalAppData\Programs，以及注册表卸载项的 InstallLocation。
 */
function detectTarget() {
  const roots = [];

  if (process.env.SEEWO_HOME) roots.push({ dir: process.env.SEEWO_HOME, source: 'env SEEWO_HOME' });

  const pfs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const pf of pfs) {
    roots.push({ dir: path.join(pf, 'Seewo', 'SeewoServiceAssistant'), source: 'ProgramFiles' });
  }

  if (process.env.LOCALAPPDATA) {
    roots.push({ dir: path.join(process.env.LOCALAPPDATA, 'Programs', 'SeewoServiceAssistant'), source: 'LocalAppData' });
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        '/s', '/f', 'SeewoServiceAssistant',
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const m = /InstallLocation\s+REG_[A-Z_]+\s+(.+)/i.exec(out);
      if (m) roots.push({ dir: m[1].trim(), source: 'registry' });
    } catch (e) { /* 注册表查询失败属正常（无权限/不存在），静默跳过 */ }
  }

  for (const r of roots) {
    const asar = path.join(r.dir, 'resources', 'app.asar');
    try {
      if (fs.existsSync(asar)) return { path: asar, source: r.source };
    } catch (e) { /* 忽略不可读目录 */ }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * asar 库加载
 * ------------------------------------------------------------------ */

/**
 * 解析 @electron/asar 的**库**入口。
 *
 * ★ 实测坑：该包 CLI 入口是 bin/asar.mjs（ESM），直接 require 会失败；
 *   必须用库入口（lib/asar.js）。这里按 package.json 的 exports/main 解析，
 *   并回落到已知路径，最后用 createRequire 兜底。
 */
function loadAsarApi() {
  const searchRoots = [
    path.join(__dirname, '..', '.work', 'tools'),
    path.join(__dirname, '..'),
    __dirname,
  ].filter(function (d) { try { return fs.existsSync(d); } catch (e) { return false; } });

  const pkgDirs = [];
  for (const root of searchRoots) {
    let dir = root;
    for (let depth = 0; depth < 8; depth++) {
      const pkgDir = path.join(dir, 'node_modules', '@electron', 'asar');
      if (fs.existsSync(pkgDir)) pkgDirs.push(pkgDir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const candidates = [];
  for (const pkgDir of pkgDirs) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      let rel = null;
      if (pkgJson.exports) {
        const ex = pkgJson.exports['.'] || pkgJson.exports;
        if (typeof ex === 'string') rel = ex;
        else if (ex && typeof ex === 'object') {
          rel = ex.require || ex.import || null;
          if (!rel && ex.default) rel = typeof ex.default === 'string' ? ex.default : (ex.default.require || null);
        }
      }
      if (rel) candidates.push(path.join(pkgDir, rel));
      if (pkgJson.main) candidates.push(path.join(pkgDir, pkgJson.main));
    } catch (e) { /* 继续 */ }
    candidates.push(path.join(pkgDir, 'lib', 'asar.js'));
    candidates.push(path.join(pkgDir, 'lib', 'index.js'));
    candidates.push(pkgDir);
  }
  candidates.push('@electron/asar');

  for (const c of candidates) {
    try {
      const api = require(c);
      if (api && typeof api.extractAll === 'function' && typeof api.createPackageWithOptions === 'function') {
        return { api: api, from: c };
      }
    } catch (e) { /* 试下一个 */ }
  }

  // createRequire 兜底（跨 ESM/CJS 边界）
  for (const pkgDir of pkgDirs) {
    try {
      const { createRequire } = require('module');
      const req = createRequire(path.join(pkgDir, 'package.json'));
      const api = req(pkgDir);
      if (api && typeof api.extractAll === 'function') return { api: api, from: pkgDir };
    } catch (e) { /* 继续 */ }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 核心：构造注入后的 main.js
 * ------------------------------------------------------------------ */

/**
 * 校验 main.js 是否为可注入的 webpack bundle，并返回注入后的内容。
 *
 * @param {string} source 原始 main.js 文本
 * @param {string} loaderText 加载器文本（tools/payload/aura-screensaver-loader.js）
 * @param {object} config 注入的初始配置
 * @returns {{ok:boolean, reason?:string, patched?:string, report?:object}}
 */
function buildPatchedMain(source, loaderText, config) {
  const report = { steps: [], anchors: {}, checks: [] };

  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'main.js 为空或不可读' };
  }

  // 幂等：已注入则不再注入
  if (source.indexOf(MARK_BEGIN) !== -1) {
    return { ok: false, reason: 'main.js 已包含 aura-screensaver 注入标记（无需重复打补丁）' };
  }

  // --- 锚点 A：bootstrap 尾部 ---
  const bootMatch = BOOTSTRAP_RE.exec(source);
  if (!bootMatch) {
    return { ok: false, reason: '未找到 bootstrap 锚点 n.p="",n(n.s=<id>)}([（bundle 结构可能已变，安全放弃）' };
  }
  const entryId = bootMatch[1];
  report.anchors.bootstrap = {
    index: bootMatch.index,
    entryId: entryId,
    text: bootMatch[0],
  };
  report.steps.push('锚点A  bootstrap 尾部 @' + bootMatch.index + '，入口模块 id=' + entryId);

  // --- 锚点 B：文件末尾必须是 "]);" 收尾 ---
  if (!/\]\);\s*$/.test(source)) {
    report.anchors.tail = { tail: source.slice(-8), valid: false };
    return { ok: false, reason: 'main.js 末尾不是 "]);" 结构，追加代码可能破坏语法（安全放弃）' };
  }
  report.anchors.tail = { tail: source.slice(-3), valid: true };
  report.steps.push('锚点B  文件末尾 @' + source.length + '，以 "]);" 收尾（合法追加位）');

  // --- 附加检查：模块表 ---
  report.checks.push({
    name: 'webpack 模块表 (n.m=e)',
    pass: source.indexOf('n.m=e') !== -1,
  });
  report.checks.push({
    name: '模块缓存 (n.c=t)',
    pass: source.indexOf('n.c=t') !== -1,
  });

  // --- (1) bootstrap 处插入 global 赋值 ---
  //
  // ★ 关键：除了暴露 webpack require，还要让**入口调用**不因抛异常而中断整个模块求值。
  //   原因（实测发现）：main.js 是一条表达式语句，形式为
  //       !function(e){ ... n.p="", <入口调用> }([ ...modules... ]);
  //   若 <入口调用> 抛异常，整条语句求值失败 → 文件末尾追加的加载器**根本不会执行**，
  //   注入完全落空（而官方进程也会因此崩溃，本该由 Electron 报错）。
  //
  //   把入口调用包成 try/catch 有两个好处：
  //     1) 即使入口出错，文件末尾的加载器仍会执行 → 注入必然生效；
  //     2) 捕获到的错误原样重新抛出（用 setTimeout(...,0) 异步抛），
  //        从而**不改变**官方「入口异常即崩溃」的语义，只是延后到当前同步求值之后。
  //
  //   注意：这是对官方 bootstrap 的**最小改动**，仅包住入口调用一个表达式。
  const origEntryCall = 'n(n.s=' + entryId + ')';
  const guardedEntryCall =
    'global.' + REQ_KEY + '=n,' +
    '(function(){' +
      'try{return ' + origEntryCall + ';}' +
      'catch(__auraEntryErr){' +
        // 延后异步重抛，保持官方「入口异常导致进程终止」的行为不变
        'try{setTimeout(function(){throw __auraEntryErr;},0);}catch(e){}' +
        'global.__AURA_ENTRY_ERROR__=__auraEntryErr;' +
        'return undefined;' +
      '}' +
    '}())';
  const inset = 'n.p="",' + guardedEntryCall + '}([';
  let patched = source.slice(0, bootMatch.index) + inset + source.slice(bootMatch.index + bootMatch[0].length);
  report.steps.push('注入①  bootstrap 插入 global.' + REQ_KEY + '=n（暴露 webpack require）');
  report.steps.push('注入①b 入口调用包 try/catch（保证入口异常时加载器仍执行；错误异步重抛不改变官方语义）');

  // --- (2) 末尾追加：内嵌配置 + 加载器 ---
  const configLiteral = JSON.stringify(config, null, 2);
  let block = '';
  block += '\n' + MARK_BEGIN + '\n';
  block += '// 由 tools/patch-asar.js 自动生成 —— 请勿手工编辑（重跑补丁器即可更新）\n';
  block += '// 注入时间: ' + new Date().toISOString() + '\n';
  block += '// 能力: (a) 关闭屏保  (b) 自定义图集/停留时长/适配模式/图文  (c) 切断 close->startLock 级联\n';
  block += 'try {\n';
  block += '  globalThis.' + INLINE_CONFIG_KEY + ' = ' + configLiteral + ';\n';
  block += '} catch (e) { /* 内嵌配置写入失败不影响加载器（会回落到内置默认值） */ }\n';
  block += '\n';
  block += loaderText;
  block += '\n';
  // 兜底：若首轮未装上（例如官方入口尚未把某些模块实例化完），下一轮事件循环再试一次。
  // 加载器本身已幂等（globalThis.__AURA_SCREENSAVER__.installed 检查），重复调用安全。
  block += '/* 兜底重试：上面 IIFE 若因任何原因没装上，这里在 next tick 再试一次（幂等） */\n';
  block += 'try {\n';
  block += '  var __auraRetry = function () {\n';
  block += '    try {\n';
  block += '      if (!(globalThis.__AURA_SCREENSAVER__ && globalThis.__AURA_SCREENSAVER__.installed)) {\n';
  block += '        if (typeof globalThis.__AURA_BOOT__ === "function") { globalThis.__AURA_BOOT__(true); }\n';
  block += '      }\n';
  block += '    } catch (e) { /* 重试失败也绝不能影响官方进程 */ }\n';
  block += '  };\n';
  block += '  if (typeof setImmediate === "function") setImmediate(__auraRetry); else setTimeout(__auraRetry, 0);\n';
  block += '} catch (e) { /* ignore */ }\n';
  block += MARK_END + '\n';

  patched += block;
  report.steps.push('注入②  末尾追加加载器 ' + bytes(loaderText.length) + '（含内嵌配置 + 兜底重试）');

  report.inputSize = source.length;
  report.outputSize = patched.length;
  report.deltaSize = patched.length - source.length;

  return { ok: true, patched: patched, report: report };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) { printHelp(); return 0; }

  log('========================================');
  log(' aura-screensaver / app.asar 补丁器');
  log('========================================');
  log('模式: ' + (opts.dryRun ? 'DRY-RUN（只输出计划，不写任何文件）' : '实际写入'));
  log('');

  // ---- 读取加载器 ----
  const loaderPath = path.join(__dirname, 'payload', 'aura-screensaver-loader.js');
  let loaderText;
  try {
    loaderText = fs.readFileSync(loaderPath, 'utf8');
  } catch (e) {
    fail('无法读取加载器: ' + loaderPath + ' (' + e.message + ')');
    return 3;
  }
  log('加载器: ' + path.relative(process.cwd(), loaderPath) + ' (' + bytes(loaderText.length) + ')');

  // ---- 注入配置 ----
  let injectedConfig = JSON.parse(JSON.stringify(DEFAULT_INJECTED_CONFIG));
  if (opts.config) {
    const cfgPath = path.resolve(opts.config);
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层必须是 JSON 对象');
      injectedConfig = Object.assign(injectedConfig, raw);
      log('注入配置: ' + cfgPath);
    } catch (e) {
      fail('无法读取 --config 指定的配置: ' + e.message);
      return 3;
    }
  } else {
    log('注入配置: （默认）' + JSON.stringify(injectedConfig));
  }
  log('');

  // ---- 确定目标 ----
  let target = opts.target;
  let targetSource = '命令行 --target';
  if (!target) {
    const detected = detectTarget();
    if (detected) { target = detected.path; targetSource = '自动探测（' + detected.source + '）'; }
  }
  if (!target) {
    fail('无法定位 app.asar。请用 --target <path> 显式指定。');
    log('');
    log('常见路径:');
    log('  C:\\Program Files\\Seewo\\SeewoServiceAssistant\\resources\\app.asar');
    log('  C:\\Program Files (x86)\\Seewo\\SeewoServiceAssistant\\resources\\app.asar');
    return 2;
  }
  target = path.resolve(target);
  const outPath = opts.out ? path.resolve(opts.out) : target;

  log('目标 asar: ' + target);
  log('  来源: ' + targetSource);

  // ---- 还原模式 ----
  if (opts.restore) {
    const bakPath = target + '.bak';
    log('备份文件: ' + bakPath);
    if (!fs.existsSync(bakPath)) { fail('备份不存在: ' + bakPath); return 2; }
    if (opts.dryRun) { log('[DRY-RUN] 将把备份复制回目标（未执行）'); return 0; }
    try {
      fs.copyFileSync(bakPath, target);
      log('已还原: ' + target);
      return 0;
    } catch (e) { fail('还原失败: ' + e.message); return 1; }
  }

  if (!fs.existsSync(target)) { fail('文件不存在: ' + target); return 2; }
  const stat = fs.statSync(target);
  log('  大小: ' + bytes(stat.size));
  log('');

  // ---- 加载 asar 库 ----
  const asar = loadAsarApi();
  if (!asar) {
    fail('未找到 @electron/asar 库。');
    log('请在本仓库内执行:');
    log('  npm --cache /tmp/npmcache install --prefix .work/tools @electron/asar');
    return 3;
  }
  log('asar 库: ' + asar.from);
  log('');

  // ---- 解包到临时目录 ----
  const workDir = path.join(require('os').tmpdir(), 'aura-patch-' + process.pid + '-' + Date.now());
  let stage = '准备';
  try {
    stage = '解包';
    log('[1/5] 解包 asar -> ' + workDir);
    fs.mkdirSync(workDir, { recursive: true });
    asar.api.extractAll(target, workDir);

    const mainPath = path.join(workDir, MAIN_ENTRY);
    if (!fs.existsSync(mainPath)) {
      fail('解包产物中找不到 ' + MAIN_ENTRY + '（asar 结构异常）');
      return 4;
    }
    const original = fs.readFileSync(mainPath, 'utf8');
    log('       main.js: ' + bytes(original.length));

    stage = '分析锚点';
    log('[2/5] 分析注入锚点');
    const built = buildPatchedMain(original, loaderText, injectedConfig);
    if (!built.ok) {
      fail('注入前检查未通过: ' + built.reason);
      log('（这是安全降级：**没有**修改任何文件）');
      return 5;
    }
    for (const s of built.report.steps) log('       ' + s);
    for (const c of built.report.checks) log('       ' + (c.pass ? '✓' : '·') + ' ' + c.name);
    log('       main.js: ' + bytes(built.report.inputSize) + ' -> ' + bytes(built.report.outputSize)
      + ' (+' + bytes(built.report.deltaSize) + ')');

    stage = '写入暂存';
    log('[3/5] 写入暂存文件');
    fs.writeFileSync(mainPath, built.patched, 'utf8');

    stage = '打包';
    log('[4/5] 重新打包 -> ' + outPath);
    // ★ 实测坑：@electron/asar 的 createPackage/createPackageWithOptions 是
    //   **异步**函数（返回 Promise），必须 await；否则会「静默什么都不做」，
    //   随后 statSync 报 ENOENT。（extractAll/extractFile 则是同步的。）
    // 保持与官方一致的打包参数：不 unpack（官方 app.asar 未使用 unpacked 目录）
    const tmpOut = outPath + '.tmp-' + process.pid;
    const packResult = asar.api.createPackageWithOptions(workDir, tmpOut, { dot: true });
    if (packResult && typeof packResult.then === 'function') await packResult;
    if (!fs.existsSync(tmpOut)) {
      fail('打包未产生输出文件: ' + tmpOut + '（asar 库 API 行为异常）');
      return 6;
    }
    const outSize = fs.statSync(tmpOut).size;

    if (opts.dryRun) {
      log('[5/5] DRY-RUN：不写任何文件');
      log('');
      log('计划摘要');
      log('  原地替换: ' + target);
      log('  输出路径: ' + outPath + (opts.out ? '（--out 指定）' : '（默认原地替换）'));
      log('  备份:     ' + (opts.out
        ? '（--out 模式：不备份，目标文件不会被修改）'
        : (fs.existsSync(target + '.bak')
          ? target + '.bak （已存在，将保留不覆盖）'
          : target + '.bak （将新建）')));
      log('  新 asar:  ' + bytes(outSize));
      log('  校验:     Verify.json 不校验 app.asar，重打包可行；**不要改 .exe**');
      try { fs.unlinkSync(tmpOut); } catch (e) { /* 清理暂存 */ }
      log('');
      log('DRY-RUN 完成：未修改任何文件。');
      return 0;
    }

    // ---- 备份 ----
    // ★ 只有在「原地替换」时才备份。若用 --out 写到别处，目标文件根本没被动过，
    //   此时再生成 .bak 只是往用户目录里丢垃圾（也会污染只读参考目录）。
    stage = '备份';
    log('[5/5] 备份与写出');
    const bakPath = target + '.bak';
    const inPlace = path.resolve(outPath) === path.resolve(target);
    if (!inPlace) {
      log('       输出到 --out 指定路径，目标文件未被修改，跳过备份');
    } else if (fs.existsSync(bakPath)) {
      if (opts.force) {
        fs.copyFileSync(target, bakPath);
        log('       备份已覆盖: ' + bakPath + ' (--force)');
      } else {
        log('       备份已存在，保留不覆盖: ' + bakPath);
      }
    } else {
      fs.copyFileSync(target, bakPath);
      log('       已备份: ' + bakPath + ' (' + bytes(stat.size) + ')');
    }

    // 原子替换：先写临时文件再 rename（同目录内 rename 在 Windows 上也可覆盖已存在文件）
    fs.renameSync(tmpOut, outPath);
    log('       已写出: ' + outPath + ' (' + bytes(outSize) + ')');
    log('');
    log('补丁完成。');
    log('  还原方式: node tools/patch-asar.js --target "' + target + '" --restore');
    return 0;
  } catch (e) {
    fail('在「' + stage + '」阶段失败: ' + (e && e.stack || e));
    return 1;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不报错 */ }
  }
}

if (require.main === module) {
  main().then(function (code) {
    process.exit(typeof code === 'number' ? code : 0);
  }).catch(function (e) {
    fail('未捕获异常: ' + (e && e.stack || e));
    process.exit(1);
  });
}

module.exports = {
  parseArgs: parseArgs,
  detectTarget: detectTarget,
  loadAsarApi: loadAsarApi,
  buildPatchedMain: buildPatchedMain,
  BOOTSTRAP_RE: BOOTSTRAP_RE,
  MARK_BEGIN: MARK_BEGIN,
  MARK_END: MARK_END,
  REQ_KEY: REQ_KEY,
  INLINE_CONFIG_KEY: INLINE_CONFIG_KEY,
  DEFAULT_INJECTED_CONFIG: DEFAULT_INJECTED_CONFIG,
};
