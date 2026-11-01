'use strict';
const T = window.__TAURI__ || {};
const invoke = (T.core && T.core.invoke) || T.invoke;
const evt = T.event || null;
const $ = (id) => document.getElementById(id);

let STATE = null;
let LAST_MODE = 'none';     // 记住禁用前的实际模式，便于切回
let toastTimer = null;

function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'toast'; }, 3200);
}
function showModal(title, body) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  $('modal').classList.remove('hidden');
}
async function call(cmd, args) { return await invoke(cmd, args || {}); }
async function tryCall(cmd, args) {
  try { return await call(cmd, args); }
  catch (e) { toast(typeof e === 'string' ? e : (e && e.message) || '操作失败', 'err'); return null; }
}
async function pickFile(filter) {
  try {
    const r = await call('pick_file', { title: '选择文件', filter: filter });
    return r && r.path ? r.path : null;
  } catch (e) { toast('打开对话框失败，请直接粘贴完整路径', 'err'); return null; }
}
function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// ---------------- 模式 ----------------

function currentMode() {
  const r = document.querySelector('input[name=mode]:checked');
  return r ? r.value : 'none';
}

function applyModeUI() {
  const m = currentMode();
  $('paneDisabled').hidden = m !== 'disabled';
  $('paneImage').hidden = m !== 'image';
  $('paneWeb').hidden = m !== 'web';
  $('paneNone').hidden = m !== 'none';
  // 显示参数：只在「自定义图集 / 不修改图片」时有意义
  $('cardParams').hidden = (m === 'web' || m === 'disabled');

  const hints = {
    disabled: '屏保将被完全关闭，不再显示任何屏保。',
    image: '用自己的图片替换集控屏保图。转场数量要与图片数一致，留空表示随机。',
    web: '用网页或本地视频当屏保。此模式下没有显示参数（由网页自己决定）。',
    none: '不修改图片，只调整显示参数 —— 最安全的一种。'
  };
  $('modeHint').textContent = hints[m] || '';
}

// ---------------- 渲染 ----------------

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
  [
    ['希沃目录', s.seewoDir || '未找到'],
    ['app.asar', s.asarExists ? '存在' : '缺失'],
    ['备份 .bak', s.bakExists ? '存在' : '无'],
    ['注入状态', s.injected ? '已注入' : (s.injectionNote || '未注入'), s.injected ? 'ok' : 'bad'],
    ['管理员', s.isAdmin ? '是' : '否', s.isAdmin ? 'ok' : 'bad'],
    ['安全模式', s.safeMode ? '是' : '否']
  ].forEach(function (r) {
    const dt = document.createElement('dt'); dt.textContent = r[0];
    const dd = document.createElement('dd'); dd.textContent = r[1];
    if (r[2]) dd.className = r[2];
    grid.appendChild(dt); grid.appendChild(dd);
  });
  $('adminHint').textContent = s.isAdmin ? '' :
    '当前不是管理员：安装 / 卸载会失败，请右键「以管理员身份运行」。';
  $('adminHint').className = s.isAdmin ? 'hint' : 'hint warn';

  const cfg = s.config || {};
  const web = cfg.web || {};
  $('txtUrl').value = web.url || '';
  $('chkSysBrowser').checked = web.useSystemBrowser === true;
  $('chkBundled').checked = web.useBundledKernel === true;
  $('txtBrowserPath').value = web.browserPath || '';
  $('chkLock').checked = cfg.lockCascadeOnClose === true;

  // 计算实际模式（配置里 mode 只存 image/web/none；禁用靠 screensaverEnabled=false）
  let m = cfg.mode;
  if (m !== 'image' && m !== 'web' && m !== 'none') {
    m = web.enabled ? 'web'
      : ((cfg.override && cfg.override.imageList && cfg.override.imageList.length) ? 'image' : 'none');
  }
  LAST_MODE = m;
  const uiMode = (cfg.screensaverEnabled === false) ? 'disabled' : m;
  const mr = document.querySelector('input[name=mode][value=' + uiMode + ']');
  if (mr) mr.checked = true;

  const ov = cfg.override || {};
  $('txtSource').value = ov.materialSource || '';
  $('txtImages').value = (ov.imageList || []).join('\n');
  $('txtTexts').value = ((ov.textList || []).map(function (t) { return (t && t.content) || ''; })).join('\n');
  $('numInterval').value = ov.switchInterval || 5;
  const fr = document.querySelector('input[name=fit][value="' + (ov.pictureSizeType === 1 ? '1' : '0') + '"]');
  if (fr) fr.checked = true;
  $('txtTrans').value = (ov.transitionList || ov.screensaverTransitionList || []).join(',');

  applyModeUI();
  document.querySelectorAll('button').forEach(function (b) { if (b.id) b.disabled = false; });
}

