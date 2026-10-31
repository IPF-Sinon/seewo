'use strict';
const T = window.__TAURI__ || {};
const invoke = (T.core && T.core.invoke) || T.invoke;
const $ = (id) => document.getElementById(id);

let STATE = null;
let toastTimer = null;

function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
}
function showModal(title, body) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  $('modal').classList.remove('hidden');
}
async function call(cmd, args) {
  try {
    return await invoke(cmd, args || {});
  } catch (e) {
    toast(typeof e === 'string' ? e : (e && e.message) || '操作失败', 'err');
    throw e;
  }
}

// ---------------- 渲染 ----------------

function currentMode() {
  const r = document.querySelector('input[name=mode]:checked');
  return r ? r.value : 'none';
}

function applyModeUI() {
  const m = currentMode();
  $('paneImage').hidden = m !== 'image';
  $('paneWeb').hidden = m !== 'web';
  $('paneNone').hidden = m !== 'none';

  const hints = {
    image: '用自己的图片替换集控下发的屏保图。转场数量需与图片数一致；留空则随机。',
    web: '用网页或本地视频当屏保。网页模式会忽略下面的显示参数（由网页自己决定）。',
    none: '不修改图片，只调整显示参数 —— 最安全的一种。'
  };
  $('modeHint').textContent = hints[m] || '';

  const web = m === 'web';
  $('numInterval').disabled = web;
  document.querySelectorAll('input[name=fit]').forEach(function (r) { r.disabled = web; });
  $('txtTrans').disabled = web;
}

function renderState() {
  if (!STATE) return;
  const s = STATE;
  $('subtitle').textContent = '版本 ' + s.version + (s.seewoDir ? '' : ' · 未找到希沃目录');

  const grid = $('stateGrid');
  grid.innerHTML = '';
  const rows = [
    ['希沃目录', s.seewoDir || '未找到'],
    ['app.asar', s.asarExists ? '存在' : '缺失'],
    ['备份 .bak', s.bakExists ? '存在' : '无'],
    ['注入状态', s.injected ? '已注入' : (s.injectionNote || '未注入'), s.injected ? 'ok' : 'bad'],
    ['管理员', s.isAdmin ? '是' : '否', s.isAdmin ? 'ok' : 'bad'],
    ['安全模式', s.safeMode ? '是' : '否']
  ];
  rows.forEach(function (r) {
    const dt = document.createElement('dt');
    dt.textContent = r[0];
    const dd = document.createElement('dd');
    dd.textContent = r[1];
    if (r[2]) dd.className = r[2];
    grid.appendChild(dt);
    grid.appendChild(dd);
  });

  $('adminHint').textContent = s.isAdmin
    ? ''
    : '提示：注入 / 卸载需要管理员权限，且正常模式下常被希沃驱动拦写，通常要在安全模式里做。';
  $('adminHint').className = s.isAdmin ? 'hint' : 'hint warn';

  const cfg = s.config || {};
  $('chkEnabled').checked = cfg.screensaverEnabled !== false;
  $('chkLock').checked = cfg.lockCascadeOnClose === true;

  const web = cfg.web || {};
  $('txtUrl').value = web.url || '';
  $('chkSysBrowser').checked = web.useSystemBrowser === true;
  $('chkBundled').checked = web.useBundledKernel === true;
  $('txtBrowserPath').value = web.browserPath || '';

  let mode = cfg.mode;
  if (mode !== 'image' && mode !== 'web' && mode !== 'none') {
    mode = web.enabled ? 'web' : ((cfg.override && cfg.override.imageList && cfg.override.imageList.length) ? 'image' : 'none');
  }
  const mr = document.querySelector('input[name=mode][value=' + mode + ']');
  if (mr) mr.checked = true;

  const ov = cfg.override || {};
  $('txtSource').value = ov.materialSource || '';
  $('txtImages').value = (ov.imageList || []).join('\n');
  $('txtTexts').value = ((ov.textList || []).map(function (t) { return t && t.content ? t.content : ''; })).join('\n');
  $('numInterval').value = ov.switchInterval || 5;
  const fit = (ov.pictureSizeType === 1) ? '1' : '0';
  const fr = document.querySelector('input[name=fit][value="' + fit + '"]');
  if (fr) fr.checked = true;
  $('txtTrans').value = (ov.screensaverTransitionList || []).join(',');

  applyModeUI();
  document.querySelectorAll('button').forEach(function (b) { if (b.id !== 'modalClose') b.disabled = false; });
}

// ---------------- 收集 ----------------

