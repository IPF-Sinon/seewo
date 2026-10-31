'use strict';
const T = window.__TAURI__ || {};
const invoke = (T.core && T.core.invoke) || T.invoke;
const dlg = T.dialog || null;
const evt = T.event || null;
const $ = (id) => document.getElementById(id);

let STATE = null;
let toastTimer = null;

function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast'; }, 3000);
}
function showModal(title, body) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  $('modal').classList.remove('hidden');
}
async function call(cmd, args) {
  return await invoke(cmd, args || {});
}
async function tryCall(cmd, args) {
  try { return await call(cmd, args); }
  catch (e) { toast(typeof e === 'string' ? e : (e && e.message) || '操作失败', 'err'); return null; }
}
async function pickFile(filters) {
  if (!dlg) { toast('文件对话框不可用', 'err'); return null; }
  try {
    const p = await dlg.open({ multiple: false, directory: false, filters: filters });
    if (!p) return null;
    return typeof p === 'string' ? p : (Array.isArray(p) ? p[0] : null);
  } catch (e) { toast('打开对话框失败', 'err'); return null; }
}
function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
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
    image: '用自己的图片替换集控下发的屏保图。转场数量要与图片数一致，留空表示随机。',
    web: '用网页或本地视频当屏保。此模式下显示参数不生效（由网页自己决定）。',
    none: '不修改图片，只调整显示参数 —— 最安全的一种。'
  };
  $('modeHint').textContent = hints[m] || '';
  const web = (m === 'web');
  $('numInterval').disabled = web;
  document.querySelectorAll('input[name=fit]').forEach(function (r) { r.disabled = web; });
  $('txtTrans').disabled = web;
}

function renderState() {
  const s = STATE;
  if (!s) return;
  $('subtitle').textContent = (s.seewoDir ? '已找到希沃目录' : '未找到希沃目录') +
    (s.injected ? ' · 已注入' : ' · 未注入');

  const vb = $('versionBadge');
  if (s.injected && s.installedVersion) {
    const same = s.installedVersion === s.version;
    vb.textContent = same ? ('已是最新 v' + s.version) : ('注入版本 v' + s.installedVersion + ' → 当前 v' + s.version);
    vb.className = 'badge tiny ' + (same ? 'ok' : 'bad');
  } else {
    vb.textContent = 'v' + s.version;
    vb.className = 'badge tiny';
  }

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
    const dt = document.createElement('dt'); dt.textContent = r[0];
    const dd = document.createElement('dd'); dd.textContent = r[1];
    if (r[2]) dd.className = r[2];
    grid.appendChild(dt); grid.appendChild(dd);
  });
  $('adminHint').textContent = s.isAdmin ? '' :
    '当前不是管理员：注入 / 卸载 / 安全模式都会失败，请右键「以管理员身份运行」。';
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
    mode = web.enabled ? 'web'
      : ((cfg.override && cfg.override.imageList && cfg.override.imageList.length) ? 'image' : 'none');
  }
  const mr = document.querySelector('input[name=mode][value=' + mode + ']');
  if (mr) mr.checked = true;

  const ov = cfg.override || {};
  $('txtSource').value = ov.materialSource || '';
  $('txtImages').value = (ov.imageList || []).join('\n');
  $('txtTexts').value = ((ov.textList || []).map(function (t) { return (t && t.content) || ''; })).join('\n');
  $('numInterval').value = ov.switchInterval || 5;
  const fr = document.querySelector('input[name=fit][value="' + (ov.pictureSizeType === 1 ? '1' : '0') + '"]');
  if (fr) fr.checked = true;
  $('txtTrans').value = (ov.screensaverTransitionList || []).join(',');

  applyModeUI();
  document.querySelectorAll('button').forEach(function (b) {
    if (b.id && b.id !== 'modalClose') b.disabled = false;
  });
}

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

  const imgs = $('txtImages').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  const texts = $('txtTexts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  const trans = $('txtTrans').value.split(/[,\uff0c\s]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; })
    .map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return !isNaN(x) && x >= 0 && x <= 6; });

  if (mode === 'image') {
    if (imgs.length === 0) throw new Error('自定义图集模式至少要填一张图片');
    if (trans.length > 0 && trans.length !== imgs.length) {
      throw new Error('转场有 ' + trans.length + ' 个，图片有 ' + imgs.length + ' 张 —— 数量必须一致，或留空表示随机');
    }
  }
  if (mode === 'web' && !web.url) throw new Error('网页/视频模式需要填地址或选择文件');

  base.override = {
    materialSource: $('txtSource').value.trim(),
    imageList: imgs,
    textList: texts.map(function (t) { return { content: t }; }),
    switchInterval: Math.max(1, parseInt($('numInterval').value, 10) || 5),
    pictureSizeType: ((document.querySelector('input[name=fit]:checked') || {}).value === '1') ? 1 : 0,
    screensaverTransitionList: trans
  };
  return base;
}

