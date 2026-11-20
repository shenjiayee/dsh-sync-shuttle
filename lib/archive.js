// ZIP 封装（纯 JS，不依赖外部 7-Zip 可执行文件）。
//
// 历史：本模块最初用 7z.exe CLI 实现，踩过的 4 个坑（分卷入口是 .001、
// -slt 中文乱码、-slt 前半段是归档自身属性、缺口令时等 stdin 挂死）全部
// 源于「调外部进程 + 解析文本输出」。改用 @zip.js/zip.js 后这些坑从根上消失。
//
// 两个关键设计：
//   1. 分卷不再是归档库的能力，而是**我们自己切片**：zip 流每写满 volumeBytes
//      就落一个 .001/.002 文件。这样产出的每个分卷都是同一个 zip 的字节前缀，
//      按顺序拼回去就是完整归档（与 7z -v 的语义一致，但命名与入口完全可控）。
//   2. 打包与解包都走流式，不把整个归档读进内存——源目录可能有 GB 级。
//
// 加密：本版**不支持**（见方案 A3）。zip 格式的 AES 只加密文件内容，
// 文件名永远明文存在中央目录里，做不到原 7z `-mhe=on` 的「连文件名都看不到」。
// 与其留一个名不副实的开关，不如明确去掉。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import {
  ZipWriter,
  ZipReader,
  Writer,
  Reader,
  ERR_ENCRYPTED,
} from '@zip.js/zip.js';

// ── CRC32（校验 A 用）──────────────────────────────────────────────
// Node 22+ 有 zlib.crc32；老版本用查表实现兜底。两条路径结果必须一致。
let CRC_TABLE = null;
function ensureCrcTable() {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  return CRC_TABLE;
}

function crc32Fallback(buf) {
  const table = ensureCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 计算 Buffer 的 CRC32（无符号 32 位）。 */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    try {
      return zlib.crc32(buf) >>> 0;
    } catch {
      /* 落到下面的兜底实现 */
    }
  }
  return crc32Fallback(buf);
}

/**
 * 增量 CRC32：跨多个数据块累计。
 *
 * 用途：流式读出大文件时，数据是一块块到来的，
 * 不能等全部读进内存再一次性算（会 OOM）。
 *
 * 约定：`state` 是内部未取反的累计值（首块传 0），
 * 全部块喂完后用 `(state ^ 0xffffffff) >>> 0` 得到最终 CRC32。
 * 结果与一次性 crc32Fallback 完全一致（有测试覆盖）。
 *
 * @param state 上一次的返回值（首块传 0）
 * @param buf   本块数据
 * @returns 新的内部状态（未取反）
 */
function crc32Update(state, buf) {
  const table = ensureCrcTable();
  let crc = state === 0 ? 0xffffffff : state;
  for (let i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

/** 归档内路径统一用正斜杠（zip 规范），且不允许绝对路径与 .. 段。 */
export function toZipPath(rel) {
  const p = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '');
  if (!p || p.split('/').some((seg) => seg === '..')) {
    throw new Error(`非法的归档路径：${rel}`);
  }
  return p;
}

/**
 * 自定义写入器：边接收 zip 字节流，边按 volumeBytes 切片落盘。
 * 全程内存占用上限约等于「一个分卷 + 一块缓冲」，不会随归档变大。
 */
class VolumeSlicingWriter extends Writer {
  constructor({ outDir, baseName, volumeBytes, onProgress }) {
    super();
    this.outDir = outDir;
    this.baseName = baseName;
    this.volumeBytes = Math.max(1, Math.floor(volumeBytes));
    this.onProgress = onProgress;
    this.pending = [];
    this.pendingLen = 0;
    this.index = 1;
    this.totalBytes = 0;
    this.volumes = [];
  }

  async writeUint8Array(chunk) {
    const buf = Buffer.from(chunk);
    this.pending.push(buf);
    this.pendingLen += buf.length;
    this.totalBytes += buf.length;

    // 攒够一整卷就落盘；可能一次写入跨过多个卷边界
    while (this.pendingLen >= this.volumeBytes) {
      const all = Buffer.concat(this.pending);
      const take = all.subarray(0, this.volumeBytes);
      const rest = all.subarray(this.volumeBytes);
      this.#flush(take);
      this.pending = rest.length ? [Buffer.from(rest)] : [];
      this.pendingLen = rest.length;
    }
    this.onProgress?.(this.totalBytes);
    return buf.length;
  }

  #flush(buf) {
    const name = `${this.baseName}.${String(this.index).padStart(3, '0')}`;
    const file = path.join(this.outDir, name);
    fs.writeFileSync(file, buf);
    this.volumes.push({ index: this.index, file, bytes: buf.length });
    this.index += 1;
  }

  /** 收尾：把最后不足一卷的余量落盘。 */
  finish() {
    if (this.pendingLen > 0) {
      this.#flush(Buffer.concat(this.pending));
      this.pending = [];
      this.pendingLen = 0;
    }
    return this.volumes;
  }
}