function collectConfig() {
  const base = JSON.parse(JSON.stringify((STATE && STATE.config) || {}));
  const mode = currentMode();
  const web = base.web || {};
  web.enabled = (mode === 'web');
  web.url = $('txtUrl').value.trim();
  web.useSystemBrowser = $('chkSysBrowser').checked;
  web.useBundledKernel = $('chkBundled').checked;
  web.browserPath = $('txtBrowserPath').value.trim();
  base.web = web;
  base.mode = mode;
  base.screensaverEnabled = $('chkEnabled').checked;
  base.lockCascadeOnClose = $('chkLock').checked;

  const imgs = $('txtImages').value.split('\n').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
  const texts = $('txtTexts').value.split('\n').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
  const trans = $('txtTrans').value.split(/[,\uff0c\s]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; })
    .map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return !isNaN(x) && x >= 0 && x <= 6; });

  if (mode === 'image') {
    if (imgs.length === 0) throw new Error('自定义图集模式至少要填一张图片');
    if (trans.length > 0 && trans.length !== imgs.length) {
      throw new Error('转场数量（' + trans.length + '）必须等于图片数量（' + imgs.length + '），或者留空表示随机');
    }
  }
  if (mode === 'web' && !web.url) throw new Error('网页/视频模式需要填一个地址或选择文件');

  base.override = {
    materialSource: $('txtSource').value.trim(),
    imageList: imgs,
    textList: texts.map(function (t) { return { content: t }; }),
    switchInterval: Math.max(1, parseInt($('numInterval').value, 10) || 5),
    pictureSizeType: (document.querySelector('input[name=fit]:checked') || {}).value === '1' ? 1 : 0,
    screensaverTransitionList: trans
  };
  return base;
}

// ---------------- 事件 ----------------

function bind() {
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', applyModeUI); });

  $('btnSave').addEventListener('click', async function () {
    try {
      const cfg = collectConfig();
      await call('save_config', { config: cfg });
      STATE.config = cfg;
      toast('已保存。改动会在希沃下次进入屏保时生效。', 'ok');
    } catch (e) { if (e && e.message) toast(e.message, 'err'); }
  });

  $('btnPreview').addEventListener('click', async function () {
    try { await call('save_config', { config: collectConfig() }); } catch (e) { return; }
    await call('send_command', { cmd: 'preview' });
    toast('已请求预览。若没反应，说明希沃管家没在运行。', 'ok');
  });
  $('btnStop').addEventListener('click', async function () {
    await call('send_command', { cmd: 'stop' });
    toast('已请求停止预览。', 'ok');
  });

  $('btnPatch').addEventListener('click', async function () {
    const r = await call('patch_asar');
    toast(r && r.message ? r.message : '注入完成', 'ok');
    await refresh();
  });
  $('btnUnpatch').addEventListener('click', async function () {
    if (!confirm('确定要还原成官方版本吗？屏保会恢复原样。')) return;
    const r = await call('unpatch_asar');
    toast(r && r.message ? r.message : '已还原', 'ok');
    await refresh();
  });
  $('btnDiag').addEventListener('click', async function () {
    const s = await call('diagnostics');
    showModal('诊断信息', s);
  });

  $('btnOpenDefaultDir').addEventListener('click', function () { call('open_path', { which: 'defaultImages' }); });
  $('btnViewDefault').addEventListener('click', async function () {
    const r = await call('list_default_images');
    const files = (r && r.files) || [];
    if (files.length === 0) { showModal('默认图片', '还没有默认图片。\n通常在你用希沃账号登录、集控下发过屏保图片之后才会有。'); return; }
    const body = '目录：' + r.dir + '\n共 ' + files.length + ' 张\n\n' +
      files.slice(0, 60).map(function (f) { return f.name + '   ' + (f.size / 1024).toFixed(1) + ' KB'; }).join('\n') +
      (files.length > 60 ? '\n… 还有 ' + (files.length - 60) + ' 张' : '');
    showModal('默认图片（' + files.length + ' 张）', body);
  });

  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('click', function () { call('open_path', { which: b.getAttribute('data-open') }); });
  });

  $('modalClose').addEventListener('click', function () { $('modal').classList.add('hidden'); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
}

// ---------------- 启动 ----------------

async function refresh() {
  STATE = await call('get_state');
  renderState();
}

async function boot() {
  bind();
  if (!invoke) {
    $('subtitle').textContent = '无法连接后端（Tauri 未就绪）';
    return;
  }
  try {
    await refresh();
  } catch (e) {
    $('subtitle').textContent = '读取状态失败';
    return;
  }
  try {
    const k = await call('detect_browsers');
    const el = $('kernelStatus');
    el.textContent = k.kernelReady ? '新内核：已就绪' : '新内核：未下载';
    el.className = 'badge' + (k.kernelReady ? ' ok' : '');
  } catch (e) { }
  try {
    const p = await call('is_pending_safe_action');
    if (p && p.pending) {
      showModal('有待完成的动作', '检测到待办动作「' + p.action + '」。\n如果在安全模式里，请点下面按钮继续；否则重启后会自动继续。');
    }
  } catch (e) { }
}

window.addEventListener('DOMContentLoaded', boot);
