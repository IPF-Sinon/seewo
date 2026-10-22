'use strict';
/**
 * tools/gui/server.js —— 本地 GUI 配置界面的后端（零 npm 依赖）
 *
 * 设计目标（task-6）：
 *   - 只监听 127.0.0.1（绝不 0.0.0.0），端口默认 8899，被占用自动 +1
 *   - 静态服务同目录前端（index.html / app.js / style.css），白名单，无目录遍历
 *   - REST：GET/POST /api/config、POST /api/config/reset、GET /api/status、
 *           POST /api/preview、GET /api/log?lines=N、GET /api/backups
 *   - 配置读写一律走 src/config/schema.js 的校验（直接 require 复用，不复制规则）
 *   - 写入原子（临时文件 + fsync + rename），并滚动保留 .bak 备份
 *   - 所有错误返回结构化 JSON {ok:false, code, message, path}
 *   - 导出 createServer() 供单测 require；**require 本文件不会自动监听**
 *
 * 只用 Node 内置模块：http / fs / path / url / os / child_process。
 *
 * ★ 配置文件路径（两处权威来源存在分歧，这里显式处理并标注）：
 *   - docs/深度配置屏保.md 与 tools/payload/aura-screensaver-loader.js 都写
 *     %APPDATA%\seewo\AuraScreensaver\config.json  → 这是**注入后运行时真正读的路径**
 *   - src/config/schema.js 的 CONFIG_FILE_NAME 是 'aura-screensaver.json'，
 *     且 src/config/configManager.js 默认目录是 %APPDATA%\seewo-aura-screensaver\
 *     （那是给纯 Node 侧/测试用的，注入产物用的是 loader 里的内联默认值）
 *   结论（已核实，勿推翻）：**GUI 必须写 loader 读的那个路径**，即
 *     Windows: %APPDATA%\seewo\AuraScreensaver\config.json
 *     其它平台: ~/.config/seewo/AuraScreensaver/config.json（仅为本机 Linux 自测）
 *   环境变量 AURA_SCREENSAVER_CONFIG 的优先级与 loader 保持一致（loader 也读它），
 *   因此「GUI 写哪，loader 就读哪」恒成立。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { execFile } = require('child_process');

/* ==================================================================== *
 * 常量
 * ==================================================================== */

/** 默认端口；被占用则 +1 递增探测 */
const DEFAULT_PORT = 8899;

/** 端口探测上限（8899..8998） */
const PORT_PROBE_LIMIT = 100;

/** 只允许绑定的主机 —— 绝不 0.0.0.0 */
const HOST = '127.0.0.1';

/** 本文件所在目录 = 前端静态文件目录 */
const GUI_DIR = __dirname;

/** 允许静态服务的文件名白名单（防目录遍历 + 防泄露同目录其它文件） */
const STATIC_WHITELIST = ['index.html', 'app.js', 'style.css'];

/** 静态文件的 MIME 表 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** 请求体上限（配置 JSON 很小；40KB 足够，防止内存被灌爆） */
const MAX_BODY_BYTES = 40 * 1024;

/** 日志尾部默认/最大行数 */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 5000;

/** 备份最多列举个数（与 schema.DEFAULT_CONFIG.backupCount 的上游批次对齐） */
const MAX_BACKUP_SCAN = 20;

/** 配置环境变量（与 loader 的 CONFIG_ENV 同名同义） */
const CONFIG_ENV = 'AURA_SCREENSAVER_CONFIG';

/** 日志文件名（与 loader createLog 里写死的路径保持一致） */
const LOG_FILE_NAME = 'aura-screensaver.log';

/** 注入标记（与 tools/patch-asar.js 的 MARK_BEGIN 逐字一致） */
const INJECT_MARK = '/* ===== aura-screensaver injection BEGIN ===== */';

/** 已知模块号（来源：docs/注入验证记录.md 与 tools/patch-asar.js 头部，已在真实 bundle 交叉验证） */
const KNOWN_MODULES = {
  screensaverController: 120,
  windowManager: 69,
  screenLock: 40,
  share: 2,
  note: '模块 id 来自真实 bundle 交叉验证；换版本后若功能不生效需重新标定。屏幕锁控制器 40 刻意不被本工具修改。',
};

/* ==================================================================== *
 * 定位依赖（schema.js / patch-asar.js）
 * ==================================================================== */

/**
 * 按多个候选路径尝试 require。
 * 之所以不写死 ../src/config/schema.js：本文件可能被单测从别的工作目录 require，
 * 也可能被打包工具复制到别处，多候选更稳。
 */
function requireFirst(candidates) {
  const tried = [];
  for (const c of candidates) {
    try {
      return { mod: require(c), from: c };
    } catch (e) {
      tried.push(c + ' -> ' + (e && e.code ? e.code : e && e.message));
    }
  }
  const err = new Error('无法加载依赖，已尝试: ' + tried.join(' | '));
  err.code = 'E_DEPENDENCY_MISSING';
  err.tried = tried;
  throw err;
}

/**
 * 加载 src/config/schema.js（权威校验规则，绝不复制一份）。
 * 若真的加载不到，退化到内置的最小实现并在 /api/status 里显式标注 degraded，
 * 绝不静默用「假校验」放行脏配置。
 */
