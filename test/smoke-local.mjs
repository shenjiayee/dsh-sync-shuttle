// 纯本地冒烟测试：不联网，验证 paths/settings/envelope/manifest/util 的基本行为。
// 放在插件源码目录之外，不进 git。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { pathToFileURL } from 'node:url';
const { LIB: SRC, imp } = await import('./cred.mjs');

const { buildPaths, ensureDirs, MAIL_FOLDERS } = await imp('paths.js');
const { createSettings } = await imp('settings.js');
const env = await imp('envelope.js');
const man = await imp('manifest.js');
const util = await imp('util.js');
const { createLogger } = await imp('log.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-smoke-'));

// ---- 1. 项目名 percent-encoding 往返（中文、竖线、斜杠、emoji）
const names = ['照片归档', 'a|b', 'x/y', '带 空格', '🎉emoji', 'Ｃ全角', 'C半角', 'a'.repeat(80)];
for (const n of names) {
  const enc = env.encodeProject(n);
  const dec = env.decodeProject(enc);
  check(`编码往返 ${JSON.stringify(n).slice(0, 30)}`, dec === n, `dec=${dec}`);
  check(`编码后纯 ASCII ${JSON.stringify(n).slice(0, 20)}`, /^[\x20-\x7E]*$/.test(enc), enc);
}
check('全角与半角视为不同', env.encodeProject('Ｃ') !== env.encodeProject('C'));

// ---- 2. 主题净化
const dirty = 'a|b\nc\td';
const clean = util.sanitizeSubjectName(dirty);
check('主题净化去竖线换行', !/[|\n\t]/.test(clean), clean);
check('主题净化截断 60', util.sanitizeSubjectName('x'.repeat(200)).length <= 60);

// ---- 3. 邮件头往返
const meta = {
  project: '照片归档',
  version: '20261119T152041',
  versionId: 'SS-A3K9QZ',
  index: 2,
  total: 12,
  volumeBytes: 41943040,
  volumeSha256: 'a'.repeat(64),
  archiveBytes: 500000000,
  archiveSha256: 'b'.repeat(64),
  sourceBytes: 480000000,
  sourceFiles: 1234,
  encrypted: false,
  keepPrev: true,
};
const headers = env.buildHeaders(meta);
const asObject = {};
for (const [k, v] of Object.entries(headers)) asObject[k.toLowerCase()] = String(v);
const back = env.readDataHeaders(asObject);
check('头往返 project', back && back.project === meta.project, JSON.stringify(back?.project));
check('头往返 versionId', back?.versionId === meta.versionId);
check('头往返 index/total', back?.index === 2 && back?.total === 12);
check('头往返 archiveSha256', back?.archiveSha256 === meta.archiveSha256);
check('头往返 keepPrev', back?.keepPrev === true);
check('头往返 sourceFiles', back?.sourceFiles === 1234);
for (const [k, v] of Object.entries(headers)) {
  check(`头值纯 ASCII ${k}`, /^[\x20-\x7E]*$/.test(String(v)), String(v));
}

// ---- 4. 清单正文往返
const body = env.buildManifestBody({
  ...meta,
  total: 2,
  volumes: [
    { index: 1, bytes: 100, sha256: 'c'.repeat(64) },
    { index: 2, bytes: 200, sha256: 'd'.repeat(64) },
  ],
});
const parsed = env.parseManifestBody(body);
check('清单解析 complete', parsed.complete === true);
check('清单解析卷数', parsed.volumes.length === 2, String(parsed.volumes.length));
check('清单解析字节', parsed.volumes[1].bytes === 200);

// 损坏清单不抛异常
const broken = env.parseManifestBody('garbage\nvolumeList:\n  1|abc|zzz\n');
check('坏清单不抛且 complete=false', broken.complete === false);

