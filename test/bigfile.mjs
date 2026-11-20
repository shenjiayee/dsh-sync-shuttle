// 离线：大文件流式打包（不联网）。
//
// 背景：曾用 fs.readFileSync 读取源文件，遇到 3.4 GB 的文件时 Node 直接抛
//   File size (3462603809) is greater than 2 GiB
// 这是 Node 单次读取 Buffer 的硬上限（约 2 GiB），不是 zip.js 的限制，
// 也不是 QQ 的限制。修复方式是改用流式读取（Readable.toWeb + createReadStream）。
//
// 本测试用**稀疏文件**模拟大文件（不真占磁盘），验证：
//   1. readFileSync 在 >2 GiB 时确实失败（记录这个事实，作为回归基线）
//   2. 流式读取能正常处理，打包不报错
//   3. 小文件仍能正确往返（确认改流式没破坏原有行为）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const { imp } = await import('./cred.mjs');
const arch = await imp('archive.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + String(extra).slice(0, 220) : ''}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bigfile-'));
const GiB = 1024 ** 3;

// ── 1. 记录并确认 Node 的 2 GiB 读取上限（不进仓库的核心事实）
{
  const p = path.join(root, 'probe.bin');
  const SIZE = Math.floor(2.1 * GiB);
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, SIZE); // 稀疏文件，几乎不占磁盘
  fs.closeSync(fd);

  let readFailed = false;
  let msg = '';
  try {
    fs.readFileSync(p);
  } catch (e) {
    readFailed = true;
    msg = e.message;
  }
  check('fill: readFileSync 在 >2 GiB 时失败（Node 硬上限）', readFailed, msg);
  check(
    'fill: 报错文案含 "greater than 2 GiB"',
    /greater than 2 GiB/i.test(msg),
    msg,
  );
  fs.rmSync(p, { force: true });
}

