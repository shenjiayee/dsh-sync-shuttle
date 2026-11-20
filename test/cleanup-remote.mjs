// 检查并清理**测试文件夹**里残留的测试数据。
//
// ⚠️ 铁律：测试脚本永远不碰生产。
// 本脚本只操作 Testing-Sync-Shuttle* 这一组（由 cred.mjs 的 testFolders() 给出），
// 并且在连接后、任何写操作之前用 assertNotProduction() 硬校验一次。
// 生产的 Sync-Shuttle / Sync-Shuttle-Config / Sync-Shuttle-Lock 不会被读写。
//
// 用法：node test/cleanup-remote.mjs
//   可加 --dry 只查看不删除
import fs from 'node:fs';

const { imp, impNm, readCred, testFolders, assertNotProduction } = await import('./cred.mjs');
const { ImapFlow } = await impNm('imapflow/dist/esm/imap-flow.js');
const { parseHeaderBlock } = await imp('mail.js');
const { readDataHeaders } = await imp('envelope.js');
const { MAIL_FOLDERS: PROD_FOLDERS } = await imp('paths.js');

const dryRun = process.argv.includes('--dry');

// ── 安全闸门：目标必须是测试文件夹
const MAIL_FOLDERS = testFolders();
assertNotProduction(MAIL_FOLDERS);

console.log(`测试文件夹：${MAIL_FOLDERS.data}`);
console.log(`生产文件夹（本脚本不会碰）：${PROD_FOLDERS.data}`);
if (dryRun) console.log('模式：只查看，不删除（--dry）');

const { account, token } = readCred();

const client = new ImapFlow({
  host: 'imap.qq.com',
  port: 993,
  secure: true,
  auth: { user: account, pass: token },
  logger: false,
});
client.on('error', () => {});
await client.connect();

const list = await client.list();
const existing = new Set(list.map((b) => b.path));

// 仅清理测试前缀下的邮件：项目名也必须带测试标记，双保险
const isTestProject = (name) => /^SS-(E2E|FIX)-/.test(String(name || ''));

// ── 1. 数据文件夹：只删测试项目名的邮件，其余只统计不动
if (existing.has(MAIL_FOLDERS.data)) {
  let lock = await client.getMailboxLock(MAIL_FOLDERS.data);
  const total = Number(client.mailbox?.exists ?? 0);
  const byProject = new Map();
  const testSeqs = [];
  for await (const msg of client.fetch('1:*', { headers: true }, { uid: false })) {
    const meta = readDataHeaders(parseHeaderBlock(msg.headers));
    if (!meta) continue;
    byProject.set(meta.project, (byProject.get(meta.project) || 0) + 1);
    if (isTestProject(meta.project)) testSeqs.push(msg.seq);
  }
  lock.release();
  await client.mailboxClose();

  console.log(`\n数据文件夹共 ${total} 封：`);
  for (const [p, n] of byProject) console.log(`  ${p}: ${n} 封`);

  if (testSeqs.length) {
    if (dryRun) {
      console.log(`\n[--dry] 将清理 ${testSeqs.length} 封测试邮件（SS-E2E-* / SS-FIX-*）`);
    } else {
      console.log(`\n清理 ${testSeqs.length} 封测试邮件（SS-E2E-* / SS-FIX-*）…`);
      lock = await client.getMailboxLock(MAIL_FOLDERS.data);
      await client.messageDelete(testSeqs.join(','), { uid: false });
      lock.release();
      await client.mailboxClose();
      console.log('已清理');
    }
  } else {
    console.log('\n没有残留的测试邮件');
  }
} else {
  console.log(`\n数据文件夹 ${MAIL_FOLDERS.data} 不存在（正常，测试跑过才会创建）`);
}

// ── 2. 配置备份文件夹：测试留下的备份一并清掉
// 原脚本漏了这一步，导致测试的配置备份会一直留在远端。
if (existing.has(MAIL_FOLDERS.config)) {
  let lock = await client.getMailboxLock(MAIL_FOLDERS.config);
  const n = Number(client.mailbox?.exists ?? 0);
  lock.release();
  await client.mailboxClose();
  if (n > 0) {
    if (dryRun) {
      console.log(`\n[--dry] 将清理配置备份 ${n} 封`);
    } else {
      lock = await client.getMailboxLock(MAIL_FOLDERS.config);
      await client.messageDelete('1:*', { uid: false });
      lock.release();
      await client.mailboxClose();
      console.log(`\n已清理配置备份 ${n} 封`);
    }
  } else {
    console.log('\n配置备份文件夹为空');
  }
} else {
  console.log('配置备份文件夹不存在（正常）');
}

// ── 3. 锁文件夹：它是临时产物，存在即残留，直接清掉
if (existing.has(MAIL_FOLDERS.lock)) {
  let lock = await client.getMailboxLock(MAIL_FOLDERS.lock);
  const n = Number(client.mailbox?.exists ?? 0);
  if (n > 0 && !dryRun) await client.messageDelete('1:*', { uid: false });
  lock.release();
  await client.mailboxClose();
  if (dryRun) {
    console.log(`\n[--dry] 将清理锁文件夹 ${MAIL_FOLDERS.lock}（${n} 封）`);
  } else {
    await client.mailboxDelete(MAIL_FOLDERS.lock);
    console.log(`\n已清理锁文件夹（${n} 封）`);
  }
} else {
  console.log('锁文件夹不存在（正常）');
}

await client.logout().catch(() => {});
client.close();
process.exit(0);