async function save() {
  const cfg = collectConfig();
  await call('save_config', { config: cfg });
  STATE.config = cfg;
  return cfg;
}

// ---------------- 事件 ----------------

function bind() {
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', applyModeUI); });

  $('btnSave').addEventListener('click', async function () {
    try { await save(); toast('已保存，希沃下次进屏保时生效', 'ok'); }
    catch (e) { toast(e.message || '保存失败', 'err'); }
  });

  $('btnPreview').addEventListener('click', async function () {
    try { await save(); } catch (e) { toast(e.message || '配置有误', 'err'); return; }
    const r = await tryCall('send_command', { cmd: 'preview' });
    if (r) toast('已请求预览；没反应说明希沃管家没在运行', 'ok');
  });
  $('btnStop').addEventListener('click', async function () {
    const r = await tryCall('send_command', { cmd: 'stop' });
    if (r) toast('已请求停止预览', 'ok');
  });

  $('btnPatch').addEventListener('click', async function () {
    const r = await tryCall('patch_asar');
    if (r) { toast(r.message || (r.upgraded ? '已升级' : '注入完成'), r.already ? undefined : 'ok'); await refresh(); }
  });
  $('btnUnpatch').addEventListener('click', async function () {
    if (!confirm('确定还原成官方版本吗？自定义屏保会失效（图片配置仍保留）。')) return;
    const r = await tryCall('unpatch_asar');
    if (r) { toast(r.message || '已还原', 'ok'); await refresh(); }
  });
  $('btnDiag').addEventListener('click', async function () {
    const s = await tryCall('diagnostics');
    if (s) showModal('诊断信息', s);
  });

  $('btnSafeInstall').addEventListener('click', function () { safeFlow('install'); });
  $('btnSafeUninstall').addEventListener('click', function () { safeFlow('uninstall'); });

  $('btnCleanup').addEventListener('click', async function () {
    const r = await tryCall('cleanup_candidates');
    if (!r) return;
    if (!r.items || r.items.length === 0) { toast('没有可清理的垃圾文件', 'ok'); return; }
    const lines = r.items.map(function (i) { return '· ' + i.label + '   ' + fmtSize(i.size); }).join('\n');
    if (!confirm('将删除以下 ' + r.items.length + ' 项：\n\n' + lines + '\n\n继续吗？')) return;
    const res = await tryCall('do_cleanup', { paths: r.items.map(function (i) { return i.path; }) });
    if (res) toast('已清理 ' + res.removed + ' 项' + ((res.failed && res.failed.length) ? ('，' + res.failed.length + ' 项失败') : ''), 'ok');
  });

  $('btnKernel').addEventListener('click', async function () {
    if (!confirm('将下载 Electron 新内核（约 151MB，解压后约 250MB）。\n\n' +
      '用途：这是一个由本程序控制的浏览器内核，窗口属于我们，' +
      '所以能注入「退出屏保」按钮、能接管 ESC —— 内置内核太旧打不开的网站，用它就能正常打开且随时退得出。\n\n' +
      '下载源：GitHub 直连，失败自动走 gh-proxy 代理。后台进行，界面不卡。\n\n继续吗？')) return;
    const r = await tryCall('download_kernel');
    if (r) { toast(r.message || '已开始下载', 'ok'); }
  });

  $('btnPickFile').addEventListener('click', async function () {
    const p = await pickFile([
      { name: '网页或视频', extensions: ['html', 'htm', 'xhtml', 'mht', 'mhtml', 'svg', 'mp4', 'webm', 'ogv', 'mov', 'm4v'] },
      { name: '网页', extensions: ['html', 'htm', 'xhtml', 'mht', 'mhtml'] },
      { name: '视频', extensions: ['mp4', 'webm', 'ogv', 'mov', 'm4v'] },
      { name: '所有文件', extensions: ['*'] }
    ]);
    if (p) $('txtUrl').value = p;
  });
  $('btnPickBrowser').addEventListener('click', async function () {
    const p = await pickFile([{ name: '浏览器程序', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]);
    if (p) $('txtBrowserPath').value = p;
  });

  $('btnOpenDefaultDir').addEventListener('click', function () { tryCall('open_path', { which: 'defaultImages' }); });
  $('btnViewDefault').addEventListener('click', async function () {
    const r = await tryCall('list_default_images');
    if (!r) return;
    const files = r.files || [];
    if (files.length === 0) {
      showModal('默认图片', '还没有默认图片。\n\n通常在你用希沃账号登录、集控下发过屏保图片之后才会有。');
      return;
    }
    const body = '目录：' + r.dir + '\n共 ' + files.length + ' 张\n\n' +
      files.slice(0, 80).map(function (f) { return f.name + '   ' + fmtSize(f.size); }).join('\n') +
      (files.length > 80 ? '\n… 还有 ' + (files.length - 80) + ' 张' : '');
    showModal('默认图片（' + files.length + ' 张）', body);
  });

  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('click', function () { tryCall('open_path', { which: b.getAttribute('data-open') }); });
  });

  $('modalClose').addEventListener('click', function () { $('modal').classList.add('hidden'); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
}

async function safeFlow(action) {
  const what = action === 'uninstall' ? '卸载还原' : '安装注入';
  const r = await tryCall('enter_safe_mode', { action: action });
  if (!r) return;
  if (r.ranNow) {
    toast(r.message || '已完成', 'ok');
    await refresh();
    return;
  }
  const go = confirm(r.message + '\n\n现在重启电脑吗？（建议先保存其它工作）');
  if (go) {
    await tryCall('open_path', { which: 'seewo' });
    toast('已安排好。重启后进入安全模式，再打开本程序会自动继续。', 'ok');
    alert('请手动重启电脑。\n\n进入安全模式后，双击本程序，它会自动完成' + what + '并重启回正常模式。');
  }
}

// ---------------- 启动 ----------------

async function refresh() {
  STATE = await call('get_state');
  renderState();
  try {
    const k = await call('kernel_info');
    const el = $('kernelStatus');
    el.textContent = k.ready ? ('新内核：v' + (k.version || '?') + ' 已就绪') : '新内核：未下载';
    el.className = 'badge tiny' + (k.ready ? ' ok' : '');
  } catch (e) { }
}

async function boot() {
  bind();
  if (!invoke) { $('subtitle').textContent = '后端未就绪'; return; }
  await refresh().catch(function () { $('subtitle').textContent = '读取状态失败'; });

  if (evt) {
    evt.listen('kernel-progress', function (e) {
      const p = e.payload || {};
      const wrap = $('kernelBarWrap');
      wrap.classList.remove('hidden');
      const bar = $('kernelBar');
      if (p.total > 0) {
        const pct = Math.min(100, Math.floor(p.downloaded * 100 / p.total));
        bar.style.width = pct + '%';
        $('kernelStatus').textContent = '新内核：下载中 ' + pct + '%（' + fmtSize(p.downloaded) + ' / ' + fmtSize(p.total) + '）';
      } else {
        bar.style.width = '100%';
        bar.style.opacity = '.45';
        $('kernelStatus').textContent = '新内核：下载中 ' + fmtSize(p.downloaded);
      }
    });
    evt.listen('kernel-done', function (e) {
      const p = e.payload || {};
      $('kernelBarWrap').classList.add('hidden');
      $('kernelBar').style.opacity = '';
      toast(p.message || (p.ok ? '完成' : '失败'), p.ok ? 'ok' : 'err');
      refresh();
    });
  }

  try {
    const p = await call('is_pending_safe_action');
    if (p && p.pending) {
      const go = confirm('检测到待办动作「' + p.action + '」。\n\n现在执行吗？（在安全模式里点「确定」即可完成，完成后会自动关闭安全模式）');
      if (go) {
        const r = await tryCall('run_pending_safe_action');
        if (r) { toast('已完成', 'ok'); await refresh(); }
      }
    }
  } catch (e) { }

  try {
    const u = await call('check_upgrade');
    if (u && u.needUpgrade) {
      toast('注入的是 v' + u.installed + '，当前 v' + u.current + ' —— 点「安装 / 升级注入」即可升级', 'err');
    }
  } catch (e) { }
}

window.addEventListener('DOMContentLoaded', boot);