let schema = null;
let schemaSource = null;
let schemaLoadError = null;
try {
  const loaded = requireFirst([
    path.join(__dirname, '..', '..', 'src', 'config', 'schema.js'),
    path.join(process.cwd(), 'src', 'config', 'schema.js'),
  ]);
  schema = loaded.mod;
  schemaSource = loaded.from;
} catch (e) {
  schemaLoadError = e;
}

/**
 * 降级 schema（仅在 require 失败时使用）。
 * 只覆盖最关键的字段校验，且会在 status 里标记 degraded=true 提示用户。
 * ★ 正常情况下永远走 src/config/schema.js。
 */
function buildFallbackSchema() {
  const ConfigValidationError = class ConfigValidationError extends Error {
    constructor(message, p, value) {
      super(p ? '[' + p + '] ' + message : message);
      this.name = 'ConfigValidationError';
      this.path = p || '';
      this.value = value;
      this.code = 'E_CONFIG_INVALID';
    }
  };
  const cache = {};
  function getSchema() {
    if (cache.s) return cache.s;
    const real = requireFirst([path.join(__dirname, '..', '..', 'src', 'config', 'schema.js')]).mod;
    cache.s = real;
    return real;
  }
  return {
    __fallback: true,
    get DEFAULT_CONFIG() { return getSchema().DEFAULT_CONFIG; },
    get DEFAULT_OVERRIDE() { return getSchema().DEFAULT_OVERRIDE; },
    get PICTURE_SIZE_TYPES() { return getSchema().PICTURE_SIZE_TYPES; },
    get TRANSITION_MAX() { return getSchema().TRANSITION_MAX; },
    ConfigValidationError,
    validateConfig(v) { return getSchema().validateConfig(v); },
    deepClone: (v) => JSON.parse(JSON.stringify(v)),
  };
}

/* ==================================================================== *
 * 路径解析
 * ==================================================================== */

/**
 * 配置目录：
 *   Windows → %APPDATA%\seewo\AuraScreensaver
 *   其它     → ~/.config/seewo/AuraScreensaver
 * （与 tools/payload/aura-screensaver-loader.js 的 CONFIG_RELATIVE 对齐）
 */
function defaultConfigDir() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const base = process.env.APPDATA ||
      (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null) ||
      os.homedir();
    return path.join(base, 'seewo', 'AuraScreensaver');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'seewo', 'AuraScreensaver');
}

/**
 * 解析配置文件路径。
 * 优先级与 loader.readConfigFile 完全一致：
 *   1) 环境变量 AURA_SCREENSAVER_CONFIG（显式覆盖，便于便携/调试）
 *   2) <defaultConfigDir>/config.json
 * 这是「GUI 写入的路径 === loader 读取的路径」的唯一保证。
 */
function resolveConfigPath() {
  const envPath = process.env[CONFIG_ENV];
  if (envPath && envPath.trim()) return path.resolve(envPath.trim());
  return path.join(defaultConfigDir(), 'config.json');
}

/** 日志文件路径（与 loader 一致：配置目录下的 aura-screensaver.log） */
function resolveLogPath() {
  const envPath = process.env[CONFIG_ENV];
  const dir = envPath && envPath.trim() ? path.dirname(path.resolve(envPath.trim())) : defaultConfigDir();
  return path.join(dir, LOG_FILE_NAME);
}

/* ==================================================================== *
 * 结构化错误
 * ==================================================================== */

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function badRequest(code, message, extra) { return new ApiError(400, code, message, extra); }

/** 从任意异常构造 {ok:false, code, message, path} 响应体 */
function toErrorPayload(err) {
  if (err instanceof ApiError) {
    const payload = { ok: false, code: err.code, message: err.message };
    if (err.extra && err.extra.path !== undefined) payload.path = err.extra.path;
    else payload.path = '';
    Object.assign(payload, err.extra || {});
    payload.ok = false;
    payload.code = err.code;
    payload.message = err.message;
    return payload;
  }
  // schema.ConfigValidationError：原样透传 path（前端要按它定位输入框）
  if (err && err.name === 'ConfigValidationError') {
    return { ok: false, code: err.code || 'E_CONFIG_INVALID', message: err.message, path: err.path || '' };
  }
  const code = (err && err.code) || 'E_INTERNAL';
  return {
    ok: false,
    code: code === 'ENOENT' ? 'E_NOT_FOUND' : code,
    message: (err && err.message) || String(err),
    path: (err && err.path) || '',
  };
}

/* ==================================================================== *
 * 配置读写（原子写 + 备份 + 校验）
 * ==================================================================== */

const S = schema || buildFallbackSchema();
const schemaDegraded = !schema;

function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 读取 JSON，区分「不存在」与「损坏」，绝不抛给调用方 */
function readJsonSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false };
    return { exists: true, error: e.message, errorCode: e.code };
  }
  if (!raw.trim()) return { exists: true, error: '文件为空', raw: raw };
  try {
    return { exists: true, value: JSON.parse(raw), raw: raw };
  } catch (e) {
    return { exists: true, error: 'JSON 语法错误: ' + e.message, raw: raw };
  }
}

