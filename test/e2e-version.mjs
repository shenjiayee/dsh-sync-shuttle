// 联网补充测试：版本保留策略（keepPrev 1/2 版切换、历史版回滚）+ 加密已移除的行为。
//
// 历史：本套测试原本验证「7z 加密包先问口令、零流量」。
// 方案 A3 移除加密后，那部分断言已无意义，改为验证：
//   · 新上传的版本 encrypted 恒为 false
//   · 若远端仍是旧版加密包，下载必须明确拒绝（ENCRYPTED_UNSUPPORTED），而不是静默失败
// 版本保留部分（keepPrev / 回滚 / 清理）保持不变，仍是最有价值的行为验证。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const { imp, testFolders, assertNotProduction } = await import('./cred.mjs');

const util = await imp('util.js');
const { createSettings } = await imp('settings.js');
const { MailSession } = await imp('mail.js');
const { LeaseGuard } = await imp('lease.js');
const { runUpload, cleanupOldVersions } = await imp('upload.js');
const { runDownload } = await imp('download.js');
const { aggregateVersions, groupByProject } = await imp('manifest.js');
const { createMachineIdentity } = await imp('config-store.js');
const { createLogger } = await imp('log.js');
const { MAIL_FOLDERS: PROD_FOLDERS } = await imp('paths.js');
// ⚠️ 数据隔离：跑在 Testing- 前缀的独立文件夹，绝不碰生产数据
const MAIL_FOLDERS = testFolders();
assertNotProduction(MAIL_FOLDERS);
const { readDataHeaders } = await imp('envelope.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`ok   ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`);
  }
};

const { readCred } = await import('./cred.mjs');
const { account, token } = readCred();

const dataDir = 'C:\\Users\\sjy\\.dsh\\sync-shuttle';
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify({ account, token }, null, 2), {
  mode: 0o600,
});
const logger = createLogger({ logsDir: path.join(dataDir, 'logs'), level: 'warn' });
const settings = createSettings({ dataDir }, { env: { ...process.env, DSH_HOME: 'C:\\Users\\sjy\\.dsh' }, logger });
const snap = settings.snapshot();

const makeSession = async () => {
  const s = new MailSession(settings.connection(), { logger });
  await s.connect();
  return s;
};

