// 离线端到端测试：打包 → 分卷 → 自检 → 列表 → 合并 → 解包 → 逐文件比对。
//
// 本套测试原本针对 7z CLI（-slt / -sccUTF-8 / .001 入口等坑）。
// 改用内置纯 JS ZIP 后，那些坑不复存在，因此断言也换成验证新实现的正确性：
//   · 分卷是我们自己切的，必须字节接续、拼回去等于整包
//   · 中文路径必须往返正确（zip 用 UTF-8 文件名，不再依赖控制台代码页）
//   · 空文件、深层目录、不可压缩二进制都要保留
//   · 归档损坏必须被 testArchive 发现
// 不联网、不碰邮箱。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { imp } = await import('./cred.mjs');
const arch = await imp('archive.js');
const util = await imp('util.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + String(extra).slice(0, 250) : ''}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
const sourceDir = path.join(root, 'source');
const outDir = path.join(root, 'arch');
const fetchDir = path.join(root, 'fetch');
const targetDir = path.join(root, 'target');
fs.mkdirSync(path.join(sourceDir, '照片', '2026', '子目录'), { recursive: true });
fs.mkdirSync(path.join(sourceDir, '空目录'), { recursive: true });
fs.mkdirSync(fetchDir, { recursive: true });
fs.mkdirSync(targetDir, { recursive: true });

// ---- 造源数据：多层目录、中文名、空文件、小文件、大二进制（不可压缩，确保多卷）
fs.writeFileSync(path.join(sourceDir, '说明.txt'), '同步中转 ZIP 端到端测试\n'.repeat(120));
fs.writeFileSync(path.join(sourceDir, '照片', '2026', '照片一.bin'), crypto.randomBytes(180_000));
fs.writeFileSync(path.join(sourceDir, '照片', '2026', '子目录', '深层.txt'), 'deep\n'.repeat(300));
fs.writeFileSync(path.join(sourceDir, '空文件.txt'), '');
fs.writeFileSync(path.join(sourceDir, '小文件.dat'), Buffer.from([1, 2, 3, 4, 5]));
fs.writeFileSync(path.join(sourceDir, '大文件.bin'), crypto.randomBytes(1_200_000));

const sourceFiles = util.walkFiles(sourceDir);
const sourceHash = new Map();
for (const f of sourceFiles) sourceHash.set(f.rel.replace(/\\/g, '/'), await util.sha256File(f.abs));
console.log(`源 ${sourceFiles.length} 个文件 ${util.humanBytes(sourceFiles.reduce((s, f) => s + f.bytes, 0))}`);

// ---- 1. 归档后端可用（纯 JS，不需要外部 7-Zip）
const backend = await arch.checkSevenZip();
check('归档后端可用（内置 ZIP，无需 7-zip.exe）', backend.ok === true, JSON.stringify(backend));
check('后端标识为纯 JS', String(backend.backend || '').includes('zip'), backend.backend);

// ---- 2. 打包（1 MiB 分卷，必然多卷）
const packed = await arch.createArchive({
  sourceDir,
  outDir,
  baseName: 'SS-TEST01',
  volumeBytes: 1024 * 1024,
});
check('打包产出多个分卷', packed.volumeFiles.length > 1, `${packed.volumeFiles.length} 卷`);
check('首卷就是归档入口', packed.archiveFile === packed.volumeFiles[0]);
check(
  '分卷命名是 .001 起（纯数字扩展）',
  /\.001$/.test(packed.archiveFile),
  path.basename(packed.archiveFile),
);
check(
  'archiveBytes 等于各卷字节和',
  packed.archiveBytes === packed.volumes.reduce((s, v) => s + v.bytes, 0),
  `${packed.archiveBytes}`,
);
check(
  '除末卷外每卷都恰好等于分卷大小',
  packed.volumes.slice(0, -1).every((v) => v.bytes === 1024 * 1024),
  packed.volumes.map((v) => v.bytes).join(','),
);

// ---- 3. 自检（校验 A：逐条目读出让 zip.js 验 CRC32）
const tested = await arch.testArchive(packed.archiveFile);
check('归档自检通过', tested.ok === true, tested.message);
check('自检报出正确文件数', tested.files === sourceFiles.length, `${tested.files} vs ${sourceFiles.length}`);

// ---- 4. 列出归档内容
const listed = await arch.listArchive(packed.archiveFile);
check('列目录成功', listed.ok === true, listed.message);
const listedRels = new Set(listed.files.map((f) => f.rel));
check('列出的文件数等于源文件数', listed.files.length === sourceFiles.length, `${listed.files.length} vs ${sourceFiles.length}`);
check('中文路径在列目录里正确', [...listedRels].some((r) => r.includes('照片/2026/照片一.bin')), [...listedRels].join(' | '));
check(
  '列目录的字节与源一致',
  sourceFiles.every((f) => {
    const hit = listed.files.find((x) => x.rel === f.rel.replace(/\\/g, '/'));
    return hit && hit.bytes === f.bytes;
  }),
);

// ---- 5. 合并（模拟下载后拼回）
const merged = path.join(fetchDir, 'merged.zip');
const volumeFiles = packed.volumeFiles.slice();
await arch.mergeVolumes(volumeFiles, merged);
const mergedBytes = fs.statSync(merged).size;
check('合并后字节等于 archiveBytes', mergedBytes === packed.archiveBytes, `${mergedBytes} vs ${packed.archiveBytes}`);

// 二次合并且结果一致（幂等）
const merged2 = path.join(fetchDir, 'merged2.zip');
await arch.mergeVolumes(volumeFiles, merged2);
check('重复合并结果一致（幂等）', (await util.sha256File(merged2)) === (await util.sha256File(merged)));

const mergedSha = await util.sha256File(merged);
check('合并产物是合法 ZIP（PK 魔数）', (() => {
  const fd = fs.openSync(merged, 'r');
  const b = Buffer.alloc(2);
  fs.readSync(fd, b, 0, 2, 0);
  fs.closeSync(fd);
  return b[0] === 0x50 && b[1] === 0x4b;
})());

// ---- 6. 解包 + 逐文件比对
await arch.extractArchive(merged, targetDir);
const targetFiles = util.walkFiles(targetDir);
check('解包后文件数一致', targetFiles.length === sourceFiles.length, `${targetFiles.length} vs ${sourceFiles.length}`);

const mismatched = [];
for (const tf of targetFiles) {
  const rel = tf.rel.replace(/\\/g, '/');
  const want = sourceHash.get(rel);
  if (!want) {
    mismatched.push(`多余:${rel}`);
    continue;
  }
  const got = await util.sha256File(tf.abs);
  if (got !== want) mismatched.push(`不符:${rel}`);
}
check('解包后逐文件 SHA-256 全部一致', mismatched.length === 0, mismatched.slice(0, 6).join(', '));

// 空文件与深层路径
check(
  '空文件被保留且长度 0',
  fs.existsSync(path.join(targetDir, '空文件.txt')) && fs.statSync(path.join(targetDir, '空文件.txt')).size === 0,
);
check('深层嵌套路径正确还原', fs.existsSync(path.join(targetDir, '照片', '2026', '子目录', '深层.txt')));

// ---- 7. 损坏检测：改坏一个字节，自检必须失败
const corruptDir = path.join(root, 'corrupt');
fs.mkdirSync(corruptDir, { recursive: true });
const corruptZip = path.join(corruptDir, 'bad.zip');
const good = fs.readFileSync(merged);
const bad = Buffer.from(good);
// 改中间一个字节（避开末尾中央目录，确保能测到数据区损坏）
bad[Math.floor(bad.length / 2)] ^= 0xff;
fs.writeFileSync(corruptZip, bad);
const corruptTest = await arch.testArchive(corruptZip);
check('数据区被改坏时自检失败', corruptTest.ok === false, JSON.stringify(corruptTest).slice(0, 150));

// 截断也必须被发现
const truncZip = path.join(corruptDir, 'trunc.zip');
fs.writeFileSync(truncZip, good.subarray(0, Math.floor(good.length * 0.6)));
const truncTest = await arch.testArchive(truncZip);
check('归档被截断时自检失败', truncTest.ok === false, JSON.stringify(truncTest).slice(0, 150));

// ---- 8. findVolumes 能从目录里认出分卷
const found = arch.findVolumes(outDir, 'SS-TEST01');
check('findVolumes 找到全部分卷', found.length === packed.volumeFiles.length, `${found.length} vs ${packed.volumeFiles.length}`);
check('findVolumes 结果按卷号升序', /\.001$/.test(found[0]), path.basename(found[0] || ''));

// ---- 9. 非法路径必须被拒绝（防止归档穿越写到目标目录之外）
check('拒绝 .. 路径', (() => {
  try {
    arch.toZipPath('../../etc/passwd');
    return false;
  } catch {
    return true;
  }
})());
check('拒绝绝对路径前缀', arch.toZipPath('/a/b.txt') === 'a/b.txt');
check('反斜杠归一为正斜杠', arch.toZipPath('a\\b\\c.txt') === 'a/b/c.txt');

// ---- 10. 空目录打包必须报错（不能静默产出空归档）
const emptyDir = path.join(root, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });
let emptyThrew = false;
try {
  await arch.createArchive({ sourceDir: emptyDir, outDir: path.join(root, 'empty-out'), baseName: 'E', volumeBytes: 1024 });
} catch {
  emptyThrew = true;
}
check('空目录打包被拒绝', emptyThrew);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