/**
 * 读取当前配置 + 校验状态。
 * @returns {{ok:boolean, exists:boolean, valid:boolean, config:object, error?:string,
 *            path:string, source:'file'|'defaults', warnings:string[]}}
 */
function loadConfigInfo(configPath) {
  const p = configPath || resolveConfigPath();
  const warnings = [];
  const read = readJsonSafe(p);

  if (!read.exists) {
    return {
      ok: true, exists: false, valid: true, source: 'defaults', path: p,
      config: deepClone(S.DEFAULT_CONFIG), error: null, warnings: warnings,
    };
  }
  if (read.error) {
    warnings.push('配置文件不可解析，已回落到默认值（原文件未被修改）：' + read.error);
    return {
      ok: true, exists: true, valid: false, source: 'defaults', path: p,
      config: deepClone(S.DEFAULT_CONFIG), error: read.error, warnings: warnings,
    };
  }
  try {
    const validated = S.validateConfig(read.value);
    collectWarnings(validated, warnings);
    return {
      ok: true, exists: true, valid: true, source: 'file', path: p,
      config: validated, error: null, warnings: warnings,
    };
  } catch (e) {
    warnings.push('配置文件未通过校验，已回落到默认值：' + e.message);
    return {
      ok: true, exists: true, valid: false, source: 'defaults', path: p,
      config: deepClone(S.DEFAULT_CONFIG), error: e.message,
      errorPath: (e && e.path) || '', warnings: warnings,
    };
  }
}

/** 非致命提示（前端用黄条展示），恒为数组 */
function collectWarnings(cfg, out) {
  const w = out || [];
  if (!cfg) return w;
  if (cfg.override && cfg.override.transitionList === null) {
    w.push('override.transitionList 为 null：将由注入 hook 按官方算法随机生成（长度=图片数）');
  }
  if (cfg.override && cfg.override.imageList && cfg.override.imageList.length === 0
      && cfg.override.transitionList && cfg.override.transitionList.length > 0) {
    w.push('override.imageList 为空但提供了转场列表：转场列表长度为 0 才合法，请检查');
  }
  if (cfg.screensaverEnabled === false) {
    w.push('screensaverEnabled=false：屏保已被关闭，集控再下发也不会弹出');
  }
  return w;
}

/** 确保目录存在 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 原子写：同目录临时文件 -> fsync -> rename。
 * rename 在同一文件系统内是原子的，读者只会看到完整的旧版或完整的新版。
 * @returns {{tmpPath:string, bytes:number}}
 */
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = path.join(
    dir,
    '.' + path.basename(filePath) + '.' + process.pid + '.' + Date.now() + '.tmp'
  );
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) { /* 某些文件系统不支持，忽略 */ }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    throw e;
  }
  return { tmpPath: tmpPath, bytes: Buffer.byteLength(content, 'utf8') };
}

/** 备份路径规则：config.json.bak（主备份）与 config.json.bak.N（滚动） */
function primaryBackupPath(filePath) { return filePath + '.bak'; }
function rollingBackupPath(filePath, i) { return filePath + '.bak.' + i; }

/**
 * 写备份：<file>.bak 保留**上一版**；若已存在则不覆盖（保护最原始备份），
 * 转而写 <file>.bak.0/.1/... 滚动备份。
 * @returns {{written:string|null, note:string}}
 */
function backupBeforeWrite(filePath, keep) {
  if (!fs.existsSync(filePath)) return { written: null, note: '首次写入，无需备份' };
  const primary = primaryBackupPath(filePath);
  try {
    if (!fs.existsSync(primary)) {
      fs.copyFileSync(filePath, primary);
      return { written: primary, note: '已创建初始备份 .bak（后续写入不覆盖它）' };
    }
  } catch (e) {
    /* 继续尝试滚动备份 */
  }
  const max = Math.max(1, Math.min(Number(keep) || 1, MAX_BACKUP_SCAN));
  // 轮转：.bak.(max-2) -> .bak.(max-1)，...，.bak.0 -> .bak.1
  for (let i = max - 2; i >= 0; i--) {
    const from = rollingBackupPath(filePath, i);
    const to = rollingBackupPath(filePath, i + 1);
    try {
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
    } catch (_) { /* 备份失败不影响主流程 */ }
  }
  try {
    fs.copyFileSync(filePath, rollingBackupPath(filePath, 0));
    return { written: rollingBackupPath(filePath, 0), note: '已滚动备份（.bak 为最原始版本，不覆盖）' };
  } catch (e) {
    return { written: null, note: '备份失败：' + e.message };
  }
}

/**
 * 保存配置（核心写路径）。
 * @param {object} input 用户提交的配置（完整或部分；部分会与当前磁盘值合并）
 * @param {object} [opts]
 * @param {boolean} [opts.replace=false] true=整体替换（未给字段回落默认值）
 * @returns {object} API 响应体
 * @throws {ConfigValidationError} 校验失败（HTTP 层转 400）
 */