function collectConfig() {
  const base = JSON.parse(JSON.stringify((STATE && STATE.config) || {}));
  const m = currentMode();
  const web = base.web || {};

  web.url = $('txtUrl').value.trim();
  web.useSystemBrowser = $('chkSysBrowser').checked;
  web.useBundledKernel = $('chkBundled').checked;
  web.browserPath = $('txtBrowserPath').value.trim();

  if (m === 'disabled') {
    base.screensaverEnabled = false;
    web.enabled = false;
    // 记住禁用前的真实模式，切回来时不丢选择
    base.mode = (LAST_MODE === 'image' || LAST_MODE === 'web' || LAST_MODE === 'none') ? LAST_MODE : 'none';
  } else {
    base.screensaverEnabled = true;
    base.mode = m;
    web.enabled = (m === 'web');
  }
  base.web = web;
  base.lockCascadeOnClose = $('chkLock').checked;

  const imgs = $('txtImages').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  const texts = $('txtTexts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  const trans = $('txtTrans').value.split(/[,\uff0c\s]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; })
    .map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return !isNaN(x) && x >= 0 && x <= 6; });

  if (m === 'image') {
    if (imgs.length === 0) throw new Error('自定义图集模式至少要填一张图片');
    if (trans.length > 0 && trans.length !== imgs.length) {
      throw new Error('转场有 ' + trans.length + ' 个，图片有 ' + imgs.length + ' 张 —— 必须一致，或留空表示随机');
    }
  }
  if (m === 'web' && !web.url) throw new Error('网页/视频模式需要填地址或选择文件');

  base.override = {
    materialSource: $('txtSource').value.trim(),
    imageList: imgs,
    textList: texts.map(function (t) { return { content: t }; }),
    switchInterval: Math.max(1, parseInt($('numInterval').value, 10) || 5),
    pictureSizeType: ((document.querySelector('input[name=fit]:checked') || {}).value === '1') ? 1 : 0,
    transitionList: trans
  };
  return base;
}

async function save() {
  const cfg = collectConfig();
  await call('save_config', { config: cfg });
  STATE.config = cfg;
  return cfg;
}

// ---------------- 图片预览 ----------------

const imgCache = {};

async function openImageModal(title, items, dirPath) {
  $('imgTitle').textContent = title + '（' + items.length + ' 张）';
  const list = $('imgList');
  list.innerHTML = '';
  const view = $('imgView');
  view.removeAttribute('src');
  const wrap = view.parentElement;
  wrap.innerHTML = '<img id="imgView" alt="" /><div class="empty">点左侧选择一张查看</div>';
  const w = wrap.querySelector('.empty');

  const openDirBtn = $('imgOpenDir');
  if (dirPath) {
    openDirBtn.classList.remove('hidden');
    openDirBtn.onclick = function () { tryCall('open_path', { which: 'defaultImages' }); };
  } else {
    openDirBtn.classList.add('hidden');
  }

  let activeEl = null;
  items.forEach(function (it, idx) {
    const el = document.createElement('div');
    el.className = 'img-item';
    const nm = document.createElement('span');
    nm.textContent = it.label;
    el.appendChild(nm);
    if (it.size) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = fmtSize(it.size);
      el.appendChild(sz);
    }
    el.addEventListener('click', async function () {
      if (activeEl) activeEl.classList.remove('active');
      el.classList.add('active');
      activeEl = el;
      const img = wrap.querySelector('img');
      const empty = wrap.querySelector('.empty');
      if (empty) empty.remove();
      if (imgCache[it.path]) { img.src = imgCache[it.path]; return; }
      img.removeAttribute('src');
      let d = null;
      try { d = await call('image_data_url', { path: it.path }); }
      catch (e) { d = null; }
      if (d && d.dataUrl) {
        imgCache[it.path] = d.dataUrl;
        img.src = d.dataUrl;
      } else {
        wrap.innerHTML = '<div class="empty">无法预览：' + (it.path || '') + '</div>';
      }
    });
    list.appendChild(el);
    if (idx === 0) el.click();
  });

  $('imgModal').classList.remove('hidden');
}

