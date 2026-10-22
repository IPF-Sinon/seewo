/* =========================================================================
 * tools/gui/app.js —— 希沃屏保配置工具 前端逻辑
 *
 * 纯原生 JS（无框架、无 CDN）。既可在 http:// 下由 tools/gui/server.js 提供，
 * 也可直接双击 index.html 打开（此时 fetch 会失败，界面进入「离线」状态而不报错）。
 *
 * 后端契约（tools/gui/server.js，与 gui-backend 确认）：
 *   GET  /api/config            -> {ok, path, exists, source, config, schema:{defaults,defaultOverride,pictureSizeTypes,transitionMax}}
 *   POST /api/config            -> 成功 {ok:true,path,changed,config,warnings[]}
 *                                  失败 400 {ok:false,code:'E_CONFIG_INVALID',message,path}
 *   POST /api/config/reset      -> 同上（写回默认配置）
 *   GET  /api/status            -> {ok,asar:{injected,marker,path,target},modules,config:{path,exists,valid,error},log:{file,tail[]},port,pid}
 *   POST /api/preview           -> {ok:true,mode:'request',detail} 或 {ok:false,code:'E_PREVIEW_UNAVAILABLE',message,detail}
 *   GET  /api/log?lines=N       -> {ok,file,lines:[{n,text}],total}
 *   GET  /api/backups           -> {ok,file,backups:[{path,name,size,mtime,index}],backupCount}
 *
 * 错误定位：后端透传 src/config/schema.js 的 ConfigValidationError.path，
 * 形如 'override.switchInterval' / 'override.imageList[2]' / 'override.textList[1].content' /
 * 'override.transitionList[0]' / 'screensaverEnabled'；未知顶层字段为字段名本身；
 * 顶层不是对象时为空串。parsePath() + locateTarget() 负责映射到 DOM 并高亮。
 * ========================================================================= */
'use strict';