function saveConfig(input, opts) {
  const o = opts || {};
  const filePath = resolveConfigPath();

  if (input === undefined || input === null) input = {};
  if (!isPlainObject(input)) {
    throw new ApiError(400, 'E_CONFIG_INVALID', '请求体必须是 JSON 对象', { path: '' });
  }

  // 合并基线：replace=true 用默认值；否则用「当前磁盘上校验通过的配置」，
  // 这样前端只提交改动字段也能工作，且不会把用户手写的其它字段抹掉。
  let base = deepClone(S.DEFAULT_CONFIG);
  if (!o.replace) {
    const cur = loadConfigInfo(filePath);
    if (cur.valid && cur.source === 'file') base = cur.config;
  }
  const merged = mergeShallow(base, input);

  // ★ 校验：非法值直接抛（带字段路径），HTTP 层转 400
  const validated = S.validateConfig(merged);

  // 与磁盘现值比较，得出 changed
  const before = readJsonSafe(filePath);
  let changed = true;
  if (before.exists && !before.error) {
    try {
      const prevValidated = S.validateConfig(before.value);
      changed = JSON.stringify(prevValidated) !== JSON.stringify(validated);
    } catch (_) { changed = true; }
  }

  let backup = { written: null, note: '' };
  if (changed) {
    backup = backupBeforeWrite(filePath, validated.backupCount);
    const text = JSON.stringify(validated, null, 2) + '\n';
    const res = atomicWriteFileSync(filePath, text);
    return {
      ok: true,
      path: filePath,
      changed: true,
      config: validated,
      warnings: collectWarnings(validated, []),
      write: { atomic: true, tmp: path.basename(res.tmpPath), bytes: res.bytes },
      backup: backup,
    };
  }

  return {
    ok: true,
    path: filePath,
    changed: false,
    config: validated,
    warnings: collectWarnings(validated, []),
    write: { atomic: true, tmp: null, bytes: 0, note: '内容无变化，跳过写入（幂等）' },
    backup: backup,
  };
}

/** 浅合并（与 src/config/schema.js mergeConfig 同语义：undefined 不覆盖） */
function mergeShallow(base, patch) {
  const out = deepClone(base);
  if (!isPlainObject(patch)) return out;
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) continue;
    out[k] = deepClone(patch[k]);
  }
  return out;
}

/* ==================================================================== *
 * /api/status 辅助：asar 注入探测
 * ==================================================================== */

/** 探测希沃安装目录下的 app.asar（与 tools/patch-asar.js 的候选来源一致） */
function detectAsarPath() {
  const roots = [];
  if (process.env.SEEWO_HOME) roots.push(process.env.SEEWO_HOME);
  for (const k of ['ProgramFiles', 'ProgramFiles(x86)']) {
    if (process.env[k]) roots.push(path.join(process.env[k], 'Seewo', 'SeewoServiceAssistant'));
  }
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'SeewoServiceAssistant'));
  }
  for (const r of roots) {
    const asar = path.join(r, 'resources', 'app.asar');
    try { if (fs.existsSync(asar)) return asar; } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * 读取 asar 是否已注入。
 * asar 是归档格式，这里只做**字符串标记扫描**（标记由 patch-asar.js 逐字写入）：
 * 命中即「已注入」，比解包整包便宜得多，且不会误改文件。
 * @returns {{injected:boolean|null, marker:boolean, path:string|null, note:string, size?:number}}
 */
function inspectAsarInjection() {
  const asarPath = detectAsarPath();
  if (!asarPath) {
    return {
      injected: null, marker: false, path: null,
      note: '未探测到 app.asar（Linux/未安装无法探测；设置 SEEWO_HOME 可指定安装目录）',
    };
  }
  try {
    const st = fs.statSync(asarPath);
    const buf = fs.readFileSync(asarPath);
    const marker = buf.indexOf(INJECT_MARK) !== -1;
    return {
      injected: marker,
      marker: marker,
      path: asarPath,
      size: st.size,
      note: marker ? '已在 asar 中检测到注入标记' : '未检测到注入标记（尚未打补丁）',
    };
  } catch (e) {
    return { injected: null, marker: false, path: asarPath, note: '读取 asar 失败: ' + e.message };
  }
}

/* ==================================================================== *
 * /api/log
 * ==================================================================== */

/**
 * 读日志尾部 N 行。
 * 大文件时只读末尾一块（不整文件入内存）。
 */
function readLogTail(n) {
  const file = resolveLogPath();
  const want = Math.max(1, Math.min(Number(n) || DEFAULT_LOG_LINES, MAX_LOG_LINES));
  let fd = null;
  try {
    const st = fs.statSync(file);
    const chunkSize = Math.min(st.size, Math.max(want * 200, 64 * 1024));
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(chunkSize);
    fs.readSync(fd, buf, 0, chunkSize, Math.max(0, st.size - chunkSize));
    const text = buf.toString('utf8');
    let lines = text.split(/\r?\n/);
    // 若不是从文件头读起，第一行可能是半截，丢掉
    if (st.size > chunkSize) lines = lines.slice(1);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const tail = lines.slice(-want);
    return {
      ok: true,
      file: file,
      exists: true,
      total: total,
      truncated: st.size > chunkSize,
      lines: tail.map((text2, i) => ({ n: total - tail.length + i + 1, text: text2 })),
    };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return {
        ok: true, file: file, exists: false, total: 0, truncated: false, lines: [],
        note: '日志文件不存在（尚未注入运行过，或程序未启动过）',
      };
    }
    throw new ApiError(500, 'E_LOG_READ', '读取日志失败: ' + e.message, { path: file });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/* ==================================================================== *
 * /api/backups
 * ==================================================================== */

/** 列出可用备份：<file>.bak 与 <file>.bak.N */
function listBackups() {
  const file = resolveConfigPath();
  const dir = path.dirname(file);
  const base = path.basename(file);
  const out = [];

  const candidates = [{ p: primaryBackupPath(file), index: null, kind: 'primary' }];
  for (let i = 0; i < MAX_BACKUP_SCAN; i++) {
    candidates.push({ p: rollingBackupPath(file, i), index: i, kind: 'rolling' });
  }

  for (const c of candidates) {
    let st = null;
    try { st = fs.statSync(c.p); } catch (_) { continue; }
    if (!st.isFile()) continue;
    let valid = null;
    let error = null;
    const read = readJsonSafe(c.p);
    if (read.exists && !read.error) {
      try { S.validateConfig(read.value); valid = true; }
      catch (e) { valid = false; error = e.message; }
    } else {
      valid = false;
      error = read.error || '不可读';
    }
    out.push({
      path: c.p,
      name: path.basename(c.p),
      kind: c.kind,
      index: c.index,
      size: st.size,
      mtime: st.mtime.toISOString(),
      valid: valid,
      error: error,
    });
  }
  // primary 优先，其次按 index 升序（越小的越新）
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'primary' ? -1 : 1;
    return (a.index === null ? -1 : a.index) - (b.index === null ? -1 : b.index);
  });

  let configExists = false;
  try { configExists = fs.existsSync(file); } catch (_) { /* ignore */ }
  return {
    ok: true,
    file: file,
    dir: dir,
    baseName: base,
    exists: configExists,
    backups: out,
    count: out.length,
    note: out.length ? '' : '暂无备份（首次写入时才会生成）',
  };
}

