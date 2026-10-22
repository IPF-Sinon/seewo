'use strict';
/**
 * src/config/schema.js —— 配置 schema、默认值与校验
 *
 * 依据（全部来自 .work/app/main.js 与 public/screensaver.js 的一手提取，非推测）：
 *
 * 1) 屏保图集数据结构（main.js @159653 屏保控制器 onMessage 中 `r.share("screensaverMessage", e.data)`；
 *    public/screensaver.js @5467 渲染器消费函数 e() 逐字段读取）：
 *        e.materialSource    -> 底部素材来源文案（渲染器默认 "希沃集控"）
 *        e.switchInterval    -> 切换间隔（秒）；渲染器做 1000 * (switchInterval || 15)
 *        e.pictureSizeType   -> ★数字索引（0|1）；渲染器 D = ["contain","cover"]，取 D[pictureSizeType || 0]
 *        e.imageList         -> 图片路径数组
 *        e.textList          -> 文字列表
 *    因此自定义图集只允许覆盖这 5 个字段，未知字段一律拒绝（避免下发渲染器不认识的脏数据）。
 *
 * 2) 转场列表（main.js @159504）：
 *        r.share("screensaverTransitionList", ((e, t = 7) => { let n = [];
 *            for (let s = 0; s < e; s++) n.push(Math.floor(Math.random() * t));
 *            return n; })(e.data.imageList.length))
 *    —— 官方实现长度为 imageList.length、每个值取 [0, 7) 即 0..6。
 *    为保持渲染器行为等价，本工具强制 transitionList.length === imageList.length 且 0 <= v <= 6。
 *
 * 3) 任务标识（main.js @40739，webpack module 38）：
 *        { SCREENLOCK, SCHOOLANNOUNCEMENT, LIVE, SCREENSAVER, POPUP_NOTIFICATION }
 */

/** 转场编号值域上界（含）。对应 main.js 里 Math.random() * 7 的 t 默认值 7。 */
const TRANSITION_MAX = 6;

/** 默认切换间隔（秒）。对应渲染器 e.switchInterval || 15 的兜底值。 */
const DEFAULT_SWITCH_INTERVAL = 15;

/**
 * 图片适配方式枚举。
 * 依据 screensaver.js @5313：`var D=["contain","cover"]`，
 * @5438 消费：`x(D[e.pictureSizeType || 0])`。
 * → 载荷里存放的是**数字索引 0|1**，不是字符串；越界会得到 undefined，组件行为未定义。
 */
const PICTURE_SIZE_TYPES = ['contain', 'cover'];

/** 允许的 pictureSizeType 数字索引（0=contain 留黑边完整显示，1=cover 裁剪铺满） */
const PICTURE_SIZE_TYPE_INDEXES = [0, 1];

/** 配置文件名（相对配置目录） */
const CONFIG_FILE_NAME = 'aura-screensaver.json';

/** 默认配置。所有字段都有明确默认值，保证「零配置可用」。 */
const DEFAULT_CONFIG = Object.freeze({
  /** 全局开关：true 时正常放行屏保，false 时吞掉 /displayScreenSaver */
  screensaverEnabled: true,
  /**
   * 是否允许屏保窗口关闭后级联进入屏幕锁。
   * 依据 main.js @76173 module 69 newWindow：
   *   r.on("close", () => { setTimeout(() => { this.closeWindow(); this.startLock(); }, 0) })
   * —— 这里是打扰使用的主要来源，默认关闭级联。
   */
  lockCascadeOnClose: false,
  /** 是否把渲染器点击产生的 closeScreenSaver 也当作正常关闭（默认是） */
  allowManualClose: true,
  /** 图集覆盖；null 表示不覆盖，沿用云端下发数据 */
  override: null,
  /** 日志级别 */
  logLevel: 'info',
  /** 滚动备份保留份数（configManager 损坏恢复用） */
  backupCount: 3,
});

/**
 * 覆盖块默认值（override 非空时用于补全缺省字段）。
 * 字段名严格对齐 RENDERER_CONTRACT.md 的 screensaverMessage 载荷，
 * 不自创命名，避免下发渲染器不认识的脏数据。
 */
const DEFAULT_OVERRIDE = Object.freeze({
  /** 底部署名“素材来自 XXX”；空串则不显示（渲染器：y(data.materialSource || "")） */
  materialSource: '希沃集控',
  /** 切换间隔，★单位=秒；渲染器内部 ×1000（f(1000 * (data.switchInterval || 15))） */
  switchInterval: DEFAULT_SWITCH_INTERVAL,
  /** ★数字索引：0=contain（留黑边完整显示），1=cover（裁剪铺满） */
  pictureSizeType: 0,
  /** 图片路径数组（本地绝对路径） */
  imageList: [],
  /** 图文条目数组，元素为 { content, provenance? } */
  textList: [],
  /** 转场列表；null 表示由 hook 按官方算法随机生成 */
  transitionList: null,
});