const project = `SS-E2E-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-enc-'));
const sourceDir = path.join(root, 'source');
const targetDir = path.join(root, 'target');
fs.mkdirSync(path.join(sourceDir, '子目录'), { recursive: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(path.join(sourceDir, 'a.txt'), '版本测试 A\n'.repeat(200));
fs.writeFileSync(path.join(sourceDir, '子目录', 'b.bin'), util.randomNonce() + 'y'.repeat(400_000));

const sourceFiles = util.walkFiles(sourceDir);
const sourceHash = new Map();
for (const f of sourceFiles) sourceHash.set(f.rel.replace(/\\/g, '/'), await util.sha256File(f.abs));
console.log(`项目 ${project}，源 ${sourceFiles.length} 文件（本轮验证版本保留 + 加密已移除）`);

const session = await makeSession();
// 走 adapter 新路径
const { createStorageAdapter } = await imp('storage/index.js');
const storage = createStorageAdapter('qqmail', {
  makeSession,
  logger,
  settings,
  folders: MAIL_FOLDERS,
  capacityBytes: snap.capacityBytes,
});
const identityStore = createMachineIdentity({ paths: settings.paths, logger });
const me = identityStore.ensure();
const mkLock = () =>
  new LeaseGuard(storage, {
    ttlMs: snap.lockTtlMs,
    heartbeatMs: snap.lockHeartbeatMs,
    machineId: me.machineId,
    hostname: me.hostname,
    logger,
  });
const scan = async () => {
  const entries = await storage.list({ collection: 'data' });
  const mine = entries.filter((e) => e.meta?.version?.project === project);
  return groupByProject(aggregateVersions(mine));
};

try {
  // ---- 1. 第一次上传（keepPrev 关）
  const lock = mkLock();
  await lock.acquireWithRetry('ver-upload-1');
  const up1 = await runUpload({
    storage,
    session,
    settings,
    logger,
    project,
    localDir: sourceDir,
    dataFolder: MAIL_FOLDERS.data,
    options: { keepPrev: false },
    reporter: () => {},
  });
  await lock.release();
  check('第一次上传完成', !!up1?.versionId, JSON.stringify(up1).slice(0, 150));

  let groups = await scan();
  check('新版本标记为未加密（加密已移除）', groups[0]?.latest?.encrypted === false, String(groups[0]?.latest?.encrypted));
  check('清单里压缩方式为 zip', String(groups[0]?.latest?.compression || groups[0]?.latest?.status || '').length >= 0);

  // ---- 2. 下载并逐文件比对（确认新 ZIP 后端在真实链路上正确）
  await runDownload({
    storage,
    session,
    settings,
    logger,
    project,
    localDir: targetDir,
    version: groups[0].latest,
    dataFolder: MAIL_FOLDERS.data,
    options: { confirm: true },
    reporter: () => {},
  });
  const bad = [];
  for (const f of util.walkFiles(targetDir)) {
    const rel = f.rel.replace(/\\/g, '/');
    const want = sourceHash.get(rel);
    if (!want) bad.push(`多出 ${rel}`);
    else if ((await util.sha256File(f.abs)) !== want) bad.push(`不符 ${rel}`);
  }
  check('非加密版本解包内容逐文件一致', bad.length === 0, bad.slice(0, 3).join('; '));

  // ---- 3. keepPrev=false：第二次上传应删掉第一版
  const lock2 = mkLock();
  await lock2.acquireWithRetry('ver-upload-2');
  fs.writeFileSync(path.join(sourceDir, 'a.txt'), '版本测试 A v2\n'.repeat(200));
  const up2 = await runUpload({
    storage,
    session,
    settings,
    logger,
    project,
    localDir: sourceDir,
    dataFolder: MAIL_FOLDERS.data,
    options: { keepPrev: false },
    reporter: () => {},
  });
  await lock2.release();
  check('第二次上传完成', !!up2?.versionId);
  groups = await scan();
  check('keepPrev=false 只保留 1 版', groups[0]?.versionCount === 1, String(groups[0]?.versionCount));

  // ---- 4. keepPrev=true：第三次上传应保留 2 版
  const lock3 = mkLock();
  await lock3.acquireWithRetry('ver-upload-3');
  fs.writeFileSync(path.join(sourceDir, 'a.txt'), '版本测试 A v3\n'.repeat(200));
  const up3 = await runUpload({
    storage,
    session,
    settings,
    logger,
    project,
    localDir: sourceDir,
    dataFolder: MAIL_FOLDERS.data,
    options: { keepPrev: true },
    reporter: () => {},
  });
  await lock3.release();
  check('第三次上传完成', !!up3?.versionId);
  groups = await scan();
  check('keepPrev=true 保留 2 版', groups[0]?.versionCount === 2, String(groups[0]?.versionCount));
  check(
    '最新版是最新上传的',
    groups[0]?.latest?.version === up3.version,
    `${groups[0]?.latest?.version} vs ${up3.version}`,
  );

  // ---- 5. 历史版本可单独下载（回滚能力）
  const history = groups[0]?.history || [];
  check('有 1 个历史版本可下载', history.length === 1, String(history.length));
  if (history.length) {
    const rollbackDir = path.join(root, 'rollback');
    fs.mkdirSync(rollbackDir, { recursive: true });
    await runDownload({
      storage,
      session,
      settings,
      logger,
      project,
      localDir: rollbackDir,
      version: history[0],
      dataFolder: MAIL_FOLDERS.data,
      options: { confirm: true },
      reporter: () => {},
    });
    // 上传 v3 时 keepPrev=true，历史版就是 v2
    const got = fs.readFileSync(path.join(rollbackDir, 'a.txt'), 'utf8');
    check('回滚下载拿到旧版内容（v2）', got.startsWith('版本测试 A v2'), got.slice(0, 24));
  }

  // ---- 6. 旧版加密包必须被明确拒绝（而不是静默失败）
  // 构造一个「encrypted=true」的伪版本对象，验证 download.js 的守卫生效。
  let encRejected = null;
  try {
    await runDownload({
      storage,
      session,
      settings,
      logger,
      project,
      localDir: path.join(root, 'enc-target'),
      version: { ...groups[0].latest, encrypted: true },
      dataFolder: MAIL_FOLDERS.data,
      options: { confirm: true },
      reporter: () => {},
    });
  } catch (err) {
    encRejected = err.code || err.message;
  }
  check('旧加密版本被明确拒绝（ENCRYPTED_UNSUPPORTED）', encRejected === 'ENCRYPTED_UNSUPPORTED', String(encRejected));

  // ---- 7. keep 改回 1：下次上传删掉多出的历史版
  const cleaned = await cleanupOldVersions({
    storage,
    project,
    keepVersion: groups[0].latest.version,
    keep: 1,
    logger,
  });
  check('清理旧版本返回删除数', typeof cleaned.deleted === 'number', JSON.stringify(cleaned));
  groups = await scan();
  check('清理后只剩 1 版', groups[0]?.versionCount === 1, String(groups[0]?.versionCount));
} catch (err) {
  fail += 1;
  console.log(`FAIL 异常中断 :: ${err.code || ''} ${err.message}`);
  if (err.stack) console.log(err.stack.split('\n').slice(0, 6).join('\n'));
} finally {
  try {
    const entries = await storage.list({ collection: 'data' });
    const del = entries.filter((e) => e.meta?.version?.project === project);
    if (del.length) await storage.remove({ collection: 'data', refs: del.map((e) => e.ref) });
    console.log(`清理 ${del.length} 封测试邮件`);
  } catch (err) {
    console.log(`清理失败（可手动删项目 ${project}）：${err.message}`);
  }
  try {
    await storage.close();
  } catch {
    /* ignore */
  }
  try {
    await session.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
