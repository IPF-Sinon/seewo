'use strict';
/**
 * 模块定位测试
 *
 * 覆盖现象：
 *   注入式方案必须在被打包混淆的 bundle 里找到官方模块，才能包装它的方法。
 *   bundle 里没有稳定的模块 id（会随版本变化），所以只能靠「源码锚点」定位。
 *   关键要求：**找不到时必须优雅失败（返回 null），绝不能抛异常**，
 *   否则会连带把官方主进程启动流程打断 —— 这是最容易变砖的地方。
 *
 * ★ 夹具来源说明（避免"测试通过但夹具是假的"）：
 *   test/helpers/realExcerpts.js 里的模块体是**逐字取自真实 .work/app/main.js** 的节选，
 *   由脚本生成，保留真实 bundle 的 `},{function(e,t,n){...}` 结构。
 *   真实 bundle 的模块头带前导逗号（形如 `},function(e,t,n){`），因此夹具同样以
 *   `,function(` 开头 —— 这一点曾导致手写样例无法命中扫描器。
 *
 *   注意：合成夹具里 moduleId 退化为「扫描顺序下标」，verified=false，
 *   因为交叉验证依赖真实 bundle 里的 n(<id>) 引用图。真实 bundle 上
 *   moduleId 与 verified 都是正确的（见下方"真实 bundle"用例）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findModule, ANCHORS, dumpModuleIds } = require('../src/module/findModule.js');
const { REAL_EXCERPTS } = require('./helpers/realExcerpts.js');

const REAL_BUNDLE_PATH = path.join(__dirname, '..', '.work', 'app', 'main.js');
const hasRealBundle = fs.existsSync(REAL_BUNDLE_PATH);

test('ANCHORS 常量存在且每个锚点都有 patterns', () => {
  assert.ok(ANCHORS && typeof ANCHORS === 'object', 'ANCHORS 应导出');
  const keys = Object.keys(ANCHORS);
  assert.ok(keys.length > 0, '至少应有一个锚点');
  for (const k of keys) {
    assert.ok(Array.isArray(ANCHORS[k].patterns) && ANCHORS[k].patterns.length > 0, k + ' 应有 patterns');
  }
  assert.ok(keys.includes('screensaverController'), '应有屏保控制器锚点');
  assert.ok(keys.includes('windowManager'), '应有窗口管理器锚点');
});

test('能在真实节选 bundle 上定位到屏保控制器模块', () => {
  const m = findModule(REAL_EXCERPTS, 'screensaverController');
  assert.ok(m, '应找到控制器模块');
  const body = REAL_EXCERPTS.slice(m.start, m.end + 1);
  assert.ok(body.includes('/displayScreenSaver'), '定位到的模块应含触发路由');
  assert.ok(body.includes('screensaverMessage'), '应含数据通道');
  assert.ok(body.includes('screensaverTransitionList'), '应含转场通道');
});

test('能定位到窗口管理器模块（含 close→startLock 级联）', () => {
  const m = findModule(REAL_EXCERPTS, 'windowManager');
  assert.ok(m, '应找到窗口管理器模块');
  const body = REAL_EXCERPTS.slice(m.start, m.end + 1);
  assert.ok(body.includes('newWindow('), '应含 newWindow');
  assert.ok(body.includes('windowsList'), '应含 windowsList');
  assert.ok(body.includes('startLock'), '应含级联的 startLock');
});

test('能定位到任务常量模块', () => {
  const m = findModule(REAL_EXCERPTS, 'taskConstants');
  assert.ok(m, '应找到任务常量模块');
  const body = REAL_EXCERPTS.slice(m.start, m.end + 1);
  assert.ok(body.includes('SCREENSAVER:"SCREENSAVER"'), '应含 SCREENSAVER 常量');
});

test('返回结构包含定位所需字段', () => {
  const m = findModule(REAL_EXCERPTS, 'screensaverController');
  assert.ok(m, '应找到');
  assert.equal(typeof m.start, 'number', '应有 start');
  assert.equal(typeof m.end, 'number', '应有 end');
  assert.ok(m.end > m.start, 'end 应大于 start');
  assert.equal(typeof m.moduleId, 'number', '应有 moduleId（合成夹具下为顺序下标）');
  assert.equal(typeof m.verified, 'boolean', '应有 verified 标记');
});

test('找不到锚点时返回 null 而不抛异常（防变砖）', () => {
  let result;
  assert.doesNotThrow(() => {
    result = findModule('var a = 1; // 完全无关的代码', 'screensaverController');
  }, '找不到时必须不抛异常');
  assert.equal(result, null, '应返回 null 表示未找到');
});

test('空输入 / null / 非法锚点名都安全', () => {
  assert.doesNotThrow(() => findModule('', 'screensaverController'));
  assert.doesNotThrow(() => findModule(null, 'screensaverController'));
  assert.doesNotThrow(() => findModule(undefined, 'screensaverController'));
  assert.doesNotThrow(() => findModule(REAL_EXCERPTS, '不存在的锚点名'));
  assert.equal(findModule('', 'screensaverController'), null);
  assert.equal(findModule(null, 'screensaverController'), null);
  assert.equal(findModule(REAL_EXCERPTS, '不存在的锚点名'), null);
});

test('dumpModuleIds 返回每个锚点的定位结果（找不到为 null）', () => {
  const ids = dumpModuleIds(REAL_EXCERPTS);
  assert.ok(ids && typeof ids === 'object', '应返回对象');
  for (const k of Object.keys(ANCHORS)) {
    assert.ok(k in ids, '应包含锚点 ' + k);
  }
  assert.notEqual(ids.screensaverController, null, '合成夹具中控制器应可定位');
  assert.equal(ids.taskQueue, null, '夹具未包含 taskQueue，应为 null');
});

test('★ 真实 bundle 验证：moduleId 与 verified 均正确', { skip: !hasRealBundle && '真实 bundle 不存在（.work 未解包）' }, () => {
  const real = fs.readFileSync(REAL_BUNDLE_PATH, 'utf8');
  const expected = {
    taskConstants: 38,
    windowManager: 69,
    taskQueue: 39,
    screenLock: 40,
    screensaverController: 120,
  };
  for (const [key, id] of Object.entries(expected)) {
    const r = findModule(real, key);
    assert.ok(r, key + ' 应在真实 bundle 中定位成功');
    assert.equal(r.moduleId, id, key + ' 的 moduleId 应为 ' + id);
    assert.equal(r.verified, true, key + ' 应通过 n(<id>) 交叉验证');
  }
});
