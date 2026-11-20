// 联网端到端测试：真实 QQ 邮箱。
//
// ⚠️ 数据隔离：跑在 Testing- 前缀的独立文件夹里，
// 生产的 Sync-Shuttle / Sync-Shuttle-Config / Sync-Shuttle-Lock 一个都不会被碰。
// 即使测试中途崩溃、清理失败，残留也只在测试文件夹里。
// 用测试项目名 SS-E2E-<随机>，跑完自动清理。绝不打印授权码与完整邮箱。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// 必须从 profile 的 local-plugins 路径导入：那里向上能解析到 profile 的
// node_modules（imapflow / nodemailer / mailparser）。直接用 workspace 路径会
// ERR_MODULE_NOT_FOUND。具体路径由 cred.mjs 按 DSH_HOME / SS_PLUGIN_ROOT 推算。
const { imp, testFolders, assertNotProduction } = await import('./cred.mjs');

const util = await imp('util.js');
const { createSettings } = await imp('settings.js');
const { MailSession } = await imp('mail.js');
const { LeaseGuard } = await imp('lease.js');
const { createStorageAdapter } = await imp('storage/index.js');
// ⚠️ 测试永远不碰生产：testFolders() 内部已校验，这里再显式断言一次，
// 让「本脚本的目标是测试文件夹」在代码里一眼可见。
const MAIL_FOLDERS = testFolders();
assertNotProduction(MAIL_FOLDERS);
const { runUpload } = await imp('upload.js');
const { runDownload } = await imp('download.js');
const { aggregateVersions, groupByProject } = await imp('manifest.js');
const { createMachineIdentity } = await imp('config-store.js');
const { createLogger } = await imp('log.js');
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

// ---- 从凭据文件解析（路径由 SS_CRED 环境变量或默认位置决定，不打印内容）
const { readCred } = await import('./cred.mjs');
const { account, token } = readCred();

// 写到插件自己的凭据位置
const dataDir = 'C:\\Users\\sjy\\.dsh\\sync-shuttle';
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify({ account, token }, null, 2), {
  mode: 0o600,
});

const logger = createLogger({ logsDir: path.join(dataDir, 'logs'), level: 'warn' });
const settings = createSettings(
  { dataDir },
  { env: { ...process.env, DSH_HOME: 'C:\\Users\\sjy\\.dsh' }, logger },
);
const snap = settings.snapshot();
console.log(`账号 ${snap.accountMasked}  数据目录 ${dataDir}`);
check('凭据已就位', snap.hasToken === true);
check('snapshot 不含 token', !JSON.stringify(snap).includes(token));
// 归档后端已改为内置纯 JS ZIP，不再依赖本机 7-Zip。
// 这里改为断言「后端就绪且报告为 zip」，等价于原来「7z 路径存在」的前置检查。
check('归档后端就绪（内置 ZIP，无需本机 7-Zip）', String(snap.archiveBackend || '').includes('zip'), snap.archiveBackend);
check('已不需要 sevenZipPath 配置项', !('sevenZipPath' in snap));

const makeSession = async () => {
  const s = new MailSession(settings.connection(), { logger });
  await s.connect();
  return s;
};

// 存储 adapter：本套测试走新路径（adapter 而非裸 IMAP 会话）
const storage = createStorageAdapter('qqmail', {
  makeSession,
  logger,
  settings,
  folders: MAIL_FOLDERS,
  capacityBytes: snap.capacityBytes,
});

