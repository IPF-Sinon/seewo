'use strict';
/**
 * 配置 schema 测试
 *
 * 覆盖现象：
 *   配置工具的全部输入都来自用户手写 JSON，必须先被校验挡住脏数据，
 *   否则会把渲染器不认识的字段下发给屏保（渲染器对 undefined 行为未定义）。
 *
 * 回归的真实约束（来自 RENDERER_CONTRACT.md，逐字解码自 screensaver.js）：
 *   - switchInterval 单位是**秒**（渲染器做 1000 * (switchInterval || 15)）
 *   - pictureSizeType 只接受数字 0|1（映射 D = ["contain","cover"]）
 *   - 转场数组长度必须 === imageList.length，值域 0..6（官方 Math.random()*7）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const schema = require('../src/config/schema.js');

test('默认配置零配置可用，且关键默认值对齐官方兜底值', () => {
  const cfg = schema.DEFAULT_CONFIG;
  assert.equal(cfg.screensaverEnabled, true, '默认应放行屏保（不改变官方行为）');
  assert.equal(cfg.lockCascadeOnClose, false, '默认应拦截「关屏保→锁屏」级联');
  assert.equal(cfg.override, null, '默认不覆盖云端数据');
  // 官方兜底：渲染器 e.switchInterval || 15
  assert.equal(schema.DEFAULT_SWITCH_INTERVAL, 15);
  assert.equal(schema.DEFAULT_OVERRIDE.switchInterval, 15);
});

// mergeConfig(base, patch)：以 base 为底，用 patch 覆盖，缺省字段由 base（通常是 DEFAULT_CONFIG）补全。
test('mergeConfig 以默认配置为底补全缺省字段，且不污染入参', () => {
  const patch = { screensaverEnabled: false };
  const merged = schema.mergeConfig(schema.DEFAULT_CONFIG, patch);
  assert.equal(merged.screensaverEnabled, false, '显式值应保留');
  assert.equal(merged.lockCascadeOnClose, false, '缺省字段应用默认值补全');
  assert.equal(merged.allowManualClose, true, '其余默认值同样补齐');
  assert.equal(patch.lockCascadeOnClose, undefined, '不应污染调用方传入的 patch 对象');
  assert.notEqual(merged, schema.DEFAULT_CONFIG, '应返回新对象，不修改 DEFAULT_CONFIG');
});

test('mergeConfig 可整体替换 override 块（override 为整体语义）', () => {
  const merged = schema.mergeConfig(schema.DEFAULT_CONFIG, {
    override: { switchInterval: 30 },
  });
  assert.equal(merged.override.switchInterval, 30, '显式值保留');
  // override 为整体覆盖语义：缺省字段由 validateConfig/applyOverride 阶段补全，
  // 不在 mergeConfig 层做深合并，避免「云端数据」与「默认值」语义混淆。
  assert.equal(merged.override.pictureSizeType, undefined, 'mergeConfig 不深合并 override');
  // 经校验后应补全为合法配置
  const validated = schema.validateConfig(merged);
  assert.equal(validated.override.pictureSizeType, 0, '校验阶段补全 override 缺省字段');
  assert.equal(validated.override.materialSource, '希沃集控');
});

test('validateConfig 接受合法配置', () => {
  const r = schema.validateConfig({
    screensaverEnabled: false,
    lockCascadeOnClose: true,
    override: {
      materialSource: '测试来源',
      switchInterval: 20,
      pictureSizeType: 1,
      imageList: ['C:\\a.png', 'C:\\b.png'],
      textList: [{ content: '正文', provenance: '出处' }],
    },
  });
  assert.ok(r, '合法配置应通过校验');
  assert.notEqual(r.ok, false, '不应返回失败');
});

test('validateConfig 拒绝非法的 switchInterval（必须为正整数秒）', () => {
  // 0 / 负数 / 非数字 / null / 对象 都应被拒绝
  for (const bad of [0, -5, 'abc', null, {}]) {
    assert.throws(
      () => schema.validateConfig({ override: { switchInterval: bad } }),
      (err) => err instanceof schema.ConfigValidationError || err.code === 'E_CONFIG_INVALID',
      '非法 switchInterval 应被拒绝: ' + JSON.stringify(bad)
    );
  }
});

test('★ 回归：switchInterval 小数应被拒绝或明确取整，不得静默截断', () => {
  // 缺陷背景：早期实现用 Math.floor 把 1.5 静默变成 1，
  // 用户写 1.5 秒会得到 1 秒且毫无提示 —— 属于静默数据损坏。
  // 期望：非整数直接报错（配置是人工手写 JSON，报错比猜测更安全）。
  assert.throws(
    () => schema.validateConfig({ override: { switchInterval: 1.5 } }),
    (err) => err.code === 'E_CONFIG_INVALID' || err instanceof schema.ConfigValidationError,
    'switchInterval=1.5 应被拒绝，而不是静默截断为 1'
  );
  assert.throws(
    () => schema.validateConfig({ override: { switchInterval: 2.0001 } }),
    (err) => err.code === 'E_CONFIG_INVALID' || err instanceof schema.ConfigValidationError,
    '任意非整数都应被拒绝'
  );
  // 合法整数仍应通过
  assert.equal(
    schema.validateConfig({ override: { switchInterval: 30 } }).override.switchInterval,
    30,
    '合法整数应原样保留'
  );
});

test('validateConfig 拒绝越界的 pictureSizeType（只允许 0|1）', () => {
  // 2 会让渲染器拿到 D[2] === undefined，组件行为未定义
  for (const bad of [2, -1, 99, 'contain']) {
    assert.throws(
      () => schema.validateConfig({ override: { pictureSizeType: bad } }),
      (err) => err.code === 'E_CONFIG_INVALID' || err instanceof schema.ConfigValidationError,
      '非法 pictureSizeType 应被拒绝: ' + JSON.stringify(bad)
    );
  }
});

test('validateConfig 拒绝未知字段（防止下发渲染器不认识的数据）', () => {
  assert.throws(
    () => schema.validateConfig({ override: { totallyUnknownField: 1 } }),
    (err) => err.code === 'E_CONFIG_INVALID',
    '未知字段应被拒绝'
  );
});

test('transitions 值域：允许 0..6 边界值', () => {
  const r = schema.validateTransitionList([0, 6, 3], 3);
  assert.ok(r, '边界值 0 与 6 应被接受');
});

test('transitions 值域：拒绝越界与长度不符', () => {
  assert.throws(() => schema.validateTransitionList([7], 1), /./, '7 超出 0..6 应被拒绝');
  assert.throws(() => schema.validateTransitionList([-1], 1), /./, '负数应被拒绝');
  assert.throws(() => schema.validateTransitionList([1, 2], 3), /./, '长度 2 !== 图片数 3 应被拒绝');
});

test('边界：空图集是合法的（等价于无图片）', () => {
  const r = schema.validateConfig({ override: { imageList: [], textList: [] } });
  assert.ok(r, '空图集应被接受');
});

test('ConfigValidationError 携带字段路径便于定位', () => {
  try {
    schema.validateConfig({ override: { switchInterval: -1 } });
    assert.fail('应当抛出');
  } catch (err) {
    assert.equal(err.code, 'E_CONFIG_INVALID');
    assert.ok(typeof err.path === 'string' && err.path.length > 0, '应带字段路径: ' + err.path);
  }
});