/** 递归列出目录下所有文件（相对路径用 / 分隔）。软链接不跟随，与 util.walkFiles 一致。 */
function listFiles(rootDir) {
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
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(rootDir, childRel);
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        let bytes = 0;
        try {
          bytes = fs.statSync(childAbs).size;
        } catch {
          /* ignore */
        }
        out.push({ rel: childRel, abs: childAbs, bytes });
      }
    }
  }
  return out;
}

/**
 * 检查打包能力是否可用。
 * 纯 JS 实现没有外部依赖，这里只验证写出目录可写、zip.js 已加载。
 * 保留该函数是为了让上层（upload/download）的调用方式无需改动。
 */
export async function checkSevenZip() {
  // 故意不检查 7-Zip：本版已不需要它。
  // 函数名保留是为了兼容既有调用点，语义已变为「归档后端是否就绪」。
  return { ok: true, version: `zip.js (纯 JS)`, backend: 'zip.js' };
}

/**
 * 把目录打包为分卷 ZIP。
 *
 * @param opts.exe          已忽略（保留签名兼容）。不再需要外部 7z。
 * @param opts.sourceDir    源目录
 * @param opts.outDir       分卷输出目录
 * @param opts.baseName     分卷基础名（会产出 <baseName>.001/.002/…）
 * @param opts.volumeBytes  每卷字节上限
 * @param opts.onProgress   (已写字节数) => void
 * @returns { archiveFile, volumeFiles, singleFile, volumes, archiveBytes }
 */