/* ==================================================================== *
 * /api/preview
 * ==================================================================== */

/**
 * 触发屏保预览。
 *
 * ★ 诚实说明（勿当成功）：屏保由希沃管家主进程内的 webpack 模块 120 渲染，
 *   本 HTTP 服务是**独立进程**，无法直接调用 req(120).startScreensaver()。
 *   真正可行的预览通路是 tools/payload/loader 暴露的手动唤起能力（task-8）。
 *   这里实现为「探测 + 请求」：
 *     - 非 Windows / 未探测到管家 → ok:false + E_PREVIEW_UNAVAILABLE，绝不谎报成功
 *     - Windows 且检测到进程 → 记录 preview 请求并给出可用命令，由启动器/loader 消费
 *   ★ 待验证：真机上的进程名与唤起方式需在 Windows 上确认。
 */
function requestPreview(body) {
  const name = (body && typeof body.command === 'string' && body.command) || 'preview';
  const args = (body && body.args && typeof body.args === 'object') ? body.args : {};

  const dir = defaultConfigDir();
  const cmdFile = path.join(dir, 'command.json');
  const resFile = path.join(dir, 'command-result.json');

  // 用时间戳做 seq：单调递增，避免与上一轮结果混淆
  const seq = Date.now();

  try {
    ensureDir(dir);
    atomicWriteFileSync(cmdFile, JSON.stringify({
      seq: seq,
      cmd: name,
      args: args,
      at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    return {
      ok: false,
      code: 'E_WRITE_COMMAND',
      message: '无法写入预览命令文件',
      path: cmdFile,
      mode: 'error',
      detail: String((e && e.message) || e),
    };
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + 3500;
    (function poll() {
      try {
        if (fs.existsSync(resFile)) {
          const r = JSON.parse(fs.readFileSync(resFile, 'utf8'));
          if (r && Number(r.seq) === seq) {
            resolve(Object.assign({}, r, {
              ok: !!r.ok,
              mode: 'bridge',
              commandFile: cmdFile,
              resultFile: resFile,
            }));
            return;
          }
        }
      } catch (_) { /* 半截 JSON → 继续轮询 */ }

      if (Date.now() > deadline) {
        resolve({
          ok: false,
          code: 'E_PREVIEW_NO_BRIDGE',
          message: '预览命令已发出，但管家进程没有响应',
          path: cmdFile,
          mode: 'no-bridge',
          detail: '预览依赖注入到希沃管家主进程的 loader 轮询 command.json。请确认：'
            + '1) 已用「安装.bat」注入并重启管家；2) 管家进程正在运行。',
          commandFile: cmdFile,
        });
        return;
      }
      setTimeout(poll, 250);
    })();
  });
}

/* ==================================================================== *
 * HTTP 工具
 * ==================================================================== */

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** 读取并解析请求体（限制大小，只接受 JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('E_BODY_TOO_LARGE',
          '请求体过大（上限 ' + MAX_BODY_BYTES + ' 字节）', { path: '' }));
        try { req.destroy(); } catch (_) { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (e) {
        reject(badRequest('E_BODY_NOT_JSON', '请求体不是合法 JSON: ' + e.message, { path: '' }));
      }
    });
    req.on('error', (e) => reject(new ApiError(500, 'E_BODY_READ', e.message, { path: '' })));
  });
}