// ---- 5. 版本聚合
//
// manifest 现在吃的是 storage adapter 的 list() 输出，不再直接读邮件头。
// 每个 entry 形如 { ref, key, meta: {version, volume}, sizeBytes, createdAtMs }。
// 这样换后端（SMB 等）时本模块无需改动。
const mkEntry = (o) => {
  const v = {
    project: meta.project,
    version: o.version,
    versionId: o.versionId,
    total: o.total,
    archiveBytes: o.archiveBytes,
    archiveSha256: meta.archiveSha256,
    sourceFiles: meta.sourceFiles,
    sourceBytes: meta.sourceBytes,
    encrypted: false,
    keepPrev: false,
  };
  return {
    ref: String(o.seq),
    key: `${meta.project}\u0000${o.version}`,
    sizeBytes: o.volumeBytes,
    createdAtMs: new Date(o.date).getTime(),
    meta: {
      version: v,
      volume: { index: o.index, bytes: o.volumeBytes, sha256: `sha-${o.seq}`.padEnd(64, '0') },
    },
  };
};
const messages = [
  mkEntry({ seq: 1, date: '2026-11-19T07:00:00Z', version: '20261119T150000', versionId: 'SS-AAA001', index: 1, total: 2, volumeBytes: 100, archiveBytes: 300 }),
  mkEntry({ seq: 2, date: '2026-11-19T07:00:01Z', version: '20261119T150000', versionId: 'SS-AAA001', index: 2, total: 2, volumeBytes: 200, archiveBytes: 300 }),
  mkEntry({ seq: 3, date: '2026-11-19T09:00:00Z', version: '20261119T170000', versionId: 'SS-BBB002', index: 1, total: 2, volumeBytes: 150, archiveBytes: 300 }),
];
const versions = man.aggregateVersions(messages);
check('版本数 2', versions.length === 2, String(versions.length));
const groups = man.groupByProject(versions);
check('项目分组 1', groups.length === 1);
check('最新版是最新时间戳', groups[0].latest.version === '20261119T170000', groups[0].latest.version);
check('最新版缺卷标记', groups[0].latest.status === 'missing', groups[0].latest.status);
check('缺卷不回退（latest 不是完整的那版）', groups[0].latest.versionId === 'SS-BBB002');
check('历史版存在', groups[0].history.length === 1);
check('完整版状态', groups[0].history[0].status === 'complete', groups[0].history[0].status);
check('占用字节', man.totalOccupied(versions) === 450, String(man.totalOccupied(versions)));

// ---- 6. settings 与凭据
const dataDir = path.join(tmpRoot, 'data');
const settings = createSettings({ volumeBytes: 41943040 }, { env: { ...process.env, DSH_HOME: tmpRoot } });
check('dataDir 落在 DSH_HOME 下', settings.dataDir.startsWith(tmpRoot), settings.dataDir);
const p = buildPaths(dataDir);
ensureDirs(p);
check('目录已建', fs.existsSync(p.buildDir) && fs.existsSync(p.fetchDir) && fs.existsSync(p.logsDir));
check('初始无凭据', settings.hasCredentials() === false);
const snap0 = settings.snapshot();
check('snapshot 不含 token 字段', !('token' in snap0));
settings.saveCredentials({ account: 'abc@qq.com', token: 'x'.repeat(16) });
check('保存后 hasCredentials', settings.hasCredentials() === true);
const snap1 = settings.snapshot();
check('脱敏账号', snap1.accountMasked.includes('*'), snap1.accountMasked);
check('connection 带 token', settings.connection().token === 'x'.repeat(16));
check('凭据文件已写', fs.existsSync(settings.paths.credentials));

// ---- 7. 日志脱敏
const logger = createLogger({ logsDir: p.logsDir, level: 'debug' });
logger.info('测试', { account: 'abcdefg@qq.com', password: 'secret123' });
await new Promise((r) => setTimeout(r, 120));
const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const logs = logger.read(dateKey);
const text = typeof logs === 'string' ? logs : JSON.stringify(logs);
check('日志可读', text.length > 0);
check('日志 maskEmail 生效', !text.includes('abcdefg@qq.com'), text.slice(0, 200));

// ---- 8. 原子写 + 目录工具
const atomicFile = path.join(tmpRoot, 'atomic.json');
util.writeFileAtomic(atomicFile, JSON.stringify({ a: 1 }));
check('原子写成功', JSON.parse(fs.readFileSync(atomicFile, 'utf8')).a === 1);

const srcDir = path.join(tmpRoot, 'src');
fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'world');
const walked = util.walkFiles(srcDir);
check('walkFiles 递归 2 个', walked.length === 2, JSON.stringify(walked));
check('盘符根识别', util.isDriveRoot('D:\\') === true && util.isDriveRoot('D:\\x') === false);

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