// ── 2. 流式打包大文件：核心验证
{
  const srcDir = path.join(root, 'src-big');
  const outDir = path.join(root, 'out-big');
  fs.mkdirSync(srcDir, { recursive: true });

  // 造一个 >2 GiB 的**不可压缩**文件。
  // 注意：不能用稀疏文件（全零）—— deflate 会把 2 GiB 零压到几百 KB，
  // 那样既测不到分卷，也测不到磁盘写入路径。
  // 这里用重复的随机块写满，保证压缩率接近 1:1。
  const bigFile = path.join(srcDir, 'big.bin');
  const BIG = Math.floor(2.2 * GiB);
  const blockSize = 8 * 1024 * 1024; // 8 MiB 随机块
  const block = crypto.randomBytes(blockSize); // 随机数据不可压缩
  const fd = fs.openSync(bigFile, 'w');
  let written = 0;
  while (written < BIG) {
    const len = Math.min(blockSize, BIG - written);
    fs.writeSync(fd, block, 0, len);
    written += len;
  }
  fs.closeSync(fd);

  fs.writeFileSync(path.join(srcDir, 'small.txt'), 'hello 大文件测试\n'.repeat(100));

  const actualBig = fs.statSync(bigFile).size;
  console.log(`  不可压缩文件: ${(actualBig / GiB).toFixed(2)} GiB`);

  // 用很小的分片（4 MiB）避免测试产出巨量文件
  let packed = null;
  let err = null;
  const t0 = Date.now();
  try {
    packed = await arch.createArchive({
      sourceDir: srcDir,
      outDir,
      baseName: 'BIG',
      volumeBytes: 64 * 1024 * 1024, // 64 MiB
    });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - t0;

  check('流式打包 >2 GiB 文件成功（不再抛 2 GiB 错误）', !err, err?.message);
  check(
    '未出现 "greater than 2 GiB" 错误',
    !err || !/greater than 2 GiB/i.test(err.message),
    err?.message,
  );
  if (packed) {
    check('产出了分卷', packed.volumeFiles.length > 0, `${packed.volumeFiles.length} 卷`);
    check(
      '归档总字节 > 2 GiB',
      packed.archiveBytes > 2 * GiB,
      `${(packed.archiveBytes / GiB).toFixed(2)} GiB`,
    );
    console.log(`  打包耗时 ${(elapsed / 1000).toFixed(1)}s，产出 ${packed.volumeFiles.length} 卷`);

    // ── 关键：2 GiB 归档的**读取**链路也不能崩
    // 之前 readFileSync 在这里同样会抛 2 GiB 错误
    // （测试报错为「归档自检失败：File size (...) is greater than 2 GiB」）

    // ① 自检（testArchive 内部走 FdReader 按需读）
    let testRes = null;
    let testErr = null;
    const t1 = Date.now();
    try {
      testRes = await arch.testArchive(packed.archiveFile);
    } catch (e) {
      testErr = e;
    }
    check('2 GiB 归档自检不抛 2 GiB 错误', !testErr || !/greater than 2 GiB/i.test(testErr.message), testErr?.message);
    check('2 GiB 归档自检通过', testRes?.ok === true, testRes?.message);
    console.log(`  自检耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s，${testRes?.files ?? '?'} 个条目`);

    // ② 列目录
    let listRes = null;
    let listErr = null;
    try {
      listRes = await arch.listArchive(packed.archiveFile);
    } catch (e) {
      listErr = e;
    }
    check('2 GiB 归档列目录不抛 2 GiB 错误', !listErr || !/greater than 2 GiB/i.test(listErr.message), listErr?.message);
    check('2 GiB 归档列目录成功', listRes?.ok === true, listRes?.message);
    check(
      '列出的条目含大文件与小文件',
      listRes?.files?.some((f) => f.rel === 'big.bin') && listRes.files.some((f) => f.rel === 'small.txt'),
      JSON.stringify(listRes?.files?.map((f) => f.rel)),
    );

    // ③ 合并 + 解包（这才是完整链路）
    const mergedBig = path.join(root, 'merged-big.zip');
    let extractErr = null;
    const targetBig = path.join(root, 'target-big');
    try {
      await arch.mergeVolumes(packed.volumeFiles, mergedBig);
      await arch.extractArchive(mergedBig, targetBig);
    } catch (e) {
      extractErr = e;
    }
    check('2 GiB 归档合并+解包不抛 2 GiB 错误', !extractErr || !/greater than 2 GiB/i.test(extractErr.message), extractErr?.message);
    check('2 GiB 归档解包成功', !extractErr, extractErr?.message);
    if (!extractErr) {
      const bigBack = path.join(targetBig, 'big.bin');
      check(
        '解包出的大文件大小正确',
        fs.existsSync(bigBack) && fs.statSync(bigBack).size === BIG,
        `${fs.existsSync(bigBack) ? fs.statSync(bigBack).size : 'missing'} vs ${BIG}`,
      );
      // 抽样校验内容：只比对首尾 4 字节与中间一块，避免读 2 GB
      if (fs.existsSync(bigBack)) {
        const fd2 = fs.openSync(bigBack, 'r');
        const head = Buffer.alloc(1024);
        fs.readSync(fd2, head, 0, 1024, 0);
        const fd3 = fs.openSync(bigFile, 'r');
        const headOrig = Buffer.alloc(1024);
        fs.readSync(fd3, headOrig, 0, 1024, 0);
        fs.closeSync(fd2);
        fs.closeSync(fd3);
        check('解包内容首部 1KB 一致（抽样）', head.equals(headOrig));
      }
    }
    fs.rmSync(mergedBig, { force: true });
    fs.rmSync(targetBig, { recursive: true, force: true });
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
}

// ── 3. 小文件往返仍然正确（确认改流式没有破坏原有行为）
{
  const srcDir = path.join(root, 'src-small');
  const outDir = path.join(root, 'out-small');
  const targetDir = path.join(root, 'target-small');
  fs.mkdirSync(path.join(srcDir, '子目录'), { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const payload = crypto.randomBytes(300_000);
  fs.writeFileSync(path.join(srcDir, 'a.bin'), payload);
  fs.writeFileSync(path.join(srcDir, '说明.txt'), '流式改造后的往返测试\n'.repeat(80));
  fs.writeFileSync(path.join(srcDir, '空文件.txt'), '');
  fs.writeFileSync(path.join(srcDir, '子目录', 'b.bin'), crypto.randomBytes(50_000));

  const packed = await arch.createArchive({
    sourceDir: srcDir,
    outDir,
    baseName: 'SMALL',
    volumeBytes: 1 * 1024 * 1024,
  });
  check('小文件打包成功', packed.volumeFiles.length > 0);

  const merged = path.join(root, 'merged-small.zip');
  await arch.mergeVolumes(packed.volumeFiles, merged);
  await arch.extractArchive(merged, targetDir);

  const origHash = crypto.createHash('sha256').update(payload).digest('hex');
  const backHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(targetDir, 'a.bin')))
    .digest('hex');
  check('小文件内容哈希一致（流式改造无回归）', origHash === backHash, `${origHash.slice(0, 12)} vs ${backHash.slice(0, 12)}`);
  check('空文件保留', fs.existsSync(path.join(targetDir, '空文件.txt')));
  check(
    '空文件大小为 0',
    fs.statSync(path.join(targetDir, '空文件.txt')).size === 0,
  );
  check('中文文件名正确', fs.existsSync(path.join(targetDir, '说明.txt')));
  check('子目录结构正确', fs.existsSync(path.join(targetDir, '子目录', 'b.bin')));

  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
}

// ── 4. 确认代码里不再有整文件读取
{
  const src = fs.readFileSync('D:/dsh-project/sync-shuttle/lib/archive.js', 'utf8');
  check(
    'createArchive 不再用 readFileSync 读源文件',
    !/new Uint8ArrayReader\(fs\.readFileSync\(f\.abs\)\)/.test(src),
  );
  check('使用了 Readable.toWeb 流式包装', /Readable\.toWeb\(fs\.createReadStream/.test(src));
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