(function () {

  /* ===================== 常量 ===================== */

  var API = {
    config: '/api/config',
    configReset: '/api/config/reset',
    status: '/api/status',
    preview: '/api/preview',
    log: '/api/log',
    backups: '/api/backups'
  };

  var TRANSITION_MAX = 6;          // 转场编号值域上界（含），与 schema.TRANSITION_MAX 一致
  var DEFAULT_SWITCH_INTERVAL = 15;
  var DEFAULT_OVERALL_TIMEOUT = 8000;
  var PREVIEW_TIMEOUT = 15000;

  var LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

  /**
   * 本地兜底默认值（与 src/config/schema.js 的 DEFAULT_CONFIG / DEFAULT_OVERRIDE 逐字对齐）。
   * 仅在 GET /api/config 失败（后端未启动）时用于「离线可看」：界面能渲染并试算校验，
   * 但不允许保存。绝不把它当成真实生效配置展示给用户。
   */
  var FALLBACK_DEFAULTS = {
    screensaverEnabled: true,
    lockCascadeOnClose: false,
    allowManualClose: true,
    override: null,
    logLevel: 'info',
    backupCount: 3
  };

  var FALLBACK_DEFAULT_OVERRIDE = {
    materialSource: '希沃集控',
    switchInterval: DEFAULT_SWITCH_INTERVAL,
    pictureSizeType: 0,
    imageList: [],
    textList: [],
    transitionList: null
  };

  /* ===================== 状态 ===================== */

  var state = {
    view: null,             // 当前界面数据（软件真值，保存时由它构造 payload）
    defaults: null,         // 后端给的 DEFAULT_CONFIG
    defaultOverride: null,  // 后端给的 DEFAULT_OVERRIDE
    transitionsEnabled: false,
    dirty: false,
    online: false,
    busy: false,
    lastStatus: null
  };

  /* ===================== 小工具 ===================== */

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** 非空字符串（用于 imageList / textList[].content 这类「必填非空」判断） */
  function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
  }

  /** 去首尾空白后判断是否为空（界面里 cell 文本用） */
  function hasText(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    try {
      var d = new Date(ms);
      if (isNaN(d.getTime())) return '—';
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) { return '—'; }
  }

  function fmtSize(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ===================== 提示条 ===================== */

  var ALERT_ICON = { info: 'i', ok: '✓', warn: '!', err: '×' };

  function showAlert(level, title, msg, opts) {
    opts = opts || {};
    var box = $('alerts');
    if (!box) return null;
    var node = el('div', { class: 'alert alert--' + level, role: 'alert' }, [
      el('span', { class: 'alert__icon', text: ALERT_ICON[level] || 'i' }),
      el('div', { class: 'alert__body' }, [
        title ? el('div', { class: 'alert__title', text: title }) : null,
        msg ? el('div', { class: 'alert__msg', text: msg }) : null
      ]),
      el('button', {
        type: 'button', class: 'alert__close', title: '关闭', text: '×',
        onclick: function () { if (node.parentNode) node.parentNode.removeChild(node); }
      })
    ]);
    box.appendChild(node);

    // 自动消失：只对成功/信息类，错误与警告保留让用户看清
    if (opts.autoDismiss !== false && (level === 'ok' || level === 'info')) {
      var ms = opts.timeout || 4500;
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, ms);
    }
    return node;
  }

  function clearAlerts() {
    var box = $('alerts');
    if (box) box.innerHTML = '';
  }

  function setHint(text) {
    var n = $('actionHint');
    if (n) n.textContent = text;
  }

  /* ===================== HTTP ===================== */

  /**
   * 统一请求封装。永远返回 {ok, status, data} 或 {ok:false, status:0, data:{message}}，
   * 不抛异常，避免任何网络问题把界面搞崩。
   */
  function request(method, url, body, timeoutMs) {
    var opts = {
      method: method,
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    var timer = null;
    if (typeof AbortController === 'function') {
      var ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } },
        timeoutMs || DEFAULT_OVERALL_TIMEOUT);
    }

    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        var parseError = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { parseError = e; }
        }
        if (data === null) {
          return {
            ok: false, status: res.status,
            data: {
              message: parseError
                ? ('后端返回的不是 JSON（HTTP ' + res.status + '），可能静态资源被误当成接口。原文前 200 字：' + text.slice(0, 200))
                : ('后端返回空响应（HTTP ' + res.status + '）')
            }
          };
        }
        if (!res.ok || data.ok === false) {
          return { ok: false, status: res.status, data: data };
        }
        return { ok: true, status: res.status, data: data };
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      var isAbort = err && (err.name === 'AbortError');
      var offline = !state.online || (window.location && window.location.protocol === 'file:');
      var hint;
      if (isAbort) {
        hint = '请求超时（' + ((timeoutMs || DEFAULT_OVERALL_TIMEOUT) / 1000) + ' 秒无响应）。';
      } else if (offline) {
        hint = '未能连接后端服务。可能是直接双击打开的 index.html（file:// 协议下浏览器禁止请求本地接口）。' +
          '请改用启动脚本以 http://127.0.0.1:8899 打开本界面。';
      } else {
        hint = '未能连接后端服务：' + (err && err.message ? err.message : String(err));
      }
      return { ok: false, status: 0, data: { message: hint, offline: true } };
    });
  }

  /* ===================== 后端错误路径 -> DOM 定位 ===================== */

  /**
   * 解析 ConfigValidationError.path。
   *   'screensaverEnabled'                -> {top:'screensaverEnabled', over:false}
   *   'override.switchInterval'           -> {top:'switchInterval', over:true}
   *   'override.imageList[2]'             -> {top:'imageList', over:true, index:2, sub:null}
   *   'override.textList[1].content'      -> {top:'textList', over:true, index:1, sub:'content'}
   *   'override.transitionList[0]'        -> {top:'transitionList', over:true, index:0}
   *   'foo'（未知顶层字段）                -> {top:'foo', over:false, unknown:true}
   *   ''（顶层不是对象）                   -> {top:null, empty:true}
   */
  function parsePath(path) {
    if (typeof path !== 'string' || path === '') return { top: null, empty: true };
    var out = { raw: path, top: null, over: false, index: null, sub: null, unknown: false };
    var rest = path;
    if (rest.indexOf('override.') === 0) {
      out.over = true;
      rest = rest.slice('override.'.length);
    } else if (rest === 'override') {
      out.over = true;
      rest = '';
    }
    var m = /^([A-Za-z_$][\w$]*)\s*\[(\d+)\]\s*(?:\.([A-Za-z_$][\w$]*))?$/.exec(rest);
    if (m) {
      out.top = m[1];
      out.index = parseInt(m[2], 10);
      out.sub = m[3] || null;
      return out;
    }
    var m2 = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?$/.exec(rest);
    if (m2) {
      out.top = m2[1];
      out.sub = m2[2] || null;
      return out;
    }
    if (rest === '') { out.empty = true; return out; }
    out.unknown = true;
    out.top = rest;
    return out;
  }

  function clearFieldErrors() {
    var nodes = document.querySelectorAll('.is-invalid');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-invalid');
    var errs = document.querySelectorAll('.field__error');
    for (var j = 0; j < errs.length; j++) errs[j].textContent = '';
  }

  function markInvalid(node) {
    if (!node) return;
    node.classList.add('is-invalid');
    // 只闪一次，避免大量错误时整页闪烁
    if (!markInvalid._flashed) {
      markInvalid._flashed = true;
      node.classList.add('flash');
      setTimeout(function () { node.classList.remove('flash'); }, 1800);
    }
  }

  function setFieldError(key, message) {
    var t = document.querySelector('[data-error-for="' + key + '"]');
    if (t) t.textContent = message;
  }

  /**
   * 把后端的 {path, message} 精确落到对应输入框：高亮 + 就地错误文案 + 滚动可见 + 聚焦。
   * 返回是否成功定位（false 时调用方应退化为全局提示）。
   */
  function locateTarget(path, message) {
    var p = parsePath(path);
    var container = null;
    var input = null;

    if (p.empty) return { located: false, reason: '顶层结构错误，无字段路径' };

    if (p.over && !overrideOn()) {
      // 用户关掉了「启用自定义图集」，但 override 里仍有非法值：先把开关打开再定位
      var sw = $('overrideEnabled');
      if (sw && !sw.checked) {
        sw.checked = true;
        applyOverrideFieldsetState();
        markDirty();
      }
    }

    switch (p.top) {
      case 'screensaverEnabled':
        container = $('screensaverEnabled');
        setFieldError('screensaverEnabled', message);
        break;
      case 'lockCascadeOnClose':
        container = $('lockCascadeOnClose');
        setFieldError('lockCascadeOnClose', message);
        break;
      case 'allowManualClose':
        container = $('allowManualClose');
        setFieldError('allowManualClose', message);
        break;
      case 'logLevel':
        container = $('logLevel');
        setFieldError('logLevel', message);
        break;
      case 'backupCount':
        container = $('backupCount');
        setFieldError('backupCount', message);
        break;
      case 'materialSource':
        container = $('materialSource');
        setFieldError('materialSource', message);
        break;
      case 'switchInterval':
        container = $('switchInterval');
        setFieldError('switchInterval', message);
        break;
      case 'pictureSizeType':
        container = $('pictureSizeTypeGroup');
        setFieldError('pictureSizeType', message);
        break;
      case 'imageList': {
        var imgRows = document.querySelectorAll('#imageList .item');
        if (p.index !== null && imgRows[p.index]) {
          container = imgRows[p.index];
          input = container.querySelector('input');
        } else {
          container = $('sectionImages');
          input = imgRows.length ? null : $('btnAddImage');
        }
        setFieldError('imageList', message);
        break;
      }
      case 'textList': {
        var txtRows = document.querySelectorAll('#textList .item');
        if (p.index !== null && txtRows[p.index]) {
          container = txtRows[p.index];
          var sel = p.sub === 'provenance' ? '[data-sub="provenance"]' : (p.sub === 'content' ? '[data-sub="content"]' : null);
          input = sel ? container.querySelector(sel) : container.querySelector('[data-sub="content"]');
        } else {
          container = $('sectionTexts');
        }
        setFieldError('textList', message);
        break;
      }
      case 'transitionList': {
        var cells = document.querySelectorAll('#transitionList .transition-cell');
        if (p.index !== null && cells[p.index]) {
          container = cells[p.index];
          input = container.querySelector('input');
        } else {
          container = $('sectionTransitions');
        }
        setFieldError('transitionList', message);
        break;
      }
      case 'override':
        container = $('rowOverrideEnable');
        setFieldError('override', message);
        break;
      default:
        return { located: false, reason: '未知字段路径：' + path };
    }

    if (!container) return { located: false, reason: '找不到字段对应的界面元素：' + path };

    markInvalid(container);
    var focusTarget = input || (container.matches && container.matches('input, select, textarea') ? container : null);
    try {
      if (container.scrollIntoView) {
        container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (focusTarget && focusTarget.focus) focusTarget.focus();
      else if (container.focus && container.tabIndex >= 0) container.focus();
    } catch (e) { /* 聚焦失败不影响高亮 */ }

    return { located: true, path: path, node: container };
  }

  /* ===================== 视图 <-> 模型 ===================== */

  function overrideOn() {
    var sw = $('overrideEnabled');
    return !!(sw && sw.checked);
  }

  function applyOverrideFieldsetState() {
    var fs = $('overrideFields');
    if (!fs) return;
    var on = overrideOn();
    if (on) fs.removeAttribute('disabled');
    else fs.setAttribute('disabled', 'disabled');
  }

  /** 用配置对象填充界面（所有 DOM → 视图状态的入口只有这一个） */
  function fillForm(config) {
    var cfg = isPlainObject(config) ? config : {};

    $('screensaverEnabled').checked = cfg.screensaverEnabled !== false;
    $('lockCascadeOnClose').checked = cfg.lockCascadeOnClose === true;
    $('allowManualClose').checked = cfg.allowManualClose !== false;

    var level = LOG_LEVELS.indexOf(cfg.logLevel) >= 0 ? cfg.logLevel : 'info';
    $('logLevel').value = level;

    var bc = parseInt(cfg.backupCount, 10);
    $('backupCount').value = isFinite(bc) && bc > 0 ? String(bc) : '3';

    var ov = isPlainObject(cfg.override) ? cfg.override : null;
    $('overrideEnabled').checked = !!ov;
    applyOverrideFieldsetState();

    var src = ov || state.defaultOverride || FALLBACK_DEFAULT_OVERRIDE;
    $('materialSource').value = typeof src.materialSource === 'string' ? src.materialSource : '';
    var si = parseInt(src.switchInterval, 10);
    $('switchInterval').value = isFinite(si) && si > 0 ? String(si) : String(DEFAULT_SWITCH_INTERVAL);

    var ps = parseInt(src.pictureSizeType, 10);
    if (ps !== 0 && ps !== 1) ps = 0;
    var radios = document.getElementsByName('pictureSizeType');
    for (var i = 0; i < radios.length; i++) radios[i].checked = (parseInt(radios[i].value, 10) === ps);

    state.transitionsEnabled = !!(ov && Array.isArray(ov.transitionList) &&
      ov.transitionList.length === (Array.isArray(src.imageList) ? src.imageList.length : 0) &&
      ov.transitionList.length > 0);

    renderImageList(Array.isArray(src.imageList) ? src.imageList : []);
    renderTextList(Array.isArray(src.textList) ? src.textList : []);
    renderTransitionList(Array.isArray(ov && ov.transitionList) ? ov.transitionList : []);

    clearFieldErrors();
    setDirty(false);
  }

  /* ---------- 图片列表 ---------- */

  function collectImages() {
    var rows = document.querySelectorAll('#imageList .item');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var inp = rows[i].querySelector('input[data-sub="path"]');
      out.push(inp ? inp.value : '');
    }
    return out;
  }

  function renderImageList(values) {
    var ul = $('imageList');
    if (!ul) return;
    ul.innerHTML = '';
    for (var i = 0; i < values.length; i++) {
      ul.appendChild(imageRow(typeof values[i] === 'string' ? values[i] : '', i));
    }
    refreshListMeta();
  }

  function imageRow(value, index) {
    var input = el('input', {
      type: 'text', 'data-sub': 'path', value: value,
      placeholder: 'C:\\Users\\Public\\Pictures\\1.jpg',
      spellcheck: 'false', autocomplete: 'off',
      oninput: function () { markDirty(); refreshListMeta(); }
    });
    var item = el('li', { class: 'item', 'data-kind': 'image' }, [
      el('span', { class: 'item__idx', text: String(index + 1) }),
      el('div', { class: 'item__body' }, [input]),
      reorderHandle(function (dir) { moveImage(index, dir); }),
      el('button', {
        type: 'button', class: 'item__del', title: '删除这张图片', text: '×',
        onclick: function () { removeImage(index); }
      })
    ]);
    return item;
  }

  function reorderHandle(onMove) {
    return el('div', { class: 'item__handle' }, [
      el('button', {
        type: 'button', class: 'iconbtn', title: '上移', text: '▲',
        onclick: function () { onMove(-1); }
      }),
      el('button', {
        type: 'button', class: 'iconbtn', title: '下移', text: '▼',
        onclick: function () { onMove(1); }
      })
    ]);
  }

  function moveImage(index, dir) {
    var vals = collectImages();
    var next = index + dir;
    if (next < 0 || next >= vals.length) return;
    var tmp = vals[index]; vals[index] = vals[next]; vals[next] = tmp;
    renderImageList(vals);
    markDirty();
    // 转场与图片一一对应，重排后保持长度同步
    syncTransitionLength();
  }

  function removeImage(index) {
    var vals = collectImages();
    vals.splice(index, 1);
    renderImageList(vals);
    markDirty();
    syncTransitionLength();
  }

  function addImage() {
    var vals = collectImages();
    vals.push('');
    renderImageList(vals);
    markDirty();
    syncTransitionLength();
    var rows = document.querySelectorAll('#imageList .item input');
    if (rows.length) rows[rows.length - 1].focus();
  }

  /* ---------- 图文条目 ---------- */

  function collectTexts() {
    var rows = document.querySelectorAll('#textList .item');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].querySelector('[data-sub="content"]');
      var p = rows[i].querySelector('[data-sub="provenance"]');
      out.push({ content: c ? c.value : '', provenance: p ? p.value : '' });
    }
    return out;
  }

  function renderTextList(values) {
    var ul = $('textList');
    if (!ul) return;
    ul.innerHTML = '';
    for (var i = 0; i < values.length; i++) {
      var v = isPlainObject(values[i]) ? values[i] : {};
      ul.appendChild(textRow(
        typeof v.content === 'string' ? v.content : '',
        typeof v.provenance === 'string' ? v.provenance : '',
        i
      ));
    }
    refreshListMeta();
  }

  function textRow(content, provenance, index) {
    var item = el('li', { class: 'item', 'data-kind': 'text' }, [
      el('span', { class: 'item__idx', text: String(index + 1) }),
      el('div', { class: 'item__body item__body--row' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: '正文（必填）' }),
          el('input', {
            type: 'text', 'data-sub': 'content', value: content,
            placeholder: '例如：今日值日：张同学',
            oninput: function () { markDirty(); }
          })
        ]),
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: '出处（可选）' }),
          el('input', {
            type: 'text', 'data-sub': 'provenance', value: provenance,
            placeholder: '例如：班务',
            oninput: function () { markDirty(); }
          })
        ])
      ]),
      el('button', {
        type: 'button', class: 'item__del', title: '删除这条图文', text: '×',
        onclick: function () { removeText(index); }
      })
    ]);
    return item;
  }

  function removeText(index) {
    var vals = collectTexts();
    vals.splice(index, 1);
    renderTextList(vals);
    markDirty();
  }

  function addText() {
    var vals = collectTexts();
    vals.push({ content: '', provenance: '' });
    renderTextList(vals);
    markDirty();
    var rows = document.querySelectorAll('#textList .item [data-sub="content"]');
    if (rows.length) rows[rows.length - 1].focus();
  }

  /* ---------- 转场列表 ---------- */

  function collectTransitions() {
    var cells = document.querySelectorAll('#transitionList .transition-cell input');
    var out = [];
    for (var i = 0; i < cells.length; i++) out.push(cells[i].value);
    return out;
  }

  function renderTransitionList(values) {
    var grid = $('transitionList');
    if (!grid) return;
    grid.innerHTML = '';
    var count = values.length;
    for (var i = 0; i < count; i++) {
      var v = values[i];
      var input = el('input', {
        type: 'number', min: '0', max: String(TRANSITION_MAX), step: '1',
        value: (v === null || v === undefined || v === '') ? '' : String(v),
        title: '第 ' + (i + 1) + ' 张图片的转场编号（0..' + TRANSITION_MAX + '）',
        oninput: function () { markDirty(); }
      });
      grid.appendChild(el('div', { class: 'transition-cell' }, [
        el('span', { class: 'transition-cell__no', text: '#' + (i + 1) }),
        input
      ]));
    }
    refreshTransitionMeta();
  }

  /** 图片数变化后，让转场数组长度跟上（启用中且长度不足时补随机值，超长时截断） */
  function syncTransitionLength() {
    if (!state.transitionsEnabled) { refreshTransitionMeta(); return; }
    var need = collectImages().length;
    var vals = collectTransitions();
    if (vals.length === need) { refreshTransitionMeta(); return; }
    if (need === 0) { vals = []; }
    else if (vals.length > need) { vals = vals.slice(0, need); }
    else {
      while (vals.length < need) {
        vals.push(String(Math.floor(Math.random() * (TRANSITION_MAX + 1))));
      }
    }
    renderTransitionList(vals);
  }

  function setTransitionsEnabled(on) {
    state.transitionsEnabled = !!on;
    var e = $('btnTransitionEnable'), r = $('btnTransitionRandom');
    if (e) e.hidden = !!on;
    if (r) r.hidden = !on;
    var chip = $('transitionStateChip');
    if (chip) {
      chip.textContent = on ? '手动指定' : '未启用（随机）';
      chip.className = on ? 'chip chip--ok' : 'chip chip--warn';
    }
    if (on) {
      var need = collectImages().length;
      var vals = [];
      while (vals.length < need) vals.push(String(Math.floor(Math.random() * (TRANSITION_MAX + 1))));
      renderTransitionList(vals);
    } else {
      renderTransitionList([]);
    }
    refreshTransitionMeta();
    markDirty();
  }

  function fillTransitionsRandom() {
    if (!state.transitionsEnabled) setTransitionsEnabled(true);
    var need = collectImages().length;
    var vals = [];
    for (var i = 0; i < need; i++) vals.push(String(Math.floor(Math.random() * (TRANSITION_MAX + 1))));
    renderTransitionList(vals);
    markDirty();
  }

  function resetTransitionsZero() {
    if (!state.transitionsEnabled) setTransitionsEnabled(true);
    var need = collectImages().length;
    var vals = [];
    for (var i = 0; i < need; i++) vals.push('0');
    renderTransitionList(vals);
    markDirty();
  }

  /** 图片数与转场长度是否一致 —— 这是渲染器硬契约，提前在界面上说清楚 */
  function transitionsLengthMismatch() {
    if (!state.transitionsEnabled) return false;
    return collectTransitions().length !== collectImages().length;
  }

  /* ---------- 计数/提示刷新 ---------- */

  function refreshListMeta() {
    var nImg = collectImages().length;
    var nTxt = collectTexts().length;
    var cImg = $('imageCountChip'), cTxt = $('textCountChip');
    if (cImg) cImg.textContent = nImg + ' 张';
    if (cTxt) cTxt.textContent = nTxt + ' 条';
    var eImg = $('imageEmpty'), eTxt = $('textEmpty');
    if (eImg) eImg.hidden = nImg > 0;
    if (eTxt) eTxt.hidden = nTxt > 0;
    refreshTransitionMeta();
  }

  function refreshTransitionMeta() {
    var nImg = collectImages().length;
    var nc = $('transitionNeedCount');
    if (nc) nc.textContent = String(nImg);

    if (!state.transitionsEnabled) {
      var chipOff = $('transitionStateChip');
      if (chipOff) { chipOff.textContent = '未启用（随机）'; chipOff.className = 'chip chip--warn'; }
      var empt = $('transitionEmpty');
      if (empt) empt.hidden = false;
      return;
    }

    var vals = collectTransitions();
    var n = vals.length;
    var chip = $('transitionStateChip');
    var mismatched = n !== nImg;
    if (chip) {
      chip.textContent = mismatched
        ? ('长度 ' + n + '，应为 ' + nImg + ' ✗')
        : ('手动指定（' + n + ' 项）');
      chip.className = mismatched ? 'chip chip--warn' : 'chip chip--ok';
    }
    var e = $('transitionEmpty');
    if (e) e.hidden = n > 0;
  }

  /* ===================== 本地预检 ===================== */

  /**
   * 前端预检 —— 与 src/config/schema.js 的规则逐条对齐，尽早给出中文提示。
   * 返回 {items:[{path,message}], warnings:[string]}。
   * ★ 这只是「提前提示」，最终权威仍是后端校验，前端绝不代替后端放行。
   */
  function localValidate() {
    var items = [];
    var warnings = [];

    if (!hasText($('materialSource').value) && overrideOn()) {
      warnings.push('素材来源为空：屏保底部将不显示「素材来自 XXX」署名。');
    }

    var siRaw = $('switchInterval').value;
    if (overrideOn()) {
      var si = Number(siRaw);
      if (siRaw === '' || siRaw === null) {
        items.push({ path: 'override.switchInterval', message: '切换间隔不能为空，必须是正整数（秒）' });
      } else if (!isFinite(si) || Math.floor(si) !== si || si <= 0) {
        items.push({
          path: 'override.switchInterval',
          message: '切换间隔必须是正整数（秒，当前值：' + siRaw + '）。渲染器内部会 ×1000，小数会被后端拒绝而非截断'
        });
      }
    }

    if (overrideOn()) {
      var images = collectImages();
      var empties = [];
      for (var i = 0; i < images.length; i++) {
        if (!hasText(images[i])) empties.push(i + 1);
      }
      if (empties.length) {
        items.push({
          path: 'override.imageList[' + (empties[0] - 1) + ']',
          message: '第 ' + empties.join('、') + ' 张图片路径为空。图片路径必须是非空字符串，请填写或删除该行'
        });
      }

      var texts = collectTexts();
      for (var t = 0; t < texts.length; t++) {
        if (!hasText(texts[t].content)) {
          items.push({
            path: 'override.textList[' + t + '].content',
            message: '第 ' + (t + 1) + ' 条图文的正文为空，正文为必填项'
          });
          break; // 只报第一条，避免刷屏；用户修完再校验
        }
      }

      if (state.transitionsEnabled) {
        var vals = collectTransitions();
        if (vals.length !== images.length) {
          items.push({
            path: 'override.transitionList',
            message: '转场列表长度（' + vals.length + '）必须等于图片数量（' + images.length + '）。可点「按图片数对齐转场」自动修正'
          });
        } else {
          for (var k = 0; k < vals.length; k++) {
            var raw = vals[k];
            var num = Number(raw);
            if (raw === '' || !isFinite(num) || Math.floor(num) !== num || num < 0 || num > TRANSITION_MAX) {
              items.push({
                path: 'override.transitionList[' + k + ']',
                message: '第 ' + (k + 1) + ' 个转场编号非法，必须是 0..' + TRANSITION_MAX + ' 的整数（当前：' + raw + '）'
              });
              break;
            }
          }
        }
      }
    }

    var bc = Number($('backupCount').value);
    if (!isFinite(bc) || Math.floor(bc) !== bc || bc <= 0) {
      items.push({ path: 'backupCount', message: '备份份数必须是正整数（当前：' + $('backupCount').value + '）' });
    }

    return { items: items, warnings: warnings };
  }

  /* ===================== 构造提交载荷 ===================== */

  /** 由界面构造完整配置对象（顶层字段严格按后端契约，不自创字段） */
  function buildPayload() {
    var logLevel = $('logLevel').value;
    if (LOG_LEVELS.indexOf(logLevel) < 0) logLevel = 'info';

    var backupCount = parseInt($('backupCount').value, 10);
    if (!isFinite(backupCount) || backupCount <= 0) backupCount = 1;

    var override = null;
    if (overrideOn()) {
      var images = collectImages();
      var texts = collectTexts();
      override = {
        materialSource: $('materialSource').value,
        switchInterval: parseInt($('switchInterval').value, 10),
        pictureSizeType: parseInt(
          (document.querySelector('input[name="pictureSizeType"]:checked') || { value: '0' }).value, 10
        ),
        imageList: images.slice(),
        textList: texts.map(function (t) {
          var o = { content: t.content };
          if (t.provenance !== '') o.provenance = t.provenance;
          return o;
        }),
        transitionList: state.transitionsEnabled ? collectTransitions().map(function (v) {
          return Number(v);
        }) : null
      };
    }

    return {
      screensaverEnabled: !!$('screensaverEnabled').checked,
      lockCascadeOnClose: !!$('lockCascadeOnClose').checked,
      allowManualClose: !!$('allowManualClose').checked,
      logLevel: logLevel,
      backupCount: backupCount,
      override: override
    };
  }

  /* ===================== 脏标记 ===================== */

  function setDirty(dirty) {
    state.dirty = !!dirty;
    var pill = $('statusPillDirty'), txt = $('txtDirty');
    if (pill) pill.setAttribute('data-state', dirty ? 'dirty' : 'clean');
    if (txt) txt.textContent = dirty ? '有未保存改动' : '已同步';
    var save = $('btnSave');
    if (save) save.classList.toggle('btn--primary', true);
    if (!dirty) setHint(state.online ? '已与后端同步' : '离线预览（未连接后端）');
  }

  function markDirty() {
    if (!state.dirty) setDirty(true);
    refreshTransitionMeta();
  }

  /* ===================== 状态条刷新 ===================== */

  function pill(id, textId, stateName, text) {
    var p = $(id), t = $(textId);
    if (p) p.setAttribute('data-state', stateName);
    if (t) t.textContent = text;
  }

  function refreshStatusBar(status) {
    state.lastStatus = status;
    if (!status) {
      pill('statusPillInjected', 'txtInjected', 'err', '未连接');
      pill('statusPillEffective', 'txtEffective', 'err', '未知');
      pill('statusPillSwitch', 'txtSwitch', 'off', $('screensaverEnabled').checked ? '已启用' : '已关闭');
      return;
    }

    // 注入状态：asar.injected 可能是 true / false / null（null = 未探测到 asar）
    var asar = status.asar || {};
    if (asar.injected === true) {
      pill('statusPillInjected', 'txtInjected', 'ok', '已注入');
    } else if (asar.injected === false) {
      pill('statusPillInjected', 'txtInjected', 'warn', '未注入');
    } else {
      pill('statusPillInjected', 'txtInjected', 'off', '未探测');
    }

    // 配置有效性
    var cfgInfo = status.config || {};
    if (cfgInfo.valid === true) {
      pill('statusPillEffective', 'txtEffective', 'ok', cfgInfo.exists ? '已生效' : '默认值');
    } else if (cfgInfo.valid === false) {
      pill('statusPillEffective', 'txtEffective', 'err', '校验失败');
    } else {
      pill('statusPillEffective', 'txtEffective', 'off', '未知');
    }

    // 屏保开关（以界面当前值为准，因为用户可能刚改还没保存）
    var on = $('screensaverEnabled').checked;
    pill('statusPillSwitch', 'txtSwitch', on ? 'ok' : 'off', on ? '已启用' : '已关闭');

    if (cfgInfo.path || status.configPath) {
      var pb = $('configPath');
      if (pb) pb.textContent = cfgInfo.path || status.configPath;
    }
  }

  function askStatus() {
    return request('GET', API.status).then(function (r) {
      if (r.ok) {
        state.online = true;
        refreshStatusBar(r.data);
        return r.data;
      }
      state.online = false;
      refreshStatusBar(null);
      return null;
    });
  }

  /* ===================== 载入配置 ===================== */

  function loadConfig(isInitial) {
    setHint('正在读取配置…');
    return request('GET', API.config).then(function (r) {
      if (!r.ok) {
        state.online = false;
        refreshStatusBar(null);
        if (isInitial) {
          // 离线兜底：用本地默认值渲染，界面可用但不允许保存
          state.defaults = clone(FALLBACK_DEFAULTS);
          state.defaultOverride = clone(FALLBACK_DEFAULT_OVERRIDE);
          fillForm(FALLBACK_DEFAULTS);
          refreshListMeta();
        }
        showAlert('warn', '未能读取配置', (r.data && r.data.message ? r.data.message : '未知错误') +
          (isInitial ? '\n\n界面已用内置默认值渲染，仅供查看；连接后端后才能保存。' : ''));
        setHint('离线预览（未连接后端）');
        return false;
      }

      state.online = true;
      var d = r.data;
      var sch = d.schema || {};
      state.defaults = isPlainObject(sch.defaults) ? sch.defaults : clone(FALLBACK_DEFAULTS);
      state.defaultOverride = isPlainObject(sch.defaultOverride) ? sch.defaultOverride : clone(FALLBACK_DEFAULT_OVERRIDE);
      if (typeof sch.transitionMax === 'number') TRANSITION_MAX = sch.transitionMax;

      fillForm(d.config || {});
      refreshStatusBar(null);

      var pb = $('configPath');
      if (pb && d.path) pb.textContent = d.path;

      if (isInitial) {
        var notes = ['已读取配置：' + (d.path || '(未知路径)')];
        if (d.source === 'defaults' || d.exists === false) {
          notes.push('配置文件尚不存在，当前显示的是默认值。保存后将创建该文件。');
        }
        showAlert('info', '配置已载入', notes.join('\n'), { timeout: 4000 });
      }
      setHint('已与后端同步');
      return true;
    });
  }

  /* ===================== 保存 ===================== */

  function save(focusOnError) {
    if (state.busy) return Promise.resolve(false);

    // 1) 本地预检：先给中文提示，避免无谓往返
    var pre = localValidate();
    if (pre.items.length) {
      clearFieldErrors();
      var locatedAll = true;
      for (var i = 0; i < pre.items.length; i++) {
        var res = locateTarget(pre.items[i].path, pre.items[i].message);
        if (!res.located) locatedAll = false;
      }
      showAlert('err', '保存前本地校验未通过（' + pre.items.length + ' 项）',
        pre.items.map(function (it) { return '· ' + it.message; }).join('\n') +
        '\n\n已尽量定位到对应输入框并高亮。修正后再保存。');
      setHint('本地校验未通过，未提交后端');
      return Promise.resolve(false);
    }

    state.busy = true;
    var btn = $('btnSave');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    setHint('正在保存…');

    var payload = buildPayload();

    return request('POST', API.config, payload).then(function (r) {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '保存配置'; }

      if (!r.ok) {
        var d = r.data || {};
        clearFieldErrors();
        var message = d.message || '保存失败（未知原因）';
        var pathInfo = d.path;

        // 后端 400 且带 path：精确高亮对应输入框
        if (d.code === 'E_CONFIG_INVALID' || typeof pathInfo === 'string') {
          var res = locateTarget(pathInfo, message);
          if (res.located) {
            showAlert('err', '保存失败：配置校验未通过',
              message + '\n\n字段位置：' + (pathInfo || '(顶层结构)') + '　已高亮对应输入框。');
            setHint('校验失败，已定位到：' + (pathInfo || '(顶层结构)'));
          } else {
            showAlert('err', '保存失败：配置校验未通过',
              message + '\n\n字段位置：' + (pathInfo === '' ? '(顶层结构错误)' : (pathInfo || '(未提供)')) +
              (res.reason ? '\n未能自动定位：' + res.reason : ''));
            setHint('校验失败（未能自动定位输入框）');
          }
        } else {
          showAlert('err', '保存失败', message);
          setHint('保存失败');
        }
        return false;
      }

      // 成功
      var ok = r.data || {};
      clearFieldErrors();
      var lines = ['配置文件：' + (ok.path || '(后端未返回路径)')];
      if (ok.changed === false) lines.push('内容与磁盘现值一致，未产生改动。');
      else lines.push('已写入，改动即时生效（无需重新注入）。');
      lines.push('提示：注入加载器在启动时读取配置，若要让新配置对当前运行中的希沃管家生效，请重启希沃管家。');

      if (Array.isArray(ok.warnings) && ok.warnings.length) {
        showAlert('warn', '已保存，但有 ' + ok.warnings.length + ' 条提示', ok.warnings.join('\n'));
      }
      showAlert('ok', '保存成功', lines.join('\n'), { timeout: 6000 });

      if (ok.config) fillForm(ok.config);
      else setDirty(false);

      setHint('已保存到 ' + (ok.path || '配置文件'));
      askStatus();
      return true;
    });
  }

  /* ===================== 恢复默认 ===================== */

  function resetDefaults() {
    if (state.busy) return;
    if (!state.online) {
      showAlert('warn', '未连接后端', '离线状态下不能恢复默认。请先连接后端服务。');
      return;
    }
    var sure = window.confirm(
      '确定恢复默认配置吗？\n\n' +
      '这会把屏保开关等所有配置改回出厂默认值，并写入配置文件。\n' +
      '（原配置会按「备份份数」滚动保留，可在「备份列表」中查看。）'
    );
    if (!sure) return;

    state.busy = true;
    var btn = $('btnReset');
    if (btn) { btn.disabled = true; btn.textContent = '恢复中…'; }
    setHint('正在恢复默认配置…');

    request('POST', API.configReset, null).then(function (r) {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '恢复默认'; }

      if (r.ok) {
        clearFieldErrors();
        var d = r.data || {};
        if (d.config) fillForm(d.config);
        else loadConfig(false);
        showAlert('ok', '已恢复默认配置', '配置文件：' + (d.path || '(未返回)') +
          '\n新的默认值已写回界面，如需保存为其他值请直接修改后点保存。', { timeout: 6000 });
        setHint('已恢复默认配置');
        askStatus();
      } else {
        var dd = r.data || {};
        showAlert('err', '恢复默认失败', dd.message || '后端未返回原因');
        setHint('恢复默认失败');
      }
    });
  }

  /* ===================== 预览 ===================== */

  function preview() {
    if (state.busy) return;
    var btn = $('btnPreview');
    if (btn) btn.disabled = true;
    setHint('正在请求唤起屏保…');

    request('POST', API.preview, {}, PREVIEW_TIMEOUT).then(function (r) {
      if (btn) btn.disabled = false;

      if (r.ok) {
        var d = r.data || {};
        var detail = d.detail || '后端已接受预览请求。';
        if (d.mode === 'unavailable') {
          showAlert('warn', '预览未能真正执行', detail);
          setHint('预览请求已发出，但当前环境无法真正唤起屏保');
        } else if (d.mode === 'bridge') {
          // 注入层真实响应了 —— 这是唯一「确实已唤起」的成功状态
          var src = d.source === 'override' ? '当前配置'
            : (d.source === 'last-payload' ? '最近一次集控下发' : (d.source || '注入层'));
          var n = (typeof d.imageCount === 'number') ? d.imageCount : null;
          showAlert('ok', '屏保已唤起',
            '来源：' + src + (n !== null ? '\n图片数量：' + n + ' 张' : '')
            + '\n\n手动预览会绕过「启用屏保」开关 —— 即使屏保已关闭，也能预览配置效果。'
            + '\n若屏幕没有反应，请检查希沃管家是否正在运行，以及顶部注入状态是否为「已注入」。',
            { timeout: 8000 });
          setHint('屏保已唤起（' + src + '）');
        } else {
          showAlert('ok', '已送出预览请求', detail, { timeout: 6000 });
          setHint('已送出预览请求');
        }
        return;
      }

      var dd = r.data || {};
      var parts = [];
      if (dd.message) parts.push(dd.message);
      if (dd.detail) parts.push(dd.detail);
      if (!parts.length) parts.push('后端返回失败，但未提供原因。');

      var tip = '\n\n排查建议：\n' +
        '1) 顶部「注入状态」为「已注入」——预览依赖注入到管家主进程的加载器；\n' +
        '2) 希沃管家正在运行（管家退出时加载器不在，命令无人消费）；\n' +
        '3) 配置里至少有一张图片，或已收到过集控下发的屏保数据；\n' +
        '4) 查看日志了解注入层实际拦截与命令执行情况。';
      showAlert('warn', '预览未能执行' + (dd.code ? '（' + dd.code + '）' : ''), parts.join('\n') + tip);
      setHint('预览失败：' + (dd.code || '未知原因'));
    });
  }

  /* ===================== 日志 / 备份 ===================== */

  function openLog() {
    var drawer = $('logDrawer');
    if (!drawer) return;
    drawer.hidden = false;
    loadLog();
  }

  function closeLog() {
    var d = $('logDrawer');
    if (d) d.hidden = true;
  }

  function loadLog() {
    var lines = ($('logLines') && $('logLines').value) || '300';
    var body = $('logBody'), pathEl = $('logPath');
    if (body) body.textContent = '加载中…';

    request('GET', API.log + '?lines=' + encodeURIComponent(lines)).then(function (r) {
      if (!r.ok) {
        if (body) body.textContent = (r.data && r.data.message) || '读取日志失败';
        return;
      }
      var d = r.data || {};
      if (pathEl) pathEl.textContent = d.file || '(后端未返回日志路径)';
      var arr = Array.isArray(d.lines) ? d.lines : [];
      if (!arr.length) {
        if (body) body.textContent = '（日志为空。若刚安装，请先重启一次希沃管家以产生日志。）';
        return;
      }
      var text = arr.map(function (x) {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') return (x.n !== undefined ? String(x.n).padStart(5, ' ') + ' | ' : '') + (x.text || '');
        return String(x);
      }).join('\n');
      if (body) body.textContent = text;
    });
  }

  function openBackups() {
    var drawer = $('backupDrawer');
    if (!drawer) return;
    drawer.hidden = false;
    loadBackups();
  }

  function closeBackups() {
    var d = $('backupDrawer');
    if (d) d.hidden = true;
  }

  function loadBackups() {
    var body = $('backupBody'), pathEl = $('backupPath');
    if (body) body.textContent = '加载中…';

    request('GET', API.backups).then(function (r) {
      if (!r.ok) {
        if (body) body.textContent = (r.data && r.data.message) || '读取备份列表失败';
        return;
      }
      var d = r.data || {};
      if (pathEl) pathEl.textContent = d.file || '(后端未返回配置文件路径)';
      var list = Array.isArray(d.backups) ? d.backups : [];
      if (!list.length) {
        if (body) body.textContent = '（暂无备份。每次成功保存后会自动滚动生成备份。）';
        return;
      }
      body.innerHTML = '';
      for (var i = 0; i < list.length; i++) {
        var b = list[i] || {};
        body.appendChild(el('div', { class: 'backup-item' }, [
          el('span', { class: 'backup-item__name', text: b.name || b.path || '(未命名)' }),
          el('span', { class: 'backup-item__meta', text: fmtTime(b.mtime) + '　' + fmtSize(b.size) })
        ]));
      }
      if (typeof d.backupCount === 'number') {
        body.appendChild(el('div', { class: 'backup-empty', text: '滚动保留份数：' + d.backupCount }));
      }
    });
  }

  /* ===================== 事件绑定 ===================== */

  function bind() {
    // 顶部
    $('btnRefresh').addEventListener('click', function () {
      if (state.dirty && !window.confirm('界面有未保存的改动，刷新会丢弃它们。确定继续吗？')) return;
      clearAlerts();
      loadConfig(false).then(function () { askStatus(); });
    });

    // 主开关
    $('screensaverEnabled').addEventListener('change', function () {
      markDirty();
      refreshStatusBar(state.lastStatus);
      setHint(this.checked ? '已启用屏保（记得点保存）' : '已关闭屏保（记得点保存）');
    });
    $('lockCascadeOnClose').addEventListener('change', markDirty);
    $('btnPreview').addEventListener('click', preview);

    // 自定义图集总开关
    $('overrideEnabled').addEventListener('change', function () {
      applyOverrideFieldsetState();
      if (this.checked) {
        // 从「无 override」切到「有 override」：用默认 override 补全空表单，避免提交全是空值
        var imgCount = collectImages().length;
        if (!$('materialSource').value && state.defaultOverride) {
          $('materialSource').value = state.defaultOverride.materialSource || '';
        }
        if (!$('switchInterval').value) {
          $('switchInterval').value = String(state.defaultOverride.switchInterval || DEFAULT_SWITCH_INTERVAL);
        }
        if (imgCount === 0) renderImageList([]);
      }
      markDirty();
      refreshListMeta();
    });

    $('materialSource').addEventListener('input', markDirty);
    $('switchInterval').addEventListener('input', markDirty);
    $('logLevel').addEventListener('change', markDirty);
    $('backupCount').addEventListener('input', markDirty);
    $('allowManualClose').addEventListener('change', markDirty);

    var radios = document.getElementsByName('pictureSizeType');
    for (var i = 0; i < radios.length; i++) radios[i].addEventListener('change', markDirty);

    // 列表操作
    $('btnAddImage').addEventListener('click', addImage);
    $('btnAddText').addEventListener('click', addText);
    $('btnImageTransition').addEventListener('click', function () {
      if (!state.transitionsEnabled) {
        setTransitionsEnabled(true);
        showAlert('info', '已启用自定义转场', '转场列表长度已按当前图片数（' + collectImages().length + '）自动对齐。', { timeout: 4000 });
      } else {
        syncTransitionLength();
        setHint('已按图片数对齐转场长度');
      }
      refreshTransitionMeta();
    });

    $('btnTransitionEnable').addEventListener('click', function () { setTransitionsEnabled(true); });
    $('btnTransitionRandom').addEventListener('click', function () { setTransitionsEnabled(false); });
    $('btnTransitionFill').addEventListener('click', fillTransitionsRandom);
    $('btnTransitionReset').addEventListener('click', resetTransitionsZero);

    // 高级选项折叠
    $('btnAdvToggle').addEventListener('click', function () {
      var expanded = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      $('advBody').hidden = expanded;
    });

    // 底部
    $('btnSave').addEventListener('click', function () { save(true); });
    $('btnReset').addEventListener('click', resetDefaults);
    $('btnLog').addEventListener('click', openLog);
    $('btnBackups').addEventListener('click', openBackups);

    // 日志抽屉
    $('btnLogClose').addEventListener('click', closeLog);
    $('btnLogReload').addEventListener('click', loadLog);
    $('logLines').addEventListener('change', loadLog);

    // 备份抽屉
    $('btnBackupClose').addEventListener('click', closeBackups);
    $('btnBackupReload').addEventListener('click', loadBackups);

    // 未保存离开提醒
    window.addEventListener('beforeunload', function (e) {
      if (!state.dirty) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });

    // 快捷键：Ctrl/Cmd + S 保存
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        save(true);
      }
    });
  }

  /* ===================== 启动 ===================== */

  function enableDemo() {
    // 仅用于本地无后端时的界面渲染（?demo=1），数据全部是内置常量，不是真实配置
    state.defaults = clone(FALLBACK_DEFAULTS);
    state.defaultOverride = clone(FALLBACK_DEFAULT_OVERRIDE);
    fillForm({
      screensaverEnabled: false,
      lockCascadeOnClose: false,
      allowManualClose: true,
      logLevel: 'info',
      backupCount: 3,
      override: {
        materialSource: '希沃集控',
        switchInterval: 30,
        pictureSizeType: 1,
        imageList: ['C:\\图片\\1.jpg', 'C:\\图片\\2.jpg'],
        textList: [{ content: '今日值日：张同学', provenance: '班务' }],
        transitionList: [0, 3]
      }
    });
    renderImageList(['C:\\图片\\1.jpg', 'C:\\图片\\2.jpg']);
    renderTextList([{ content: '今日值日：张同学', provenance: '班务' }]);
    state.transitionsEnabled = true;
    $('btnTransitionEnable').hidden = true;
    $('btnTransitionRandom').hidden = false;
    renderTransitionList([0, 3]);
    state.online = false;
    refreshStatusBar(null);
    showAlert('info', '演示模式', '这是 ?demo=1 的界面演示数据（非真实配置），只用于查看界面。', { autoDismiss: false });
    setHint('演示模式（无后端）');
  }

  function boot() {
    try {
      bind();
    } catch (e) {
      // 绑定失败也要让用户看到原因，绝不静默白屏
      showAlert('err', '界面初始化失败', (e && e.message ? e.message : String(e)));
      return;
    }

    var isDemo = /(?:\?|&)demo=1(?:&|$)/.test(window.location.search || '');
    if (isDemo) { enableDemo(); return; }

    // 先按默认值渲染一次，保证「双击打开也能看到完整界面」
    state.defaults = clone(FALLBACK_DEFAULTS);
    state.defaultOverride = clone(FALLBACK_DEFAULT_OVERRIDE);
    fillForm(FALLBACK_DEFAULTS);
    refreshStatusBar(null);
    setHint('正在连接后端…');

    loadConfig(true).then(function () {
      askStatus();
      var st = setInterval(function () {
        if (document.hidden) return;
        askStatus();
      }, 15000);
      window.addEventListener('beforeunload', function () { clearInterval(st); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