// ---------------- 复选列表（清理） ----------------

function openListModal(title, items, okText, onConfirm) {
  $('listTitle').textContent = title;
  const box = $('listBox');
  box.innerHTML = '';
  items.forEach(function (it) {
    const row = document.createElement('label');
    row.className = 'list-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.checked !== false;
    cb.value = it.value;
    const lb = document.createElement('span');
    lb.textContent = it.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = it.sub || '';
    row.appendChild(cb); row.appendChild(lb); row.appendChild(sub);
    box.appendChild(row);
  });
  const ok = $('listOk');
  ok.textContent = okText || '确定';
  ok.onclick = async function () {
    const chosen = Array.prototype.slice.call(box.querySelectorAll('input:checked')).map(function (c) { return c.value; });
    $('listModal').classList.add('hidden');
    await onConfirm(chosen);
  };
  $('listModal').classList.remove('hidden');
}

// ---------------- 事件 ----------------

async function cleanupFlow() {
  const r = await tryCall('cleanup_candidates');
  if (!r) return;
  const items = r.items || [];
  if (!items.length) { toast('没有可清理的垃圾文件', 'ok'); return; }
  openListModal('清理垃圾：勾选要删除的项目', items.map(function (i) {
    return { label: i.label, sub: fmtSize(i.size), value: i.path, checked: true };
  }), '删除选中', async function (chosen) {
    if (!chosen.length) { toast('没有选中任何项目', 'ok'); return; }
    const res = await tryCall('do_cleanup', { paths: chosen });
    if (res) {
      const bad = (res.failed && res.failed.length) || 0;
      toast('已清理 ' + res.removed + ' 项' + (bad ? ('，' + bad + ' 项失败') : ''), bad ? 'err' : 'ok');
    }
  });
}

