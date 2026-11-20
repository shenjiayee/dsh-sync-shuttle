// 强制清空**测试**锁文件夹（仅用于清理测试崩溃残留）。
//
// ⚠️ 铁律：测试脚本永远不碰生产。
// 生产的 Sync-Shuttle-Lock 不会被动；如果生产锁真的卡住了，
// 应该由用户在插件界面或自己用 IMAP 客户端处理（那是生产操作，不属测试脚本职责）。
//
// 用法：node test/clear-lock.mjs [--dry]
const { imp, impNm, readCred, testFolders, assertNotProduction } = await import('./cred.mjs');
const { ImapFlow } = await impNm('imapflow/dist/esm/imap-flow.js');
const { MAIL_FOLDERS: PROD_FOLDERS } = await imp('paths.js');

const dryRun = process.argv.includes('--dry');

// ── 安全闸门：目标必须是测试文件夹
const MAIL_FOLDERS = testFolders();
assertNotProduction(MAIL_FOLDERS);

console.log(`测试锁文件夹：${MAIL_FOLDERS.lock}`);
console.log(`生产锁文件夹（本脚本不会碰）：${PROD_FOLDERS.lock}`);
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

const folder = MAIL_FOLDERS.lock;
const list = await client.list();
if (!list.some((b) => b.path === folder)) {
  console.log(`锁文件夹 ${folder} 不存在，无需清理`);
} else {
  let lock = await client.getMailboxLock(folder);
  const total = Number(client.mailbox?.exists ?? 0);
  if (total > 0 && !dryRun) await client.messageDelete('1:*', { uid: false });
  lock.release();
  await client.mailboxClose();
  if (dryRun) {
    console.log(`[--dry] 将清理 ${folder}（${total} 封）`);
  } else {
    await client.mailboxDelete(folder);
    console.log(`已清理锁文件夹 ${folder}（删了 ${total} 封）`);
  }
}
await client.logout().catch(() => {});
client.close();
process.exit(0);
