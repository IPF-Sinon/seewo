'use strict';
/**
 * src/ipc/handler.js —— IPC 通道（aura.screensaver.*）
 *
 * 设计目标：
 *   - 与 Electron 完全解耦：不 require electron，只依赖注入的 `ipcMain` 桩
 *     （只需有 handle(channel, fn) 与可选 removeHandler(channel)）。
 *   - 每个处理器都是**纯函数式**的：输入 (payload) -> 输出结果对象，
 *     因此可以直接被单测调用，不需要真的起 Electron。
 *   - 所有错误都以「结构化结果」返回，不把异常抛给渲染进程：
 *       成功 { ok: true, ... }
 *       失败 { ok: false, code, message, path? }
 *
 * 通道命名对齐 HugoAura-Enhanced 的 global.__HUGO_AURA__ 风格，使用命名空间前缀。
 */

const schema = require('../config/schema.js');

/** 通道常量表 */
const CHANNELS = Object.freeze({
  GET_CONFIG: 'aura.screensaver.getConfig',
  SET_CONFIG: 'aura.screensaver.setConfig',
  PATCH_CONFIG: 'aura.screensaver.patchConfig',
  RESET_CONFIG: 'aura.screensaver.resetConfig',
  ROLLBACK: 'aura.screensaver.rollback',
  STATUS: 'aura.screensaver.status',
  PREVIEW: 'aura.screensaver.preview',
});

/** 把异常统一转成结构化错误对象 */
function toErrorResult(err) {
  if (err && err.name === 'ConfigValidationError') {
    return {
      ok: false,
      code: err.code || 'E_CONFIG_INVALID',
      message: err.message,
      path: err.path || '',
    };
  }
  return {
    ok: false,
    code: (err && err.code) || 'E_INTERNAL',
    message: (err && err.message) || String(err),
  };
}

/**
 * 创建 IPC 处理器集合（不注册，只返回函数表）—— 便于单测直接调用。
 *
 * @param {object} ctx
 * @param {object} ctx.configManager ConfigManager 实例
 * @param {object} [ctx.screensaverHook] ScreensaverHook 实例
 * @param {object} [ctx.lockCascadeGuard] LockCascadeGuard 实例
 * @param {object} [ctx.logger]
 * @returns {object} { getConfig, setConfig, patchConfig, resetConfig, rollback, status, preview }
 */