function bind() {
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', applyModeUI); });

  $('btnSave').addEventListener('click', async function () {
    try {
      await save();
      try { await call('send_command', { cmd: 'reloadConfig' }); } catch (e2) { }
      toast('已保存并生效', 'ok');
    } catch (e) { toast(e.message || '保存失败', 'err'); }
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

  $('btnPatch').addEventListener('click', function () { safeFlow('install'); });
  $('btnUnpatch').addEventListener('click', function () {
    if (confirm('确定还原成官方版本吗？自定义屏保会失效（图片配置仍保留）。')) safeFlow('uninstall');
  });
  $('btnDiag').addEventListener('click', async function () {
    const s = await tryCall('diagnostics');
    if (s) showModal('诊断信息', s);
  });
  $('btnCleanup').addEventListener('click', cleanupFlow);

  $('btnKernel').addEventListener('click', async function () {
    if (!confirm('将下载 Electron 新内核（约 151MB，解压后约 250MB）。\n\n' +
      '用途：这是一个由本程序控制的浏览器内核，窗口属于我们，' +
      '所以能注入「退出屏保」按钮、能接管 ESC —— 内置内核太旧打不开的网站，用它就能正常打开且随时退得出。\n\n' +
      '下载源：GitHub 直连，失败自动走 gh-proxy 代理。后台进行，界面不卡。\n\n继续吗？')) return;
    const r = await tryCall('download_kernel');
    if (r) toast(r.message || '已开始下载', 'ok');
  });

  $('btnPickFile').addEventListener('click', async function () {
    const p = await pickFile('网页或视频|*.html;*.htm;*.xhtml;*.mht;*.mhtml;*.svg;*.mp4;*.webm;*.ogv;*.mov;*.m4v|所有文件|*.*');
    if (p) $('txtUrl').value = p;
  });
  $('btnPickBrowser').addEventListener('click', async function () {
    const p = await pickFile('浏览器程序|*.exe|所有文件|*.*');
    if (p) $('txtBrowserPath').value = p;
  });
  $('btnPickImages').addEventListener('click', async function () {
    const p = await pickFile('图片/动图|*.jpg;*.jpeg;*.png;*.bmp;*.gif;*.webp;*.avif|所有文件|*.*');
    if (p) {
      const cur = $('txtImages').value.trim();
      $('txtImages').value = cur ? (cur + '\n' + p) : p;
    }
  });
  $('btnPreviewImages').addEventListener('click', function () {
    const paths = $('txtImages').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!paths.length) { toast('还没有填图片路径', 'err'); return; }
    openImageModal('自定义图集', paths.map(function (p) { return { label: baseName(p), path: p }; }), null);
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
    openImageModal('默认图片', files.map(function (f) { return { label: f.name, path: f.path, size: f.size }; }), r.dir);
  });

  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('click', function () { tryCall('open_path', { which: b.getAttribute('data-open') }); });
  });

  $('modalClose').addEventListener('click', function () { $('modal').classList.add('hidden'); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
  $('imgClose').addEventListener('click', function () { $('imgModal').classList.add('hidden'); });
  $('imgModal').addEventListener('click', function (e) { if (e.target === $('imgModal')) $('imgModal').classList.add('hidden'); });
  $('listCancel').addEventListener('click', function () { $('listModal').classList.add('hidden'); });
  $('listModal').addEventListener('click', function (e) { if (e.target === $('listModal')) $('listModal').classList.add('hidden'); });
}

async function safeFlow(action) {
  const what = action === 'uninstall' ? '卸载还原' : '安装注入';
  const r = await tryCall('enter_safe_mode', { action: action });
  if (!r) return;
  if (r.ranNow) { toast(r.message || '已完成', 'ok'); await refresh(); return; }
  if (confirm(r.message + '\n\n现在重启电脑进入安全模式吗？（5 秒后重启，请先保存其它工作）')) {
    const rr = await tryCall('reboot');
    if (rr) toast('电脑将在 5 秒后重启。进入安全模式后再打开本程序会自动继续。', 'ok');
  }
}

// ---------------- 启动 ----------------

async function refresh() {
  STATE = await call('get_state');
  renderState();
  try {
    const b = await call('detect_browsers');
    const names = (b.browsers || []).map(function (x) { return x.name; });
    const bs = $('browserStatus');
    if (names.length) { bs.textContent = '浏览器：' + names.join(' / '); bs.className = 'badge tiny ok'; }
    else { bs.textContent = '浏览器：未找到 Edge/Chrome'; bs.className = 'badge tiny bad'; }
  } catch (e) { }
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
      $('kernelBarWrap').classList.remove('hidden');
      const bar = $('kernelBar');
      if (p.total > 0) {
        const pct = Math.min(100, Math.floor(p.downloaded * 100 / p.total));
        bar.style.width = pct + '%';
        $('kernelStatus').textContent = '新内核：下载中 ' + pct + '%（' + fmtSize(p.downloaded) + ' / ' + fmtSize(p.total) + '）';
      } else {
        bar.style.width = '100%'; bar.style.opacity = '.45';
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
      if (confirm('检测到待办动作「' + p.action + '」。\n\n现在执行吗？（完成后会自动关闭安全模式）')) {
        const r = await tryCall('run_pending_safe_action');
        if (r) { toast('已完成', 'ok'); await refresh(); }
      }
    }
  } catch (e) { }

  try {
    const u = await call('check_upgrade');
    if (u && u.needUpgrade) toast('注入的是 v' + u.installed + '，当前 v' + u.current + ' —— 点「安装 / 升级注入」升级', 'err');
  } catch (e) { }
}

window.addEventListener('DOMContentLoaded', boot);