/** 校验错误：携带字段路径，便于 IPC 层直接回给调用方 */
class ConfigValidationError extends Error {
  constructor(message, path, value) {
    super(path ? '[' + path + '] ' + message + '（实际值: ' + safeStringify(value) + '）' : message);
    this.name = 'ConfigValidationError';
    this.path = path || '';
    this.value = value;
    this.code = 'E_CONFIG_INVALID';
  }
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 深拷贝（仅处理 JSON 可表达的纯数据；配置结构里不会有函数/Date）。
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
  return out;
}

/** 把任意值转成正整数，失败返回 fallback */
function toPositiveInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

/**
 * 校验 override.transitionList。
 * 硬要求：长度必须等于 imageList.length，值域必须落在 0..6。
 */
function validateTransitionList(list, imageCount, path) {
  if (list === null || list === undefined) return null; // null = 交由 hook 随机生成
  if (!Array.isArray(list)) {
    throw new ConfigValidationError('转场列表必须是数组或 null', path, list);
  }
  if (list.length !== imageCount) {
    throw new ConfigValidationError(
      '转场列表长度必须等于图片数量（' + imageCount + '），实际 ' + list.length,
      path, list.length
    );
  }
  list.forEach(function (v, i) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ConfigValidationError('转场编号必须是整数', path + '[' + i + ']', v);
    }
    if (v < 0 || v > TRANSITION_MAX) {
      throw new ConfigValidationError(
        '转场编号必须在 0..' + TRANSITION_MAX + ' 之间', path + '[' + i + ']', v
      );
    }
  });
  return list.slice();
}

/** 校验自定义图集覆盖块 */
function validateOverride(override, path) {
  if (override === null || override === undefined) return null;
  const p = path || 'override';
  if (!isPlainObject(override)) {
    throw new ConfigValidationError('override 必须是对象或 null', p, override);
  }
  const allowed = Object.keys(DEFAULT_OVERRIDE);
  for (const key of Object.keys(override)) {
    if (allowed.indexOf(key) === -1) {
      throw new ConfigValidationError(
        '不支持的字段（渲染器不认识该字段，拒绝下发）', p + '.' + key, override[key]
      );
    }
  }
  const result = deepClone(DEFAULT_OVERRIDE);
  for (const key of Object.keys(override)) result[key] = override[key];

  if (typeof result.materialSource !== 'string') {
    throw new ConfigValidationError('materialSource 必须是字符串', p + '.materialSource', result.materialSource);
  }
  // ★ switchInterval 必须是正整数（秒）。
  //   注意：这里刻意**不复用 toPositiveInt 的 Math.floor 行为** —— 那会把 1.5 静默截断成 1，
  //   属于静默数据损坏（用户写 1.5 秒却得到 1 秒且无任何提示）。
  //   配置是人工手写 JSON，报错比猜测更安全。
  const rawInterval = typeof result.switchInterval === 'number'
    ? result.switchInterval
    : Number(result.switchInterval);
  if (!Number.isInteger(rawInterval) || rawInterval <= 0) {
    throw new ConfigValidationError(
      'switchInterval 必须是正整数（秒，单位=秒；渲染器内部会 ×1000）',
      p + '.switchInterval', result.switchInterval
    );
  }
  result.switchInterval = rawInterval;

  // ★ pictureSizeType 是数字索引（0|1），对应渲染器 D = ["contain","cover"]。
  // 越界会让 D[x] === undefined，组件行为未定义，因此在这里硬拦截。
  const sizeType = typeof result.pictureSizeType === 'number'
    ? result.pictureSizeType
    : Number(result.pictureSizeType);
  if (!Number.isInteger(sizeType) || PICTURE_SIZE_TYPE_INDEXES.indexOf(sizeType) === -1) {
    throw new ConfigValidationError(
      'pictureSizeType 必须是数字索引 0 或 1（0=' + PICTURE_SIZE_TYPES[0] + '，1=' + PICTURE_SIZE_TYPES[1] + '）',
      p + '.pictureSizeType', result.pictureSizeType
    );
  }
  result.pictureSizeType = sizeType;
  if (!Array.isArray(result.imageList)) {
    throw new ConfigValidationError('imageList 必须是数组', p + '.imageList', result.imageList);
  }
  result.imageList.forEach(function (v, i) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new ConfigValidationError('imageList 元素必须是非空字符串（图片路径）', p + '.imageList[' + i + ']', v);
    }
  });
  if (!Array.isArray(result.textList)) {
    throw new ConfigValidationError('textList 必须是数组', p + '.textList', result.textList);
  }
  // ★ textList 条目结构依据 screensaver.js @7154 渲染代码：
  //   J[j].content                  -> .screensaver__word__1JUEmrs6
  //   J[j].provenance && '- '+provenance+' -' -> .screensaver__origin__3EEEaZxo
  // 因此只接受 { content: string, provenance?: string }，多余的键直接拒绝。
  result.textList = result.textList.map(function (v, i) {
    const tp = p + '.textList[' + i + ']';
    if (!isPlainObject(v)) {
      throw new ConfigValidationError('textList 元素必须是对象 { content, provenance? }', tp, v);
    }
    for (const key of Object.keys(v)) {
      if (key !== 'content' && key !== 'provenance') {
        throw new ConfigValidationError('textList 元素不支持的字段', tp + '.' + key, v[key]);
      }
    }
    if (typeof v.content !== 'string' || v.content.length === 0) {
      throw new ConfigValidationError('textList 元素的 content 必须是非空字符串', tp + '.content', v.content);
    }
    if (v.provenance !== undefined && typeof v.provenance !== 'string') {
      throw new ConfigValidationError('textList 元素的 provenance 必须是字符串', tp + '.provenance', v.provenance);
    }
    const out = { content: v.content };
    if (v.provenance !== undefined) out.provenance = v.provenance;
    return out;
  });
  result.transitionList = validateTransitionList(
    result.transitionList, result.imageList.length, p + '.transitionList'
  );
  return result;
}

