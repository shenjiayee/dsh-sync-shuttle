// 【运维工具，不是测试】调试：比对邮件头里的分卷哈希与正文清单里的哈希，
// 定位下载校验失败原因。
//
// ⚠️ 本脚本只读（只 fetch，不写不删），默认查看**生产**文件夹——
// 因为它本就是用来排查真实同步故障的。这也是 test/ 目录下唯一允许读生产的脚本。
//
// 想查看测试文件夹的数据，加 --test。
const { imp, impNm, readCred, testFolders } = await import('./cred.mjs');
const { ImapFlow } = await impNm('imapflow/dist/esm/imap-flow.js');
const { MAIL_FOLDERS: PROD_FOLDERS } = await imp('paths.js');
const { parseHeaderBlock } = await imp('mail.js');
const { readDataHeaders, parseManifestBody } = await imp('envelope.js');

const useTest = process.argv.includes('--test');
const MAIL_FOLDERS = useTest ? testFolders() : PROD_FOLDERS;
console.log(`模式：${useTest ? '测试文件夹' : '生产文件夹（只读）'}（数据=${MAIL_FOLDERS.data}）`);

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
const lock = await client.getMailboxLock(MAIL_FOLDERS.data);
const total = Number(client.mailbox?.exists ?? 0);
console.log(`数据文件夹共 ${total} 封`);

let shown = 0;
for await (const msg of client.fetch('1:*', { headers: true, envelope: true, bodyParts: ['1'] }, { uid: false })) {
  const headers = parseHeaderBlock(msg.headers);
  const meta = readDataHeaders(headers);
  if (!meta) continue;
  if (shown >= 2) break;
  shown += 1;
  console.log(`\n--- seq=${msg.seq} 项目=${meta.project} 卷=${meta.index}/${meta.total}`);
  console.log(`头里的 volumeSha256 (${meta.volumeSha256.length} 字符) = ${meta.volumeSha256}`);
  console.log(`头里的 volumeBytes  = ${meta.volumeBytes}`);

  // 原始头里这一行的原文
  const rawHead = msg.headers.toString('utf8');
  const line = rawHead.split(/\r?\n/).find((l) => /volume-sha256/i.test(l));
  console.log(`原始头行 = ${JSON.stringify(line)}`);

  // 正文清单里的同卷哈希
  if (msg.bodyParts) {
    for (const [k, v] of msg.bodyParts) {
      const text = v.toString('utf8');
      const parsed = parseManifestBody(text);
      const v1 = parsed.volumes.find((x) => x.index === meta.index);
      console.log(`正文清单第 ${meta.index} 卷哈希 = ${v1 ? v1.sha256 : '(无)'}`);
      if (v1) {
        console.log(`两者相同？ ${v1.sha256 === meta.volumeSha256}`);
        console.log(`正文哈希长度 = ${v1.sha256.length}`);
      }
    }
  }
}
lock.release();
await client.logout().catch(() => {});
client.close();
process.exit(0);
