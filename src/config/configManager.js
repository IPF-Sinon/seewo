'use strict';
/**
 * src/config/configManager.js —— 配置的加载 / 合并 / 原子写 / 容错恢复
 *
 * 设计目标（对齐 task-2 要求）：
 *   - 加载：JSON 损坏时**不抛异常**，回退到备份或默认值，并把损坏文件改名留证。
 *   - 保存：原子写（先写同目录临时文件，fsync 后 rename 覆盖），避免半截文件。
 *   - 幂等：相同内容重复 save 时改动的 mtime 允许变化，但语义状态不变；
 *            set()/patch() 相同值返回 no-op 标记，便于 hook 侧跳过重复重装。
 *   - 可回滚：每次成功写入前把上一版压入内存历史（容量有限），支持 rollback()。
 *
 * 纯 Node.js：只依赖 fs / path / os，不 require electron。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const schema = require('./schema.js');

const CONFIG_FILE_NAME = schema.CONFIG_FILE_NAME;
const DEFAULT_CONFIG = schema.DEFAULT_CONFIG;

/** 历史栈深度上限（回滚用） */
const MAX_HISTORY = 10;

/**
 * 生成默认配置目录：<用户数据目录>/seewo-aura-screensaver
 * 与管家自身的 ProgramData 路径解耦，避免污染目标软件数据。
 */
function defaultConfigDir() {
  let base;
  try {
    base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || os.homedir();
  } catch (_) {
    base = os.tmpdir();
  }
  if (!base) base = os.tmpdir();
  return path.join(base, 'seewo-aura-screensaver');
}

/** 判断路径是否可写（用于原子写前的快速检查与降级） */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

class ConfigManager {
  /**
   * @param {object} [options]
   * @param {string} [options.configDir] 配置目录；缺省见 defaultConfigDir()
   * @param {string} [options.fileName] 配置文件名；缺省 aura-screensaver.json
   * @param {object} [options.defaults] 默认配置覆盖（测试常注入小对象）
   * @param {object} [options.logger] 日志器（src/logger.js 的实例）
   * @param {boolean} [options.readOnly=false] 只读模式：save 永不落盘（无权限环境的降级）
   */
  constructor(options) {
    const opts = options || {};
    this.configDir = opts.configDir || defaultConfigDir();
    this.fileName = opts.fileName || CONFIG_FILE_NAME;
    this.filePath = path.join(this.configDir, this.fileName);
    this.defaults = schema.deepClone(opts.defaults || DEFAULT_CONFIG);
    this.log = opts.logger || createNoopLogger();
    this.readOnly = opts.readOnly === true;

    /** @type {object} 当前生效配置（永远是通过校验的完整对象） */
    this.config = schema.deepClone(this.defaults);
    /** 历史快照栈，最新在末尾 */
    this.history = [];
    /** 内存态标记：磁盘不可用时为 true，仅本次进程有效 */
    this.memoryOnly = false;
  }

  /**
   * 从磁盘加载配置。
   * 容错顺序：主文件 -> 最新可解析的备份 -> 默认值。
   * 绝不因为文件损坏而抛异常（保证注入工具能起来）。
   *
   * @returns {{config: object, source: 'file'|'backup'|'defaults', recovered: boolean, error?: string}}
   */
  load() {
    const primary = this._tryLoadFile(this.filePath);
    if (primary.ok) {
      const validated = this._validateOrNull(primary.value);
      if (validated) {
        this.config = validated;
        this.log.info('配置已加载: ' + this.filePath + ' (source=file)');
        return { config: schema.deepClone(this.config), source: 'file', recovered: false };
      }
      // 结构非法：不是"文件坏"，而是"内容不合法"，同样走恢复路径
      this.log.warn('配置文件结构非法，尝试备份恢复: ' + (primary.error || '校验失败'));
    } else if (primary.missing) {
      this.log.info('配置文件不存在，使用默认值: ' + this.filePath);
      this.config = schema.deepClone(this.defaults);
      return { config: schema.deepClone(this.config), source: 'defaults', recovered: false };
    } else {
      // JSON 语法损坏：改名为 .corrupt-<ts> 留证，绝不再覆盖写坏文件
      this.log.warn('配置文件解析失败: ' + primary.error);
      this._quarantineCorruptFile();
    }

    const fromBackup = this._tryLoadBackups();
    if (fromBackup) {
      this.config = fromBackup;
      this.log.warn('已从备份恢复配置');
      return { config: schema.deepClone(this.config), source: 'backup', recovered: true };
    }

    this.config = schema.deepClone(this.defaults);
    this.log.warn('无可用备份，回退默认配置');
    return {
      config: schema.deepClone(this.config),
      source: 'defaults',
      recovered: true,
      error: primary.error,
    };
  }