/**
 * 校验完整配置对象。
 *
 * @param {object} input 待校验的配置（可以只给部分字段）
 * @param {object} [options]
 * @param {boolean} [options.partial=false] true 时允许缺字段（用于 patch），
 *        缺字段仍会先与默认值合并后再校验。
 * @returns {object} 校验通过的完整配置（新对象，不会修改入参）
 * @throws {ConfigValidationError} 任何非法值都会带上字段路径抛出
 */
function validateConfig(input, options) {
  const opts = options || {};
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('配置必须是对象', '', input);
  }
  const allowed = Object.keys(DEFAULT_CONFIG);
  for (const key of Object.keys(input)) {
    if (allowed.indexOf(key) === -1) {
      throw new ConfigValidationError('未知配置项', key, input[key]);
    }
  }
  const merged = mergeConfig(DEFAULT_CONFIG, input);

  if (typeof merged.screensaverEnabled !== 'boolean') {
    throw new ConfigValidationError('screensaverEnabled 必须是布尔值', 'screensaverEnabled', merged.screensaverEnabled);
  }
  if (typeof merged.lockCascadeOnClose !== 'boolean') {
    throw new ConfigValidationError('lockCascadeOnClose 必须是布尔值', 'lockCascadeOnClose', merged.lockCascadeOnClose);
  }
  if (typeof merged.allowManualClose !== 'boolean') {
    throw new ConfigValidationError('allowManualClose 必须是布尔值', 'allowManualClose', merged.allowManualClose);
  }
  if (['debug', 'info', 'warn', 'error', 'silent'].indexOf(merged.logLevel) === -1) {
    throw new ConfigValidationError(
      'logLevel 必须是 debug/info/warn/error/silent 之一', 'logLevel', merged.logLevel
    );
  }
  const backupCount = toPositiveInt(merged.backupCount);
  if (backupCount === null) {
    throw new ConfigValidationError('backupCount 必须是正整数', 'backupCount', merged.backupCount);
  }
  merged.backupCount = backupCount;
  merged.override = validateOverride(merged.override, 'override');

  if (opts.partial) {
    // partial 仅影响「是否要求调用方显式给出全部字段」，合并后必然完整，故此处无额外动作。
  }
  return merged;
}

/**
 * 浅层合并（仅第一层；override 整体替换而非深合并，避免旧图集残留）。
 * 与通用 deepMerge 区分：配置项的语义是「显式给出即整体生效」。
 */
function mergeConfig(base, patch) {
  const out = deepClone(base);
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue; // undefined 不覆盖，便于 patch 语义
    out[key] = deepClone(patch[key]);
  }
  return out;
}

/** 计算两个配置之间的差异（供 IPC 审计与回滚记录用） */
function diffConfig(before, after) {
  const changed = {};
  const keys = {};
  for (const k of Object.keys(before || {})) keys[k] = true;
  for (const k of Object.keys(after || {})) keys[k] = true;
  for (const k of Object.keys(keys)) {
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed[k] = { from: a, to: b };
  }
  return changed;
}

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  DEFAULT_OVERRIDE: DEFAULT_OVERRIDE,
  PICTURE_SIZE_TYPES: PICTURE_SIZE_TYPES,
  PICTURE_SIZE_TYPE_INDEXES: PICTURE_SIZE_TYPE_INDEXES,
  TRANSITION_MAX: TRANSITION_MAX,
  DEFAULT_SWITCH_INTERVAL: DEFAULT_SWITCH_INTERVAL,
  CONFIG_FILE_NAME: CONFIG_FILE_NAME,
  ConfigValidationError: ConfigValidationError,
  validateConfig: validateConfig,
  validateOverride: validateOverride,
  validateTransitionList: validateTransitionList,
  mergeConfig: mergeConfig,
  diffConfig: diffConfig,
  deepClone: deepClone,
  isPlainObject: isPlainObject,
};
