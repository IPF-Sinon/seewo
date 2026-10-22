'use strict';
/**
 * tools/asar-lite.js —— 极简 asar 读写（无外部依赖）
 *
 * 为什么不直接用 @electron/asar：
 *   用户机器上不一定装有 node_modules；本工具要能在「只有 Node.js」的环境下直接跑。
 *   而 asar 格式本身非常简单，读写 main.js 只需以下能力：
 *     1) 解析 asar 头部（JSON 目录树 + 各文件 offset/size）
 *     2) 读出某个文件的内容
 *     3) 把「替换了某个文件的新目录树」重新打包
 *
 * asar 文件布局（Electron 官方格式）：
 *   [0..3]     UInt32LE  固定值 4（pickle 长度前缀）
 *   [4..7]     UInt32LE  headerPickleSize
 *   [8..11]    UInt32LE  headerSize + 4
 *   [12..15]   UInt32LE  headerStringSize
 *   [16..]     UTF-8 JSON header（长度 = headerStringSize）
 *   随后按 4 字节对齐到 dataOffset，之后是所有文件拼接的数据区
 *
 * 关键点：header 里每个 file 条目的 offset 是**相对数据区起点**的。
 * 重新打包时必须重算所有 offset（改变 main.js 大小会整体位移）。
 */

const fs = require('fs');
const path = require('path');

const ALIGN = 4;

/** 读取 UInt32LE */
function u32(buf, off) {
  return buf.readUInt32LE(off);
}

/**
 * 解析 asar 头部。
 * @param {string} asarPath
 * @returns {{header:object, headerSize:number, dataOffset:number, size:number}}
 */
