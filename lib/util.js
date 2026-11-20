// 通用小工具：哈希、体积格式化、文件遍历、清洗。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 计算文件的 SHA-256（小写 hex），流式读，不整文件进内存。 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 计算 Buffer 的 SHA-256。 */
export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 人类可读体积。 */
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
}

/** 人类可读耗时。 */
export function humanDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/**
 * 传输速率，如 "3.8 MB/s"。
 *
 * 用于上传/下载的进度文案：只看「第 k/N 卷」看不出快慢，
 * 有速率就能判断是正常在跑还是卡住了。
 *
 * @param bytes 已传字节
 * @param elapsedMs 已用毫秒
 */
export function formatRate(bytes, elapsedMs) {
  const n = Number(bytes) || 0;
  const ms = Number(elapsedMs) || 0;
  // 用时太短算不出有意义的速率（抖动大），直接给 '-'
  if (ms < 500 || n <= 0) return '-';
  const bytesPerSec = (n / ms) * 1000;
  return `${humanBytes(bytesPerSec)}/s`;
}

/**
 * 剩余时间估算，如 "约 1 分 30 秒"。
 *
 * @param doneBytes 已完成字节
 * @param totalBytes 总字节
 * @param elapsedMs 已用毫秒
 * @returns 字符串；无法估算时返回 ''（调用方据此省略这段文案）
 */
export function formatEta(doneBytes, totalBytes, elapsedMs) {
  const done = Number(doneBytes) || 0;
  const total = Number(totalBytes) || 0;
  const ms = Number(elapsedMs) || 0;
  if (done <= 0 || total <= 0 || ms < 500 || done >= total) return '';
  const bytesPerSec = (done / ms) * 1000;
  if (bytesPerSec <= 0) return '';
  const remainMs = ((total - done) / bytesPerSec) * 1000;
  // 超过 1 小时的估算意义不大，避免给出误导性的精确数字
  if (remainMs > 3600_000) return '超过 1 小时';
  return `约 ${humanDuration(remainMs)}`;
}

/**
 * 百分比（0-100 的整数），带分母保护。
 */
export function percentOf(done, total) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((d / t) * 100)));
}

/**
 * 项目名进主题前的显示净化（§3.1）。
 * 只影响显示，不影响头里的真实名字。
 */
export function sanitizeSubjectName(name) {
  return String(name || '')
    .replace(/\|/g, '｜')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 目录是不是盘符根（禁止当下载目标，§6）。 */
export function isDriveRoot(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (/^[A-Za-z]:\\?$/.test(resolved)) return true;
  const parsed = path.parse(resolved);
  return parsed.root === resolved;
}

/** 递归列出目录下所有文件（相对路径 + 字节数），软链接不跟随。 */
export function walkFiles(rootDir) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(rootDir, rel) : rootDir;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childAbs = path.join(rootDir, childRel);
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(childAbs).size;
        } catch {
          /* ignore */
        }
        out.push({ rel: childRel, abs: childAbs, bytes: size });
      }
    }
  }
  return out;
}

/** 目录统计：文件数与总字节。 */
export function dirStats(dir) {
  const files = walkFiles(dir);
  return {
    files: files.length,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}

/** 确保目录存在且可写；返回错误信息或 null。 */
export function checkWritableDir(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return '不是一个目录';
    fs.accessSync(dir, fs.constants.W_OK);
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return '目录不存在';
    if (err.code === 'EACCES' || err.code === 'EPERM') return '没有写入权限';
    return err.message;
  }
}

/** 随机 ID：SS-XXXXXX（大写字母数字，避免易混字符）。 */
export function randomVersionId() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i += 1) s += alphabet[bytes[i] % alphabet.length];
  return `SS-${s}`;
}

/** 机器 ID：MC-XXXXXX。 */
export function randomMachineId() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i += 1) s += alphabet[bytes[i] % alphabet.length];
  return `MC-${s}`;
}

/** 随机 nonce（锁用）。 */
export function randomNonce() {
  return crypto.randomBytes(8).toString('hex');
}

/** UTC 版本时间戳：20261119T152041 */
export function versionStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const se = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}T${h}${mi}${se}`;
}

/** 把版本时间戳还原成 Date（失败返回 null）。 */
export function parseVersionStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(String(stamp || ''));
  if (!m) return null;
  const [, y, mo, da, h, mi, se] = m;
  const d = new Date(Date.UTC(+y, +mo - 1, +da, +h, +mi, +se));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 把一个 JSON 值写成原子文件（临时文件 + fsync + rename）。 */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 把目录整体移动到归档位置（用于备份被删文件）。 */
export function moveInto(dir, destDir, rel) {
  const src = path.join(dir, rel);
  const dst = path.join(destDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}
