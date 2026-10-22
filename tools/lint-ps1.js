#!/usr/bin/env node
'use strict';
/*
 * lint-ps1.js —— 纯 Node 实现的 PowerShell/.bat 静态自查器（无外部依赖）
 *
 * 存在理由：本机（Linux 容器）没有 pwsh / powershell / dotnet / mono，
 * 无法调用 [System.Management.Automation.Language.Parser]::ParseFile 做真正的语法解析
 * （已实测 npm 上也没有可用的 PowerShell 解析器包）。
 * 因此本工具做的是「高危模式静态检查 + 定界符配对 + 注释/单引号剥离」。
 * 它**不能**证明脚本语法 100% 正确，只能抓出本任务已知的高危坑。
 *
 * 用法: node tools/lint-ps1.js <file.ps1|file.bat> [...]
 * 退出码: 0 无 ERROR；1 有 ERROR
 */

const fs = require('fs');

const findings = [];
function report(level, file, line, msg) { findings.push({ level: level, file: file, line: line, msg: msg }); }

/**
 * 把 PowerShell 源码里的「非代码区」抹成等长空白，保留换行：
 *  - 块注释 <# ... #>
 *  - 行注释 #...
 *  - 单引号字面量 '...'（内部 '' 为转义）
 *  - here-string @'...'@ 与 @"..."@
 * 双引号字符串**保留**，因为本任务要检查其中的配对情况。
 */
function strip(source) {
  const chars = source.split('');
  const n = source.length;
  let i = 0;
  /** 双引号出现位置（按顺序，成对判定用） */
  const dqIdx = [];
  /** 未闭合的引号字面量 */
  const unterminated = [];
  const wipe = (from, to) => {
    for (let k = from; k < to && k < n; k++) { if (chars[k] !== '\n') chars[k] = ' '; }
  };
  while (i < n) {
    const c = source[i];
    // 块注释 <# ... #>
    if (c === '<' && source[i + 1] === '#') {
      const end = source.indexOf('#>', i + 2);
      const stop = end === -1 ? n : end + 2;
      wipe(i, stop);
      i = stop;
      continue;
    }
    // 行注释
    if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      wipe(i, stop);
      i = stop;
      continue;
    }
    // here-string  @'...'@  /  @"..."@
    if (c === '@' && (source[i + 1] === "'" || source[i + 1] === '"')) {
      const term = source[i + 1] + '@';
      const end = source.indexOf(term, i + 2);
      const stop = end === -1 ? n : end + 2;
      wipe(i, stop);
      i = stop;
      continue;
    }
    // 单引号字面量（'' 表示一个单引号）；记录未闭合情况
    if (c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (source[j] === "'" && source[j + 1] === "'") { j += 2; continue; }
        if (source[j] === "'") { j++; closed = true; break; }
        if (source[j] === '\n') break; // 未闭合
        j++;
      }
      if (!closed) unterminated.push({ kind: '单引号', idx: i });
      wipe(i, j);
      i = j;
      continue;
    }
    // 双引号字符串：内容整体抹白（保留引号边界由 dqIdx 单独统计）。
    // 这样 "xxx (yyy) zzz" 里的括号不会被当成代码定界符。
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (source.charCodeAt(j) === 96) { j += 2; continue; }   // 反引号转义
        if (source[j] === '"' && source[j + 1] === '"') { j += 2; continue; }      // "" 表示一个双引号
        if (source[j] === '"') { closed = true; break; }
        if (source[j] === '\n') break; // PS 的双引号串可以跨行，但我们保守按未闭合处理
        j++;
      }
      if (!closed) unterminated.push({ kind: '双引号', idx: i });
      dqIdx.push(i);
      wipe(i + 1, closed ? j : j);
      i = closed ? j + 1 : j;
      continue;
    }
    i++;
  }
  return { code: chars.join(''), dqIdx: dqIdx, unterminated: unterminated };
}

function lineOf(source, idx) {
  let c = 1;
  const stop = Math.min(idx, source.length);
  for (let i = 0; i < stop; i++) if (source[i] === '\n') c++;
  return c;
}