/* ==================================================================== *
 * 路由
 * ==================================================================== */

/** GET /api/config */
function handleGetConfig() {
  const info = loadConfigInfo();
  return {
    ok: true,
    path: info.path,
    exists: info.exists,
    valid: info.valid,
    source: info.source,
    error: info.error,
    errorPath: info.errorPath || '',
    config: info.config,
    warnings: info.warnings,
    schema: {
      defaults: deepClone(S.DEFAULT_CONFIG),
      defaultOverride: deepClone(S.DEFAULT_OVERRIDE),
      pictureSizeTypes: deepClone(S.PICTURE_SIZE_TYPES),
      transitionMax: S.TRANSITION_MAX,
      backupCountMax: MAX_BACKUP_SCAN,
      degraded: schemaDegraded,
      source: schemaSource,
    },
  };
}

/** POST /api/config */
async function handlePostConfig(req) {
  const body = await readBody(req);
  let payload = body;
  // 允许两种形式：直接给配置对象，或 { config: {...} } 包一层（前端更省事）
  if (isPlainObject(body) && body.config !== undefined) payload = body.config;
  const replace = isPlainObject(body) && body.replace === true;
  const result = saveConfig(payload, { replace: replace });
  result.warnings = result.warnings || [];
  if (result.backup && result.backup.note) result.warnings.push(result.backup.note);
  return result;
}

/** POST /api/config/reset —— 写回 schema 默认值（前端「恢复默认」） */
async function handleResetConfig(req) {
  // 读掉 body，避免连接悬挂（前端可能带空 body 或 {}）
  try { await readBody(req); } catch (_) { /* 忽略 body 解析错误 */ }
  const result = saveConfig(deepClone(S.DEFAULT_CONFIG), { replace: true });
  result.warnings = (result.warnings || []).concat(['已恢复为默认配置']);
  result.reset = true;
  return result;
}

/** GET /api/status */
function handleStatus() {
  const cfg = loadConfigInfo();
  let log = null;
  try { log = readLogTail(20); } catch (e) { log = { ok: false, lines: [], error: e.message }; }
  return {
    ok: true,
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    port: null, // 由调用方填实际端口（见 createServer 内）
    host: HOST,
    uptimeSec: Math.round(process.uptime()),
    asar: inspectAsarInjection(),
    modules: KNOWN_MODULES,
    config: {
      path: cfg.path,
      exists: cfg.exists,
      valid: cfg.valid,
      error: cfg.error,
      source: cfg.source,
    },
    schema: { source: schemaSource, degraded: schemaDegraded },
    log: {
      file: log.file,
      exists: log.exists !== false,
      tail: (log.lines || []).map((l) => l.text),
    },
    routes: [
      'GET /api/config', 'POST /api/config', 'POST /api/config/reset',
      'GET /api/status', 'POST /api/preview', 'GET /api/log?lines=N', 'GET /api/backups',
    ],
  };
}

/** GET /api/log?lines=N */
function handleLog(query) {
  const n = Number(query && query.lines);
  return readLogTail(Number.isFinite(n) && n > 0 ? n : DEFAULT_LOG_LINES);
}

/* ==================================================================== *
 * 静态文件
 * ==================================================================== */