function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);

    const headerPickleSize = u32(sizeBuf, 4);
    const headerStringSize = u32(sizeBuf, 12);

    // header JSON 紧跟在 16 字节之后
    const jsonBuf = Buffer.alloc(headerStringSize);
    fs.readSync(fd, jsonBuf, 0, headerStringSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));

    // 数据区起点：16 + headerStringSize，按 4 字节对齐
    let dataOffset = 16 + headerStringSize;
    dataOffset = Math.ceil(dataOffset / ALIGN) * ALIGN;

    const size = fs.statSync(asarPath).size;
    return { header, headerSize: headerPickleSize, dataOffset, size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 在 asar 内按路径取文件条目。
 * @param {object} header 头部根节点
 * @param {string} relPath 形如 "main.js" 或 "public/x.js"
 */
function getFileEntry(header, relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
  let node = header;
  for (const p of parts) {
    if (!node || !node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  return node && node.files ? null : node;
}

/** 取某个文件的 Buffer 内容 */
function readFileFromAsar(asarPath, relPath) {
  const { header, dataOffset } = readHeader(asarPath);
  const entry = getFileEntry(header, relPath);
  if (!entry) return null;
  const size = typeof entry.size === 'number' ? entry.size : 0;
  const offset = typeof entry.offset === 'number'
    ? Number(entry.offset)
    : Number(String(entry.offset).replace(/^"|"$/g, ''));
  if (!size) return Buffer.alloc(0);

  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, dataOffset + offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** 递归收集所有文件（返回 [{relPath, entry}]） */
function collectFiles(node, prefix, out) {
  out = out || [];
  prefix = prefix || '';
  if (!node || !node.files) return out;
  for (const name of Object.keys(node.files)) {
    const child = node.files[name];
    const rel = prefix ? prefix + '/' + name : name;
    if (child && child.files) collectFiles(child, rel, out);
    else out.push({ relPath: rel, entry: child });
  }
  return out;
}

/**
 * 用「替换/新增若干文件」的方式重新打包 asar。
 *
 * @param {string} srcAsar 源 asar
 * @param {string} dstAsar 目标 asar
 * @param {Object<string,Buffer|string|null>} replacements
 *        key 为 asar 内相对路径；value 为新内容（null 表示删除）
 * @param {object} [opts] { logger }
 * @returns {{written:number, bytes:number}}
 */
function repack(srcAsar, dstAsar, replacements, opts) {
  const log = (opts && opts.logger) || { info() {}, warn() {} };
  const { header, dataOffset } = readHeader(srcAsar);

  // 1) 建立「路径 -> 新内容」映射（先把所有原文件读进来）
  const files = collectFiles(header);
  /** @type {Map<string,Buffer>} */
  const contents = new Map();
  for (const f of files) {
    const buf = readFileFromAsar(srcAsar, f.relPath);
    contents.set(f.relPath, buf || Buffer.alloc(0));
  }

  // 2) 应用替换
  let written = 0;
  for (const key of Object.keys(replacements || {})) {
    const val = replacements[key];
    if (val === null) {
      contents.delete(key);
      log.info('删除文件: ' + key);
      continue;
    }
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
    contents.set(key, buf);
    written++;
    log.info('替换/新增文件: ' + key + ' (' + buf.length + ' bytes)');
  }

  // 3) 重建目录树 + 重算 offset
  const newHeader = JSON.parse(JSON.stringify(header));
  // 先清空所有文件的 size/offset，再逐个赋值
  function resetNode(node) {
    if (!node || !node.files) return;
    for (const name of Object.keys(node.files)) {
      const child = node.files[name];
      if (child && child.files) resetNode(child);
      else {
        delete child.size;
        delete child.offset;
        delete child.integrity;
      }
    }
  }
  resetNode(newHeader);

  function ensureDir(root, relPath) {
    const parts = relPath.split('/');
    parts.pop();
    let node = root;
    for (const p of parts) {
      if (!node.files[p]) node.files[p] = { files: {} };
      node = node.files[p];
    }
    return node;
  }

  // 按路径排序，保证确定性
  const keys = Array.from(contents.keys()).sort();
  let offset = 0;
  const ordered = [];
  for (const rel of keys) {
    const buf = contents.get(rel);
    const parent = ensureDir(newHeader, rel);
    const name = rel.split('/').pop();
    const entry = parent.files[name] || (parent.files[name] = {});
    entry.size = buf.length;
    entry.offset = String(offset);
    delete entry.files;
    delete entry.integrity;
    ordered.push({ rel, buf, offset });
    offset += buf.length;
  }

  // 4) 写出新 asar
  const headerJson = Buffer.from(JSON.stringify(newHeader), 'utf8');
  const headerStringSize = headerJson.length;

  // 构造 16 字节前缀。
  // ★ 字段关系是从真实 app.asar 实测反推的（不是猜的）：
  //   实测真实文件：f4=4984, f8=4980, f12=4974，jsonSize=4974
  //   => f12 = jsonSize
  //      f8  = jsonSize + 6
  //      f4  = jsonSize + 10
  //   并用「dataOffset + max(offset+size) === 文件总大小」验证通过。
  //   pickle 语义：外层 payload 大小 = 4(字符串长度字段) + jsonSize，再加 pickle 自带的 2 个 4 字节头。
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);                          // 固定值 4（约定）
  prefix.writeUInt32LE(headerStringSize + 10, 4);      // f4
  prefix.writeUInt32LE(headerStringSize + 6, 8);       // f8
  prefix.writeUInt32LE(headerStringSize, 12);          // f12 = json 长度

  let dataStart = 16 + headerStringSize;
  const padLen = (ALIGN - (dataStart % ALIGN)) % ALIGN;
  const padding = Buffer.alloc(padLen);

  const fd = fs.openSync(dstAsar, 'w');
  try {
    fs.writeSync(fd, prefix);
    fs.writeSync(fd, headerJson);
    if (padLen) fs.writeSync(fd, padding);
    for (const item of ordered) {
      fs.writeSync(fd, item.buf);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { written, bytes: fs.statSync(dstAsar).size, fileCount: ordered.length };
}

module.exports = {
  readHeader,
  getFileEntry,
  readFileFromAsar,
  collectFiles,
  repack,
};