function checkPs1(file) {
  const src = fs.readFileSync(file, 'utf8');
  const parsed = strip(src);
  const code = parsed.code;
  const dqIdx = parsed.dqIdx;

  // ---- H0: 未闭合的引号字面量 ----
  parsed.unterminated.forEach(function (u) {
    report('ERROR', file, lineOf(src, u.idx),
      '未闭合的' + u.kind + '字面量（该行内找不到收尾引号）');
  });

  // ---- H1: 双引号配对 ----
  if (dqIdx.length % 2 !== 0) {
    report('ERROR', file, lineOf(src, dqIdx[dqIdx.length - 1]),
      '双引号数量为奇数（' + dqIdx.length + ' 个），引号不配对');
  } else if (parsed.unterminated.length === 0) {
    report('INFO', file, 0, '引号配对 OK（双引号 ' + dqIdx.length + ' 个，偶数，且全部闭合）');
  }

  // ---- H2: 定界符配对（仅看剥离后仍留在代码区的符号） ----
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const opens = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (pairs[ch]) { stack.push({ ch: ch, line: lineOf(src, i) }); }
    else if (opens[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== opens[ch]) {
        report('ERROR', file, lineOf(src, i),
          '定界符不匹配：第 ' + lineOf(src, i) + ' 行遇到 "' + ch + '"，期望闭合 "' +
          (top ? pairs[top.ch] : '(无)') + '"' + (top ? '（第 ' + top.line + ' 行打开）' : ''));
      }
    }
  }
  if (stack.length) {
    stack.forEach(function (t) {
      report('ERROR', file, t.line, '定界符未闭合: "' + t.ch + '"');
    });
  } else {
    report('INFO', file, 0, '圆括号/方括号/花括号配对 OK');
  }

  // ---- H3: 裸 % （PS 中 % 是 ForEach-Object 别名；用户被 CMD 吃 % 坑过） ----
  const pctRe = /(?<!\\)%(?![\s\{%(])/g;
  let m;
  while ((m = pctRe.exec(code)) !== null) {
    const line = lineOf(src, m.index);
    const lineText = src.split(/\r?\n/)[line - 1] || '';
    // 排除合法用法: "% 变量" / "%{ 脚本块 }" / 注释（已剥离）
    report('WARN', file, line, '疑似裸 % （PS 里是 ForEach-Object 别名）: ' + lineText.trim());
  }

  // ---- H4: 参数块 ----
  if (/^\s*param\s*[\(\r\n]/m.test(code)) report('INFO', file, 0, 'param 块存在');
  else report('ERROR', file, 0, '未找到 param 块');

  // ---- H5: 常见笔误 ----
  if (/(-eq|Ne)\s*=\s*/.test(code)) report('WARN', file, 0, '出现 "=  =" 形式，疑似把 -eq 写成 =');

  // ---- H6: 危险外部命令名（粗筛，防止调用不存在的工具） ----
  const cmds = ['Install-Module', 'Set-ExecutionPolicy', 'Remove-Item -Recurse -Force'];
  cmds.forEach(function (c) {
    if (code.indexOf(c) !== -1) report('INFO', file, 0, '包含高影响命令: ' + c);
  });

  return findings;
}

function checkBat(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach(function (l, idx) {
    const ln = idx + 1;
    const t = l.trim();
    if (!t || t.startsWith('::') || t.startsWith('REM ') || t.startsWith('rem ')) return;

    if (/^powershell/i.test(t)) {
      const hasFile = /(^|\s)-File(\s|$)/i.test(t);
      const hasCommand = /(^|\s)-(Command|C|EncodedCommand|E)(\s|$)/i.test(t);
      if (hasCommand || !hasFile) {
        report('ERROR', file, ln, '.bat 中的 powershell 调用疑似【内联命令】，必须只用 -File: ' + t);
      } else {
        report('INFO', file, ln, 'ok：.bat 只做 -File 调用');
      }
    }
    // 续行符
    if (/\^\s*$/.test(l)) report('WARN', file, ln, '发现 ^ 续行符（CMD 会提前解析整行，正是历史故障根因）: ' + t);

    // % 的正确用法检查。
    // CMD 里 % 有三种合法形态：%VAR% / %~dp0 这类修饰符 / %% (转义成字面 %)。
    // 单纯数字数会误报，必须按形态识别。
    const pctTokens = t.match(/%%|%~[a-z0-9*]*|%[A-Za-z_][A-Za-z0-9_]*%|%[0-9]|%[^%\s]*%/gi) || [];
    const consumed = pctTokens.join('').length;
    const totalPct = (t.match(/%/g) || []).length;
    const tokensPct = (pctTokens.join('').match(/%/g) || []).length;
    if (tokensPct !== totalPct) {
      report('ERROR', file, ln,
        '存在无法识别的 % （共 ' + totalPct + ' 个，只有 ' + tokensPct + ' 个能构成合法 %VAR% / %~dp0 / %% 记法）；' +
        'CMD 会吃掉半截字符串: ' + t);
    }
    // 行长里有 $ 变量语法 => 内联了 PowerShell
    if (/\$[A-Za-z_(\{]/.test(t) && !/^powershell/i.test(t)) {
      report('ERROR', file, ln, '.bat 中出现 PowerShell 变量语法 $ : ' + t);
    }
    // 反引号 / $() 子表达式 => 内联了 PowerShell
    if (/\$\(/.test(t) && !/^powershell/i.test(t)) {
      report('ERROR', file, ln, '.bat 中出现 PowerShell 子表达式 $( ): ' + t);
    }
    // 行内出现 $ ( ) 等 PS 特征
    if (/\$[A-Za-z_(]/.test(t) && !/^powershell/i.test(t)) {
      report('ERROR', file, ln, '.bat 中出现 PowerShell 变量语法 $ : ' + t);
    }
  });
  return findings;
}

const files = process.argv.slice(2);
if (!files.length) { console.error('用法: node tools/lint-ps1.js <file> [...]'); process.exit(2); }
files.forEach(function (f) {
  try {
    if (/\.bat$/i.test(f)) checkBat(f); else checkPs1(f);
  } catch (e) {
    report('ERROR', f, 0, '读取失败: ' + e.message);
  }
});

let errors = 0, warns = 0, infos = 0;
findings.forEach(function (fd) {
  const tag = fd.level === 'ERROR' ? '✗ ERROR' : (fd.level === 'WARN' ? '! WARN ' : '  ok   ');
  if (fd.level === 'ERROR') errors++;
  else if (fd.level === 'WARN') warns++;
  else infos++;
  console.log(tag + '  ' + fd.file + (fd.line ? ':' + fd.line : '') + '  ' + fd.msg);
});
console.log('\n合计: ERROR=' + errors + '  WARN=' + warns + '  INFO=' + infos);
process.exit(errors ? 1 : 0);