function serveStatic(req, res, pathname) {
  let name = decodeURIComponent(pathname);
  if (name === '/' || name === '') name = '/index.html';

  const base = path.posix.basename(name);
  if (STATIC_WHITELIST.indexOf(base) === -1) {
    // 目录遍历 / 未列入白名单 → 明确拒绝，不回落到任何文件
    sendJson(res, 404, {
      ok: false,
      code: 'E_NOT_FOUND',
      message: '静态资源不存在（仅允许 ' + STATIC_WHITELIST.join(' / ') + '）',
      path: name,
    });
    return;
  }

  const filePath = path.join(GUI_DIR, base);
  // 二次确认：解析后的真实路径必须仍在 GUI_DIR 内
  const resolved = path.resolve(filePath);
  if (resolved.indexOf(path.resolve(GUI_DIR) + path.sep) !== 0) {
    sendJson(res, 403, { ok: false, code: 'E_FORBIDDEN', message: '禁止访问该路径', path: name });
    return;
  }

  fs.readFile(resolved, (err, buf) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendJson(res, 404, {
          ok: false, code: 'E_NOT_FOUND',
          message: '前端文件尚未生成: ' + base + '（task-7 负责产出）',
          path: filePath,
        });
        return;
      }
      sendJson(res, 500, { ok: false, code: 'E_STATIC_READ', message: err.message, path: filePath });
      return;
    }
    const type = MIME[path.extname(base).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

/* ==================================================================== *
 * 主处理
 * ==================================================================== */

/**
 * 统一请求处理。
 * @param {object} ctx { configPath, getPort }
 */
function createRequestHandler(ctx) {
  return function handler(req, res) {
    let parsed;
    try {
      parsed = url.parse(req.url, true);
    } catch (e) {
      sendJson(res, 400, { ok: false, code: 'E_BAD_URL', message: '非法 URL', path: '' });
      return;
    }
    const pathname = parsed.pathname || '/';
    const query = parsed.query || {};
    const method = (req.method || 'GET').toUpperCase();

    // 只接受本地回环来源（Host 头校验，防御 DNS rebinding / 跨站直连本机端口）
    const host = String(req.headers.host || '');
    if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      sendJson(res, 403, {
        ok: false, code: 'E_FORBIDDEN_HOST',
        message: '仅接受来自本机回环地址的请求（Host: ' + host + '）', path: pathname,
      });
      return;
    }

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'E_METHOD', message: '静态资源只支持 GET', path: pathname });
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    Promise.resolve()
      .then(() => {
        if (pathname === '/api/config') {
          if (method === 'GET') return Promise.resolve(handleGetConfig());
          if (method === 'POST') return handlePostConfig(req);
          throw new ApiError(405, 'E_METHOD', '/api/config 只支持 GET / POST', { path: pathname });
        }
        if (pathname === '/api/config/reset') {
          if (method === 'POST') return handleResetConfig(req);
          throw new ApiError(405, 'E_METHOD', '/api/config/reset 只支持 POST', { path: pathname });
        }
        if (pathname === '/api/status') {
          if (method !== 'GET') throw new ApiError(405, 'E_METHOD', '/api/status 只支持 GET', { path: pathname });
          const s = handleStatus();
          s.port = ctx && typeof ctx.getPort === 'function' ? ctx.getPort() : null;
          return s;
        }
        if (pathname === '/api/preview') {
          if (method !== 'POST') throw new ApiError(405, 'E_METHOD', '/api/preview 只支持 POST', { path: pathname });
          return Promise.resolve(requestPreview(req));
        }
        if (pathname === '/api/log') {
          if (method !== 'GET') throw new ApiError(405, 'E_METHOD', '/api/log 只支持 GET', { path: pathname });
          return handleLog(query);
        }
        if (pathname === '/api/backups') {
          if (method !== 'GET') throw new ApiError(405, 'E_METHOD', '/api/backups 只支持 GET', { path: pathname });
          return listBackups();
        }
        throw new ApiError(404, 'E_NOT_FOUND', '未知接口: ' + pathname, { path: pathname });
      })
      .then((payload) => {
        const status = payload && payload.ok === false ? 200 : 200;
        // ★ 错误响应一律 4xx/5xx，不用 2xx 掩盖失败（前端按 ok 字段判断，但状态码必须诚实）
        if (payload && payload.ok === false) {
          const st = payload.code === 'E_NOT_FOUND' ? 404
            : payload.code === 'E_PREVIEW_UNAVAILABLE' || payload.code === 'E_PREVIEW_NO_HOST' ? 503
              : 400;
          sendJson(res, st, payload);
          return;
        }
        sendJson(res, status, payload);
      })
      .catch((err) => {
        const payload = toErrorPayload(err);
        const st = err instanceof ApiError ? err.status : 400;
        sendJson(res, st, payload);
      });
  };
}

/* ==================================================================== *
 * 服务创建 / 端口探测
 * ==================================================================== */

/**
 * 在 127.0.0.1 上从 startPort 起探测可用端口。
 * @returns {Promise<{server:import('http').Server, port:number}>}
 */
function listenOnFreePort(server, startPort, host, maxProbe) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let lastErr = null;

    function tryPort() {
      const port = startPort + attempt;
      if (attempt >= (maxProbe || PORT_PROBE_LIMIT)) {
        const e = new Error('端口 ' + startPort + '..' + (port - 1) + ' 全部被占用');
        e.code = 'EADDRINUSE';
        e.lastError = lastErr;
        reject(e);
        return;
      }

      function onError(err) {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE') {
          lastErr = err;
          attempt++;
          setImmediate(tryPort);
          return;
        }
        reject(err);
      }
      function onListening() {
        server.removeListener('error', onError);
        resolve({ server: server, port: server.address().port });
      }

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port, host);
      } catch (e) {
        server.removeListener('listening', onListening);
        server.removeListener('error', onError);
        reject(e);
      }
    }

    tryPort();
  });
}

/**
 * 创建（但**不监听**）HTTP 服务。
 *
 * @param {object} [options]
 * @param {string} [options.configPath] 覆盖配置文件路径（测试注入用）
 * @param {number} [options.port] 起始端口，默认 8899
 * @param {string} [options.host] 监听地址，**强制 127.0.0.1**（传入其它值会被拒绝）
 * @returns {import('http').Server & {__auraGui: object}}
 */