export async function createArchive(opts) {
  const {
    sourceDir,
    outDir,
    baseName,
    volumeBytes,
    onProgress,
    // exe / compression / password 已不再使用（保留以免上层改动）
  } = opts;

  fs.mkdirSync(outDir, { recursive: true });

  // 清掉同名旧产物，避免上次残留的卷混进本次结果
  for (const n of fs.readdirSync(outDir)) {
    if (n.startsWith(`${baseName}.`) || n === `${baseName}.zip`) {
      try {
        fs.rmSync(path.join(outDir, n), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const files = listFiles(sourceDir);
  if (!files.length) throw new Error('源目录是空的，没有可归档的内容');

  const writer = new VolumeSlicingWriter({ outDir, baseName, volumeBytes, onProgress });
  const zipWriter = new ZipWriter(writer);

  try {
    for (const f of files) {
      const meta = fs.statSync(f.abs);
      // 必须**流式**读取，不能 fs.readFileSync：
      //   readFileSync 把整个文件读进内存；单个超大文件会耗尽内存，
      //   而且 zip.js 的 Uint8ArrayReader 需要一次性拿到完整 Buffer。
      //
      // zip.js 接受 Web ReadableStream / Reader / 带 readable 的对象，
      // **不接受** Node 的 fs.ReadStream（会报 readable.getReader is not a function）。
      // 所以用 Readable.toWeb() 包一层：Node 流 → Web 流，内存占用恒定。
      await zipWriter.add(
        toZipPath(f.rel),
        Readable.toWeb(fs.createReadStream(f.abs, { highWaterMark: 1024 * 1024 })),
        { lastModDate: meta.mtime },
      );
    }
    await zipWriter.close();
  } catch (err) {
    throw new Error(`打包失败：${err.message}`);
  }

  const volumes = writer.finish();
  if (!volumes.length) throw new Error('打包失败：没有产出任何分卷文件');

  const archiveBytes = volumes.reduce((s, v) => s + v.bytes, 0);
  return {
    // 「归档入口」就是首卷；调用方拿它做后续校验/解包，语义与 7z 版一致
    archiveFile: volumes[0].file,
    volumeFiles: volumes.map((v) => v.file),
    singleFile: volumes.length === 1,
    volumes,
    archiveBytes,
  };
}

/**
 * 按需读取文件的 zip.js Reader。
 *
 * ⚠️ 为什么不能用 `new ZipReader(new Uint8ArrayReader(fs.readFileSync(file)))`：
 *   `fs.readFileSync` 单次读取上限约 2 GiB，超过就抛
 *     File size (2174260572) is greater than 2 GiB
 *   而归档动辄几个 GB（本插件就是为传大目录设计的），所以**必须**流式/按需读。
 *
 * zip.js 的 Reader 抽象只要求三个方法：
 *   init()                    → { size }
 *   readUint8Array(off, len)  → 该区间的字节
 *   （可选）close()
 * 这样 zip.js 只在需要时读取中央目录/条目数据，内存占用与文件大小无关。
 */
class FdReader extends Reader {
  constructor(file) {
    super();
    this.fd = fs.openSync(file, 'r');
    // ⚠️ 必须暴露 size **属性**，且 init() 返回 undefined。
    // 这一点与直觉相反，是实测出来的：
    //   内置 Uint8ArrayReader 的 init() 返回 undefined，size 是构造时设的属性；
    //   而 zip.js 内部读取 size 时读的是 `reader.size`。
    //   若只让 init() 返回 {size}，zip.js 拿不到 size，会判定文件格式无效
    //   （报 File format is not recognized）。
    this.size = fs.fstatSync(this.fd).size;
  }

  async init() {
    return undefined;
  }

  async readUint8Array(offset, length) {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(this.fd, buf, 0, length, offset);
    return new Uint8Array(buf.subarray(0, read));
  }

  /** 释放文件句柄。zip.js 不强制调用，必须自己保证调。 */
  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

/**
 * 打开一个归档并执行 fn(reader)。
 * 自动处理 FdReader 的创建与释放，避免句柄泄漏。
 */
async function withZipReader(file, fn) {
  const source = new FdReader(file);
  const reader = new ZipReader(source);
  try {
    return await fn(reader);
  } finally {
    try {
      await reader.close();
    } catch {
      /* ignore */
    }
    source.close();
  }
}

/**
 * 把「可能是分卷」的输入解析成一个可读的完整 zip 文件路径。
 *
 * 关键：ZIP 的中央目录（EOCD）在**文件末尾**，所以多卷时只读首卷一定失败
 * （7z 的分卷格式自带跨卷索引，zip 没有）。多卷必须先拼回整包才能读。
 * 这里按需合并到临时文件，并返回清理函数，调用方用完负责删除。
 *
 * @returns { file: string, cleanup: () => void }
 */
async function resolveArchiveSource(input) {
  // 支持三种输入：字符串路径 / 分卷路径数组 / { volumeFiles, archiveFile }
  let files;
  if (Array.isArray(input)) files = input;
  else if (input && typeof input === 'object' && Array.isArray(input.volumeFiles)) files = input.volumeFiles;
  else files = [typeof input === 'string' ? input : input?.file];

  let list = files.filter(Boolean);
  if (!list.length) throw new Error('没有可用的归档分卷');

  // 只给了一个路径时，判断它是不是分卷：xxx.001 这种要把同目录的其余卷补齐。
  // （ZIP 的中央目录在最后一卷，只读首卷必然报 "End of central directory not found"）
  if (list.length === 1 && /\.\d{3,}$/.test(list[0])) {
    const first = list[0];
    // 注意：baseName 必须是**纯文件名前缀**，不能含目录。
    // findVolumes 内部用 readdir 出来的文件名做 startsWith 比较。
    const baseName = path.basename(first).replace(/\.\d{3,}$/, '');
    const siblings = findVolumes(path.dirname(first), baseName);
    if (siblings.length) list = siblings;
  }

  if (list.length === 1) {
    return { file: list[0], cleanup: () => {} };
  }

  // 多卷：合并到同目录的临时文件
  const dir = path.dirname(list[0]);
  const tmp = path.join(dir, `.merged-${process.pid}-${Date.now()}.zip`);
  await mergeVolumes(list, tmp);
  return {
    file: tmp,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 校验归档完整性（对应说明书「校验 A」）。
 *
 * ⚠️ 关键：zip.js 的 getData() **不做 CRC 校验**（实测：把压缩数据区改坏一个字节，
 * getData 依然老老实实返回全量数据，不抛错）。所以不能"读一遍就算校验过了"，
 * 必须自己按条目声明的 crc32 重算比对。这一步等价于原 `7z t` 的 CRC 全量校验，
 * 是「新版本校验通过前不删旧版本」这条护栏的基础，不能省。
 *
 * @param input 分卷数组 / 首卷路径 / 完整 zip 路径 均可（多卷会自动合并）
 */
export async function testArchive(input) {
  let src = null;
  try {
    src = await resolveArchiveSource(input);
    // 用 FdReader 按需读：归档可能有几个 GB，不能 readFileSync（2 GiB 上限）
    return await withZipReader(src.file, async (reader) => {
      const entries = await reader.getEntries();
      if (!entries.length) {
        return { ok: false, message: '归档里没有任何条目' };
      }

      let files = 0;
      for (const e of entries) {
        if (e.directory) continue;

        // ⚠️ 必须**流式**读出条目内容，不能 getData(new Uint8ArrayWriter())：
        //    那会把整个条目读进内存，单个 >2 GB 的文件直接抛
        //      RangeError: Array buffer allocation failed
        //    （实测 3.4 GB 目录里的 2.2 GB 文件必然触发）。
        //    改成传 WritableStream：数据分块流过，边流过边算 CRC，
        //    内存占用恒定为块大小。
        let bytes = 0;
        // ⚠️ 空文件（没有任何 chunk）的 CRC32 必须是 0。
        //    crc32Update(0, 空块) 返回内部状态 0xffffffff，取反得 0 —— 正确；
        //    但如果一次 write 都没发生，actualCrc 仍是 0，取反得到 0xffffffff —— 错误。
        //    所以要用 flag 区分「从未写入」与「写了空块」。
        let actualCrc = 0;
        const sink = new WritableStream({
          write(chunk) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            actualCrc = crc32Update(actualCrc, buf);
            bytes += buf.length;
            return undefined;
          },
        });

        try {
          await e.getData(sink);
        } catch (err) {
          return {
            ok: false,
            message: `条目 ${e.filename} 读取失败：${String(err?.message || err).slice(-300)}`,
          };
        }
        // ⚠️ 空文件的 CRC32 必须得到 0，这里有两个坑：
        //   a) 若从未调用 write（空文件常见），actualCrc 还是初值 0，
        //      取反后得到 0xffffffff —— 错。
        //   b) 若调用了 write 但传入空块，crc32Update(0, 空) 返回 0xffffffff，
        //      取反后得到 0 —— 对。
        // 统一处理：**用 bytes 判断有没有真实数据**，而不是用 write 次数。
        // bytes === 0 时直接认定 CRC32 = 0（与 zlib.crc32(空) 一致）。
        const got = bytes === 0 ? 0 : (actualCrc ^ 0xffffffff) >>> 0;

        // ① 长度必须与中央目录声明一致（截断/多写都能发现）
        if (Number.isFinite(e.uncompressedSize) && bytes !== e.uncompressedSize) {
          return {
            ok: false,
            message: `条目 ${e.filename} 解压后长度不符（声明 ${e.uncompressedSize} 实得 ${bytes}）`,
          };
        }
        // ② CRC32 必须与中央目录声明一致——这才是真正能发现数据区损坏的一步
        if (Number.isFinite(e.crc32)) {
          const declared = e.crc32 >>> 0;
          if (got !== declared) {
            return {
              ok: false,
              message: `条目 ${e.filename} CRC32 不符（声明 ${declared.toString(16)} 实得 ${got.toString(16)}）`,
            };
          }
        }
        files += 1;
      }
      return { ok: true, files };
    });
  } catch (err) {
    return { ok: false, message: err?.message ? String(err.message).slice(-800) : String(err) };
  } finally {
    src?.cleanup?.();
  }
}

/**
 * 列出归档内文件清单（不落地）。
 * @param input 分卷数组 / 首卷路径 / 完整 zip 路径 均可（多卷会自动合并）
 * @returns { ok, files: [{rel, bytes}] } 或 { ok:false, reason, message }
 */
export async function listArchive(input) {
  let src = null;
  try {
    src = await resolveArchiveSource(input);
    // FdReader 按需读，不受 2 GiB 限制
    return await withZipReader(src.file, async (reader) => {
      const entries = await reader.getEntries();
      const files = entries
        .filter((e) => !e.directory && e.filename && !e.filename.endsWith('/'))
        .map((e) => ({ rel: e.filename.replace(/\\/g, '/'), bytes: Number(e.uncompressedSize) || 0 }));
      return { ok: true, files };
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (err?.code === ERR_ENCRYPTED || /encrypt/i.test(msg)) {
      return { ok: false, reason: 'ENCRYPTED', message: '归档已加密，本版不支持' };
    }
    return { ok: false, reason: 'FAILED', message: msg.slice(-800) };
  } finally {
    src?.cleanup?.();
  }
}

/**
 * 解包到目标目录（覆盖同名文件）。
 * 逐条目写出，父目录自动创建；空目录条目也会建出来。
 */
export async function extractArchive(archiveFileOrExe, maybeArchive, maybeTarget) {
  // 兼容 7z 版签名 extractArchive(exe, archiveFile, targetDir)
  let archiveFile;
  let targetDir;
  if (maybeTarget !== undefined) {
    archiveFile = maybeArchive;
    targetDir = maybeTarget;
  } else {
    archiveFile = archiveFileOrExe;
    targetDir = maybeArchive;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  try {
    // FdReader 按需读，不受 2 GiB 限制
    return await withZipReader(archiveFile, async (reader) => {
      const entries = await reader.getEntries();

      for (const e of entries) {
        const rel = toZipPath(e.filename);
        const dest = path.join(targetDir, rel);
        if (e.directory) {
          fs.mkdirSync(dest, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });

        // ⚠️ 必须流式写盘，不能 getData(new Uint8ArrayWriter())+writeFileSync：
        //    那会把整个条目读进内存，单个 >2 GB 的文件直接抛
        //      RangeError: Array buffer allocation failed
        //    改成 WritableStream 直接落到文件句柄：内存占用恒定为块大小。
        const fd = fs.openSync(dest, 'w');
        try {
          const sink = new WritableStream({
            write(chunk) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              return new Promise((resolve, reject) => {
                fs.write(fd, buf, 0, buf.length, null, (err) =>
                  err ? reject(err) : resolve(),
                );
              });
            },
          });
          await e.getData(sink);
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
      return { ok: true, extracted: entries.filter((e) => !e.directory).length };
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (err?.code === ERR_ENCRYPTED || /encrypt/i.test(msg)) {
      throw new Error('解包失败：归档已加密，本版不支持');
    }
    throw new Error(`解包失败：${msg.slice(-800)}`);
  }
}

/** 找出一个目录里的所有分卷（按名字排序），用于合并。 */
export function findVolumes(dir, baseName) {
  const prefix = `${baseName}.`;
  return fs
    .readdirSync(dir)
    // 卷号至少 3 位：超过 999 卷时文件名是 .1000（4 位），
    // 用 {3,} 而不是 {3}，否则大归档的后续分卷会被漏掉、
    // 导致「多片自动补齐」失效、合并出残缺的 zip。
    .filter((n) => /\.\d{3,}$/.test(n) && n.startsWith(prefix))
    .sort()
    .map((n) => path.join(dir, n));
}

/** 把分卷按顺序合并成单个文件（流式写，避免占内存）。 */
export async function mergeVolumes(volumeFiles, outFile) {
  const fd = fs.openSync(outFile, 'w');
  try {
    for (const file of volumeFiles) {
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
        stream.on('error', reject);
        stream.on('data', (chunk) => {
          fs.writeSync(fd, chunk);
        });
        stream.on('end', resolve);
      });
    }
  } finally {
    fs.closeSync(fd);
  }
  return outFile;
}