const project = `SS-E2E-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-online-'));
const sourceDir = path.join(root, 'source');
const targetDir = path.join(root, 'target');
fs.mkdirSync(path.join(sourceDir, '照片', '2026'), { recursive: true });
fs.mkdirSync(targetDir, { recursive: true });

fs.writeFileSync(path.join(sourceDir, '说明.txt'), '同步中转 端到端测试\n'.repeat(50));
fs.writeFileSync(path.join(sourceDir, '照片', '2026', 'x.bin'), util.randomNonce() + 'x'.repeat(1_200_000));
fs.writeFileSync(path.join(sourceDir, '空文件.txt'), '');
fs.writeFileSync(path.join(sourceDir, 'big.dat'), Buffer.from(util.randomNonce().repeat(6000)).subarray(0, 600_000));

const sourceFiles = util.walkFiles(sourceDir);
const sourceHash = new Map();
for (const f of sourceFiles) sourceHash.set(f.rel.replace(/\\/g, '/'), await util.sha256File(f.abs));
console.log(
  `源 ${sourceFiles.length} 个文件 ${util.humanBytes(sourceFiles.reduce((s, f) => s + f.bytes, 0))}，项目名 ${project}`,
);

let session;
try {
  session = await makeSession();
  check('IMAP 登录成功', true);
} catch (err) {
  check('IMAP 登录成功', false, err.message);
  process.exit(1);
}

try {
  // ⚠️ createMachineIdentity 返回的是包装器 {ensure, peek}，
  // 身份对象必须用 ensure() 取，直接用包装器会拿到 machineId === undefined。
  const identityStore = createMachineIdentity({ paths: settings.paths, logger });
  const me = identityStore.ensure();
  // 锁也走 adapter + 通用租约层（原 RemoteLock 已废弃）
  const mkLock = (extra = {}) =>
    new LeaseGuard(storage, {
      ttlMs: snap.lockTtlMs,
      heartbeatMs: snap.lockHeartbeatMs,
      machineId: me.machineId,
      hostname: me.hostname,
      logger,
      ...extra,
    });

  // ---- 抢锁
  const lock = mkLock();
  const got = await lock.acquireWithRetry('e2e-test');
  check('抢到远端锁', got.ok === true || !!got.nonce, JSON.stringify(got).slice(0, 120));
  // 并发保护检查：另一把锁用**不同 machineId** 模拟另一台机器，
  // 且只试一次（acquire 而非 acquireWithRetry），避免排队阻塞测试
  let busyBlocked = false;
  try {
    // 另一台机器用独立的 adapter 实例（模拟不同连接）
    const otherStorage = createStorageAdapter('qqmail', {
      makeSession,
      logger,
      settings,
      folders: MAIL_FOLDERS,
      capacityBytes: snap.capacityBytes,
    });
    await new LeaseGuard(otherStorage, {
      ttlMs: snap.lockTtlMs,
      machineId: 'MC-OTHER1',
      hostname: 'ANOTHER-PC',
      logger,
    }).acquire('from-other-machine');
    await otherStorage.close();
  } catch (err) {
    busyBlocked = err.code === 'LOCK_BUSY';
  }
  check('另一台机器抢锁被挡住（并发保护生效）', busyBlocked);

  // ---- 上传（走 adapter 新路径）
  const uploaded = await runUpload({
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
  check('上传完成', !!uploaded?.versionId, JSON.stringify(uploaded).slice(0, 200));
  check('卷数 >= 1', (uploaded?.volumeCount || 0) >= 1, String(uploaded?.volumeCount));
  check('回读校验通过（校验C）', uploaded?.verified === true, JSON.stringify(uploaded?.verified));

  // ---- 释放锁
  const rel = await lock.release();
  check('释放锁', rel.released === true, JSON.stringify(rel));

  // ---- 换一条新连接看清单（模拟另一台电脑）
  // 走 adapter：重新构造一个新的 adapter 实例，模拟「另一台机器/另一次会话」
  await session.close();
  session = await makeSession();
  const freshStorage = createStorageAdapter('qqmail', {
    makeSession,
    logger,
    settings,
    folders: MAIL_FOLDERS,
    capacityBytes: snap.capacityBytes,
  });
  const entries = await freshStorage.list({ collection: 'data' });
  const mine = entries.filter((e) => e.meta?.version?.project === project);
  check('新连接能看到刚上传的卷', mine.length >= 1, `${mine.length} 封`);

  const versions = aggregateVersions(entries);
  const groups = groupByProject(versions);
  const latest = groups[0]?.latest;
  check('清单聚合出该项目', groups.length === 1, String(groups.length));
  check('最新版状态完整', latest?.status === 'complete', latest?.status);
  check('最新版卷数正确', latest?.volumes?.length === uploaded.volumeCount, String(latest?.volumes?.length));
  await freshStorage.close();

  // ---- 下载并镜像
  const lock2 = mkLock();
  await lock2.acquireWithRetry('e2e-download');
  const dl = await runDownload({
    storage,
    session,
    settings,
    logger,
    project,
    localDir: targetDir,
    version: latest,
    dataFolder: MAIL_FOLDERS.data,
    options: { confirm: true, backupBeforeDelete: false },
    reporter: () => {},
  });
  check('下载完成', !!dl?.targetDir, JSON.stringify(dl).slice(0, 200));
  check('写出文件数一致', dl?.filesWritten === sourceFiles.length, `${dl?.filesWritten} vs ${sourceFiles.length}`);
  await lock2.release();

  // ---- 逐文件比对
  const targetFiles = util.walkFiles(targetDir);
  const bad = [];
  for (const f of targetFiles) {
    const rel2 = f.rel.replace(/\\/g, '/');
    const want = sourceHash.get(rel2);
    if (!want) {
      bad.push(`多出 ${rel2}`);
      continue;
    }
    if ((await util.sha256File(f.abs)) !== want) bad.push(`不符 ${rel2}`);
  }
  check('镜像后逐文件 SHA-256 全一致', bad.length === 0, bad.slice(0, 3).join('; '));
  check('空文件保留', fs.existsSync(path.join(targetDir, '空文件.txt')));

  // ---- 镜像删除：塞一个多余文件，再下一次应被删掉
  fs.writeFileSync(path.join(targetDir, '多余.txt'), 'should be deleted');
  const lock3 = mkLock();
  await lock3.acquireWithRetry('e2e-mirror');
  const dl2 = await runDownload({
    storage,
    session,
    settings,
    logger,
    project,
    localDir: targetDir,
    version: latest,
    dataFolder: MAIL_FOLDERS.data,
    options: { confirm: true, backupBeforeDelete: false },
    reporter: () => {},
  });
  await lock3.release();
  check(
    '镜像删除了多余文件',
    !fs.existsSync(path.join(targetDir, '多余.txt')),
    JSON.stringify(dl2?.deleted || []).slice(0, 120),
  );

  // ---- 清理远端测试数据
  await session.close();
  session = await makeSession();
  const lock4 = mkLock();
  await lock4.acquireWithRetry('e2e-cleanup');
  const last = await session.listMessages(MAIL_FOLDERS.data, { headers: true });
  const toDel = last.filter((m) => {
    const h = readDataHeaders(m.headers);
    return h && h.project === project;
  });
  if (toDel.length) {
    // deleteBySeq 内部已自带 withMailbox，外面不能再包一层（会触发不可重入断言）
    await session.deleteBySeq(
      MAIL_FOLDERS.data,
      toDel.map((m) => m.seq),
    );
  }
  await lock4.release();
  check('清理测试数据', true, `删除 ${toDel.length} 封`);
} catch (err) {
  fail += 1;
  console.log(`FAIL 异常中断 :: ${err.code || ''} ${err.message}`);
  if (err.stack) console.log(err.stack.split('\n').slice(0, 6).join('\n'));
} finally {
  try {
    await session?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
