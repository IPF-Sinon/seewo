'use strict';
/**
 * src/logger.js —— 带级别与时间戳的日志器
 *
 * 设计约束（来自 task-2 硬要求）：
 *   - 纯 Node.js / CommonJS，不 require electron，保证单测可以直接 require。
 *   - 零外部依赖：自带级别过滤、时间戳、可注入的 sink（便于测试捕获输出）。
 *
 * 与目标软件的一致性说明：
 *   main.js 里各模块通过 `n(7)` 引入日志器（例如 module 69 用 s.warn / s.info、
 *   module 39 队列用 s.info('xxx指令入队')）。本文件的日志级别命名与之一致：
 *   debug < info < warn < error，且默认包含 info，方便对照 main.js 输出排查。
 */

/** 日志级别数值表（数字越大越严重） */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** 把任意值格式化成可读字符串 */
function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

/**
 * 创建一个 Logger。
 *
 * @param {object} [options]
 * @param {'debug'|'info'|'warn'|'error'|'silent'} [options.level='info'] 最低输出级别
 * @param {string} [options.namespace='seewo-aura'] 命名空间前缀，便于多模块区分
 * @param {(line: string, record: object) => void} [options.sink] 自定义输出目标；
 *        缺省写 process.stdout / process.stderr。注入 sink 后测试无需劫持控制台。
 * @param {() => Date} [options.now] 时间源，注入后可在测试中得到确定的时间戳
 * @returns {object} logger 实例
 */
function createLogger(options) {
  const opts = options || {};
  let level = LEVELS[opts.level] === undefined ? LEVELS.info : LEVELS[opts.level];
  const namespace = opts.namespace || 'seewo-aura';
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const sink = typeof opts.sink === 'function'
    ? opts.sink
    : function (line, record) {
        // 错误级别走 stderr，其余走 stdout —— 与常见 CLI 约定一致
        const stream = record.level === 'error' || record.level === 'warn'
          ? process.stderr
          : process.stdout;
        stream.write(line + '\n');
      };

  /**
   * 核心输出函数。
   * 时间戳使用 ISO-8601 本地可读形式：2026-10-21T14:52:51.123Z 风格（由 toISOString 提供）。
   */
  function write(lvl, args) {
    if (LEVELS[lvl] < level) return false;
    const time = now();
    const ts = time instanceof Date ? time.toISOString() : String(time);
    const body = Array.prototype.slice.call(args).map(formatArg).join(' ');
    const record = {
      level: lvl,
      namespace: namespace,
      timestamp: ts,
      message: body,
      args: Array.prototype.slice.call(args),
    };
    const line = '[' + ts + '] [' + lvl.toUpperCase() + '] [' + namespace + '] ' + body;
    try {
      sink(line, record);
    } catch (_) {
      // 日志失败绝不能影响主流程（屏保 hook 属于运行期旁路逻辑）
    }
    return true;
  }

  const logger = {
    /** 当前生效的级别名 */
    get level() {
      return Object.keys(LEVELS).find(function (k) { return LEVELS[k] === level; }) || 'info';
    },
    /** 运行期调整级别（供 IPC setConfig.logLevel 使用） */
    setLevel: function (next) {
      if (LEVELS[next] === undefined) {
        throw new Error('[logger] 非法日志级别: ' + next + '，可选 ' + Object.keys(LEVELS).join('/'));
      }
      level = LEVELS[next];
      return logger.level;
    },
    debug: function () { return write('debug', arguments); },
    info: function () { return write('info', arguments); },
    warn: function () { return write('warn', arguments); },
    error: function () { return write('error', arguments); },
    /** 派生一个带子命名空间的 logger，共享级别与 sink */
    child: function (sub) {
      return createLogger({
        level: logger.level,
        namespace: namespace + ':' + sub,
        sink: sink,
        now: now,
      });
    },
  };
  return logger;
}

module.exports = { createLogger: createLogger, LEVELS: LEVELS };