function createHandlers(ctx) {
  const configManager = ctx.configManager;
  const hook = ctx.screensaverHook || null;
  const guard = ctx.lockCascadeGuard || null;
  const log = ctx.logger || { debug() {}, info() {}, warn() {}, error() {} };

  if (!configManager) {
    throw new Error('[ipc] 缺少 configManager，无法创建处理器');
  }

  /** 配置变更后同步运行期副作用（重启 hook / 调整日志级别） */
  function applySideEffects(cfg, changed) {
    if (changed && changed.logLevel && log.setLevel) {
      try { log.setLevel(cfg.logLevel); } catch (err) { log.warn('设置日志级别失败: ' + err.message); }
    }
    // 注意：ScreensaverHook 每次 handleMessage 都实时读 ConfigManager，
    // 因此禁用/启用、图集变更**无需**重装 hook，天然幂等。
    // LockCascadeGuard 同理（每次 close 时实时读配置）。
    return true;
  }

  return {
    /** 读取当前配置 */
    getConfig() {
      try {
        return { ok: true, config: configManager.getConfig() };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    /**
     * 全量设置配置。
     * @param {object} payload 完整配置对象
     */
    setConfig(payload) {
      try {
        const before = configManager.getConfig();
        const res = configManager.save(payload);
        const after = configManager.getConfig();
        const changed = schema.diffConfig(before, after);
        applySideEffects(after, changed);
        log.info('IPC setConfig: 已更新 ' + Object.keys(changed).join(',') || '(无变化)');
        return {
          ok: true,
          changed: Object.keys(changed),
          persisted: res.atomic === true,
          memoryOnly: res.memoryOnly === true,
          config: after,
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    /**
     * 局部更新（推荐：UI 只传用户改动的字段）。
     * @param {object} payload 部分配置
     */
    patchConfig(payload) {
      try {
        if (!payload || typeof payload !== 'object') {
          return { ok: false, code: 'E_CONFIG_INVALID', message: 'patch 载荷必须是对象' };
        }
        const before = configManager.getConfig();
        const res = configManager.patch(payload);
        const after = configManager.getConfig();
        const changed = schema.diffConfig(before, after);
        applySideEffects(after, changed);
        return {
          ok: true,
          changed: Object.keys(changed),
          persisted: res.atomic === true,
          memoryOnly: res.memoryOnly === true,
          config: after,
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    /** 恢复默认配置 */
    resetConfig() {
      try {
        configManager.reset();
        const after = configManager.getConfig();
        applySideEffects(after, { logLevel: true });
        log.info('IPC resetConfig: 已恢复默认配置');
        return { ok: true, config: after };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    /**
     * 回滚到上一版配置。
     * @param {{steps?: number}} [payload]
     */
    rollback(payload) {
      try {
        const steps = payload && payload.steps ? payload.steps : 1;
        const res = configManager.rollback(steps);
        if (!res.ok) return { ok: false, code: 'E_NO_HISTORY', message: res.error };
        return { ok: true, config: res.config };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    /** 运行期状态：配置 + hook + 守卫 */
    status() {
      try {
        const st = configManager.getStatus();
        return {
          ok: true,
          configPath: st.configPath,
          memoryOnly: st.memoryOnly,
          readOnly: st.readOnly,
          historyDepth: st.historyDepth,
          config: st.config,
          hook: hook && typeof hook.getStatus === 'function' ? hook.getStatus() : null,
          guard: guard && typeof guard.getStatus === 'function' ? guard.getStatus() : null,
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },

    /**
     * 预览：给定 override，返回最终会下发给渲染器的 screensaverMessage 载荷。
     * 对应 RENDERER_CONTRACT.md 的字段表，方便 UI 侧「所见即所得」。
     *
     * @param {object} [payload] 可选：{ override, sample } —— sample 模拟云端下发数据
     */
    preview(payload) {
      try {
        const p = payload || {};
        const cfg = configManager.getConfig();
        const override = p.override !== undefined ? p.override : cfg.override;
        // 校验传入的 override（若非法则明确报错，便于 UI 即时反馈）
        const validated = schema.validateOverride(
          override === null ? null : schema.mergeConfig(schema.DEFAULT_OVERRIDE, override || {}),
          'override'
        );
        const sample = p.sample || {};
        const imageList = (validated && validated.imageList && validated.imageList.length > 0)
          ? validated.imageList
          : (Array.isArray(sample.imageList) ? sample.imageList : []);
        const imageCount = imageList.length;

        let transition = null;
        if (validated && validated.transitionList) {
          transition = schema.validateTransitionList(validated.transitionList, imageCount, 'override.transitionList');
        } else if (imageCount > 0) {
          transition = require('../hooks/screensaverHook.js').generateTransitionList(imageCount);
        }

        return {
          ok: true,
          /** 最终下发给渲染器的 screensaverMessage 载荷 */
          message: {
            materialSource: (validated && validated.materialSource) || (sample.materialSource || ''),
            switchInterval: (validated && validated.switchInterval) || sample.switchInterval || 15,
            pictureSizeType: (validated && validated.pictureSizeType) !== undefined
              ? validated.pictureSizeType
              : (sample.pictureSizeType || 0),
            imageList: imageList,
            textList: (validated && validated.textList && validated.textList.length > 0)
              ? validated.textList
              : (Array.isArray(sample.textList) ? sample.textList : []),
          },
          /** 对应的 screensaverTransitionList */
          transitionList: transition,
          /** 自检信息，便于 UI 显示约束是否满足 */
          constraints: {
            transitionLengthMatchesImages: transition === null ? null : transition.length === imageCount,
            transitionValueRange: transition === null ? null : transition.every(function (v) { return v >= 0 && v <= 6; }),
            pictureSizeTypeValid: true,
          },
        };
      } catch (err) {
        return toErrorResult(err);
      }
    },
  };
}

/**
 * 把处理器注册到 ipcMain 桩上。
 *
 * @param {object} ipcMain 需有 handle(channel, listener)；可选 removeHandler
 * @param {object} handlers createHandlers() 的返回值
 * @returns {string[]} 已注册的通道名
 */
function registerHandlers(ipcMain, handlers) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('[ipc] ipcMain 桩缺少 handle(channel, listener) 方法');
  }
  const registered = [];
  for (const key of Object.keys(CHANNELS)) {
    const channel = CHANNELS[key];
    const fn = handlers[key.charAt(0).toLowerCase() + key.slice(1)];
    if (typeof fn !== 'function') continue;
    // Electron 的 handle 回调签名是 (event, ...args)，这里丢弃 event 只取业务载荷
    ipcMain.handle(channel, function (_event, payload) {
      return fn(payload);
    });
    registered.push(channel);
  }
  return registered;
}

/**
 * 从 ipcMain 桩上注销全部通道（可回滚）。
 * @returns {string[]} 已注销的通道名
 */
function unregisterHandlers(ipcMain) {
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return [];
  const removed = [];
  for (const key of Object.keys(CHANNELS)) {
    const channel = CHANNELS[key];
    try {
      ipcMain.removeHandler(channel);
      removed.push(channel);
    } catch (_) { /* 未注册过则忽略 */ }
  }
  return removed;
}

module.exports = {
  CHANNELS: CHANNELS,
  createHandlers: createHandlers,
  registerHandlers: registerHandlers,
  unregisterHandlers: unregisterHandlers,
  toErrorResult: toErrorResult,
};