  /**
   * 保存配置（原子写）。
   * 流程：recordHistory -> validate（已校验对象直接透传）-> 写临时文件 -> fsync -> rename。
   * 失败时不破坏原文件，并降级为内存态（memoryOnly=true）而不是抛异常中断主流程。
   *
   * @param {object} next 完整或部分配置
   * @returns {{ok: boolean, atomic: boolean, memoryOnly: boolean, changed: boolean, error?: string}}
   */
  save(next) {
    let validated;
    try {
      validated = schema.validateConfig(next);
    } catch (err) {
      // 校验失败属于调用方错误，向上抛（IPC 层需要把明确错误回给 UI）
      throw err;
    }
    const changed = JSON.stringify(validated) !== JSON.stringify(this.config);
    if (!changed) {
      this.log.debug('配置无变化，跳过写入（幂等）');
      return { ok: true, atomic: true, memoryOnly: this.memoryOnly, changed: false };
    }

    this._pushHistory(this.config);
    this.config = validated;

    if (this.readOnly) {
      this.memoryOnly = true;
      this.log.warn('只读模式：配置仅保留在内存中');
      return { ok: true, atomic: false, memoryOnly: true, changed: true };
    }

    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      this._atomicWrite(this.filePath, JSON.stringify(validated, null, 2) + '\n');
      this.memoryOnly = false;
      this.log.info('配置已原子写入: ' + this.filePath);
      return { ok: true, atomic: true, memoryOnly: false, changed: true };
    } catch (err) {
      this.memoryOnly = true;
      this.log.error('配置写入失败，降级为内存态: ' + err.message);
      return { ok: false, atomic: false, memoryOnly: true, changed: true, error: err.message };
    }
  }

  /**
   * 局部更新（浅合并后保存）。
   * @param {object} patch 要覆盖的字段
   * @returns {object} save() 的返回值
   */
  patch(patch) {
    const merged = schema.mergeConfig(this.config, patch);
    return this.save(merged);
  }

  /**
   * 回滚到上一版配置。
   * @param {number} [steps=1] 回退步数
   * @returns {{ok: boolean, config?: object, error?: string}}
   */
  rollback(steps) {
    const n = Math.max(1, Math.floor(steps || 1));
    if (this.history.length < n) {
      return { ok: false, error: '没有足够的历史快照可回滚（当前 ' + this.history.length + ' 份）' };
    }
    for (let i = 0; i < n; i++) this.config = this.history.pop();
    const res = this.save(this.config);
    this.log.info('配置已回滚 ' + n + ' 步');
    return { ok: res.ok, config: schema.deepClone(this.config), error: res.error };
  }

  /**
   * 重置为默认配置。
   */
  reset() {
    return this.save(schema.deepClone(this.defaults));
  }

  /** 只读快照，外部拿到的对象改动不会污染内部状态 */
  getConfig() {
    return schema.deepClone(this.config);
  }

  /** 运行期状态，供 IPC status 使用 */
  getStatus() {
    return {
      configPath: this.filePath,
      configDir: this.configDir,
      memoryOnly: this.memoryOnly,
      readOnly: this.readOnly,
      historyDepth: this.history.length,
      config: schema.deepClone(this.config),
    };
  }

  // ---------- 内部实现 ----------

  /**
   * 原子写：同目录临时文件 -> fsync -> rename。
   * rename 在同一文件系统内是原子的（POSIX 语义；Windows 上 Node 的 fs.renameSync
   * 对已存在目标也能覆盖），因此读者永远看到完整的旧版或完整的新版。
   */
  _atomicWrite(filePath, content) {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(
      dir,
      '.' + path.basename(filePath) + '.' + process.pid + '.' + Date.now() + '.tmp'
    );
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeFileSync(fd, content, 'utf8');
      // fsync 确保 rename 前数据真正落盘，防断电后出现空文件
      try { fs.fsyncSync(fd); } catch (_) { /* 某些文件系统不支持，忽略 */ }
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      }
    }
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // rename 失败时清理临时文件，避免残留
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      throw err;
    }
    this._pruneBackups();
  }

  /**
   * 每次成功写盘后滚动备份：file -> file.bak.0 -> file.bak.1 ...
   * 只在主文件可读时才做，避免把刚写的文件读成半截。
   */
  _pruneBackups() {
    const keep = (this.config.backupCount || DEFAULT_CONFIG.backupCount) - 1;
    if (keep <= 0) return;
    for (let i = keep - 1; i >= 0; i--) {
      const from = i === 0 ? this.filePath : this.filePath + '.bak.' + (i - 1);
      const to = this.filePath + '.bak.' + i;
      try {
        if (fs.existsSync(from)) fs.copyFileSync(from, to);
      } catch (_) { /* 备份失败不影响主流程 */ }
    }
  }

  /** 尝试解析单个文件；区分「不存在」与「损坏」 */
  _tryLoadFile(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, missing: true };
      return { ok: false, error: err.message };
    }
    if (!raw.trim()) return { ok: false, error: '文件为空' };
    try {
      const parsed = JSON.parse(raw);
      if (!schema.isPlainObject(parsed)) {
        return { ok: false, error: '顶层必须是 JSON 对象' };
      }
      return { ok: true, value: parsed };
    } catch (err) {
      return { ok: false, error: 'JSON 语法错误: ' + err.message };
    }
  }

  /** 校验失败时返回 null 而不抛，便于 load 走降级路径 */
  _validateOrNull(value) {
    try {
      return schema.validateConfig(value);
    } catch (err) {
      this.log.warn('配置校验失败: ' + err.message);
      return null;
    }
  }

  /** 依次尝试 .bak.0, .bak.1 ... */
  _tryLoadBackups() {
    for (let i = 0; i < 5; i++) {
      const p = this.filePath + '.bak.' + i;
      const r = this._tryLoadFile(p);
      if (!r.ok) continue;
      const v = this._validateOrNull(r.value);
      if (v) return v;
    }
    return null;
  }

  /** 把损坏文件改名保留，避免下次启动又被它挡住 */
  _quarantineCorruptFile() {
    const target = this.filePath + '.corrupt-' + Date.now();
    try {
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, target);
        this.log.warn('损坏配置已隔离: ' + target);
      }
    } catch (err) {
      this.log.warn('损坏配置隔离失败: ' + err.message);
    }
  }

  _pushHistory(cfg) {
    this.history.push(schema.deepClone(cfg));
    while (this.history.length > MAX_HISTORY) this.history.shift();
  }
}

/** 未注入 logger 时的空实现（不引入 src/logger.js 以避免循环依赖） */
function createNoopLogger() {
  const noop = function () {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: function () { return createNoopLogger(); } };
}

module.exports = {
  ConfigManager: ConfigManager,
  defaultConfigDir: defaultConfigDir,
  isWritableDir: isWritableDir,
  MAX_HISTORY: MAX_HISTORY,
};