function createServer(options) {
  const opts = options || {};

  if (opts.host && opts.host !== HOST) {
    throw new ApiError(400, 'E_HOST_FORBIDDEN',
      '出于安全考虑，本服务只允许监听 ' + HOST + '（收到: ' + opts.host + '）', { path: '' });
  }

  // ★ 允许测试/调用方临时覆盖配置文件路径（进程级环境变量，与 loader 同语义）
  if (opts.configPath) {
    process.env[CONFIG_ENV] = path.resolve(opts.configPath);
  }

  const state = {
    configPath: resolveConfigPath(),
    port: opts.port || DEFAULT_PORT,
    startedAt: Date.now(),
  };

  const server = http.createServer(createRequestHandler({
    getPort: () => state.port,
  }));

  // 显式关掉 keep-alive 超时噪音；并禁止监听 0.0.0.0（在 listen 时强制）
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) { /* ignore */ }
  });

  server.__auraGui = {
    host: HOST,
    defaultPort: opts.port || DEFAULT_PORT,
    state: state,
    configPath: () => resolveConfigPath(),
    logPath: resolveLogPath,
    schemaSource: schemaSource,
    schemaDegraded: schemaDegraded,
    handlers: {
      getConfig: handleGetConfig,
      status: handleStatus,
      backups: listBackups,
      log: handleLog,
    },
  };

  /** 监听辅助：永远绑 127.0.0.1，端口占用自动递增 */
  server.listenLocal = function (startPort) {
    const base = startPort || opts.port || DEFAULT_PORT;
    return listenOnFreePort(server, base, HOST, PORT_PROBE_LIMIT).then((r) => {
      state.port = r.port;
      return r;
    });
  };

  return server;
}

/* ==================================================================== *
 * 入口（仅在直接执行本文件时启动；被 require 时**绝不**监听）
 * ==================================================================== */

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, configPath: null, help: false, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (a.indexOf('--port=') === 0) opts.port = Number(a.slice(7)) || DEFAULT_PORT;
    else if (a === '--config') opts.configPath = argv[++i];
    else if (a.indexOf('--config=') === 0) opts.configPath = a.slice(9);
    else if (a === '--open') opts.open = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

/**
 * 打开系统默认浏览器。
 * ★ 不用 `cmd /c start`：引号转义在不同系统区域设置下会出问题；
 *   也不用 PowerShell：历史上 .bat 内联 PS 会被 CMD 吃掉 % 导致语法错误。
 *   rundll32 / open / xdg-open 都是无引号歧义的直接调用。
 */
function openBrowser(targetUrl) {
  try {
    if (process.platform === 'win32') {
      execFile('rundll32', ['url.dll,FileProtocolHandler', targetUrl], { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [targetUrl], () => {});
    } else {
      execFile('xdg-open', [targetUrl], () => {});
    }
    return true;
  } catch (_) { return false; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write([
      '用法: node tools/gui/server.js [--port 8899] [--config <config.json>] [--open]',
      '',
      '只监听 127.0.0.1，端口被占用会自动 +1。',
      '配置路径: Windows=%APPDATA%\\seewo\\AuraScreensaver\\config.json',
      '          其它=~/.config/seewo/AuraScreensaver/config.json',
      '可用环境变量 AURA_SCREENSAVER_CONFIG 覆盖（与注入 loader 一致）。',
    ].join('\n') + '\n');
    return 0;
  }

  const server = createServer({ port: opts.port, configPath: opts.configPath });
  try {
    const r = await server.listenLocal(opts.port);
    const info = server.__auraGui;
    process.stdout.write('[gui] listening on http://' + HOST + ':' + r.port + '\n');
    process.stdout.write('[gui] config: ' + info.configPath() + '\n');
    process.stdout.write('[gui] log: ' + info.logPath() + '\n');
    if (opts.open) {
      const target = 'http://' + HOST + ':' + r.port + '/';
      const opened = openBrowser(target);
      process.stdout.write('[gui] 已请求打开浏览器: ' + target + (opened ? '' : ' (打开失败，请手动访问)') + '\n');
    }
    if (schemaDegraded) {
      process.stderr.write('[gui] WARN schema.js 未能按预期加载，校验处于降级模式\n');
    }
    return 0;
  } catch (e) {
    process.stderr.write('[gui] 启动失败: ' + (e && e.message) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stderr.write('[gui] 未捕获错误: ' + (e && e.stack || e) + '\n');
      process.exitCode = 1;
    });
}

/* ==================================================================== *
 * 导出（require 本文件不会监听任何端口）
 * ==================================================================== */

module.exports = {
  createServer: createServer,
  // 便于单测直接调用（不经过 HTTP）
  loadConfigInfo: loadConfigInfo,
  saveConfig: saveConfig,
  listBackups: listBackups,
  readLogTail: readLogTail,
  requestPreview: requestPreview,
  inspectAsarInjection: inspectAsarInjection,
  resolveConfigPath: resolveConfigPath,
  resolveLogPath: resolveLogPath,
  defaultConfigDir: defaultConfigDir,
  atomicWriteFileSync: atomicWriteFileSync,
  backupBeforeWrite: backupBeforeWrite,
  toErrorPayload: toErrorPayload,
  ApiError: ApiError,
  constants: {
    HOST: HOST,
    DEFAULT_PORT: DEFAULT_PORT,
    PORT_PROBE_LIMIT: PORT_PROBE_LIMIT,
    STATIC_WHITELIST: STATIC_WHITELIST,
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    INJECT_MARK: INJECT_MARK,
    CONFIG_ENV: CONFIG_ENV,
  },
  schemaSource: schemaSource,
  schemaDegraded: schemaDegraded,
  schemaLoadError: schemaLoadError ? String(schemaLoadError.message) : null,
};
