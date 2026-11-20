// 离线：配置备份/恢复走 adapter 的契约验证（不联网）。
//
// 用一个内存假 adapter 驱动 config-store，覆盖三条关键行为：
//   1. backup() 写入后回读校验 sha256，不符要报错
//   2. 同一 machineId 只保留最新一份，旧的被删
//   3. restoreMine() 找回本机最新备份并校验 sha256
//
// 这些路径原本直连 IMAP、没有独立测试；改走 adapter 后必须证明语义没变。
import { pathToFileURL } from 'node:url';

const { imp } = await import('./cred.mjs');

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

const { createConfigBackup, createMachineIdentity } = await imp('config-store.js');
const util = await imp('util.js');
const path = await import('node:path');
const fs = await import('node:fs');
const os = await import('node:os');

// ── 内存假 adapter：只实现 config collection 需要的那几个方法
function createMemoryAdapter() {
  const store = []; // { ref, key, meta, body, createdAtMs }
  let seq = 0;
  return {
    id: 'memory',
    displayName: '内存',
    volumeBytes: 1024 * 1024,
    maxObjectBytes: null,
    async open() {},
    async close() {},
    async ping() {
      return { ok: true };
    },
    async put({ collection, key, meta, body }) {
      seq += 1;
      store.push({
        ref: `r${seq}`,
        key,
        meta,
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
        createdAtMs: Date.now() + seq, // 递增，保证「最新」判定稳定
      });
      return { accepted: true };
    },
    async get({ ref }) {
      const hit = store.find((e) => e.ref === ref);
      if (!hit) throw new Error(`找不到对象 ${ref}`);
      return { key: hit.key, meta: hit.meta, body: hit.body };
    },
    async list() {
      return store.map((e) => ({
        ref: e.ref,
        key: e.key,
        meta: e.meta,
        sizeBytes: e.body.length,
        createdAtMs: e.createdAtMs,
      }));
    },
    async remove({ refs }) {
      let removed = 0;
      for (const r of refs) {
        const i = store.findIndex((e) => e.ref === r);
        if (i >= 0) {
          store.splice(i, 1);
          removed += 1;
        }
      }
      return { removed };
    },
    // 锁原语本套测试用不到，给最小实现让 assertAdapter 通过
    async lockTryCreate() {
      return { acquired: true };
    },
    async lockInspect() {
      return null;
    },
    async lockRenew() {
      return { ok: true };
    },
    async lockRelease() {
      return { released: true, reason: 'OK' };
    },
    async capacity() {
      return { totalBytes: 0, exact: false, note: '' };
    },
    _store: store,
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const paths = {
  root,
  machine: path.join(root, 'machine.json'),
};

const identity = createMachineIdentity({ paths, logger });
const me = identity.ensure();
check('机器身份已生成', /^MC-/.test(me.machineId), me.machineId);

// ── 1. 备份并回读
const mem = createMemoryAdapter();
const cfg = createConfigBackup({ storage: mem, identity, logger });

const bindings1 = {
  version: 1,
  projects: [
    { name: '照片归档', localDir: 'D:\\work\\照片' },
    { name: '文档', localDir: 'D:\\work\\doc' },
  ],
};
const r1 = await cfg.backup(bindings1);
check('首次备份成功', r1.ok === true, JSON.stringify(r1));
check('备份返回项目数', r1.count === 2, String(r1.count));
check('备份返回 sha256', /^[0-9a-f]{64}$/.test(r1.sha256 || ''), r1.sha256);
check('写入了一条记录', mem._store.length === 1, String(mem._store.length));

// ── 2. 再备份一次：旧的必须被删，只留最新一份
const bindings2 = {
  version: 1,
  projects: [{ name: '照片归档', localDir: 'D:\\work\\照片2' }],
};
const r2 = await cfg.backup(bindings2);
check('第二次备份成功', r2.ok === true, JSON.stringify(r2));
check('同机只保留最新一份', mem._store.length === 1, String(mem._store.length));
check('保留的是最新那份', mem._store[0].meta.version.archiveSha256 === r2.sha256);

// ── 3. list / restoreMine
const listed = await cfg.list();
check('list 返回 1 条', listed.length === 1, String(listed.length));
check('list 标出是本机', listed[0].isMine === true);
check('list 带 machineId', listed[0].machineId === me.machineId, listed[0].machineId);

const restored = await cfg.restoreMine();
check('restoreMine 取回本机备份', Boolean(restored), JSON.stringify(restored)?.slice(0, 120));
check(
  '恢复内容与最后写入的一致',
  restored?.bindings?.projects?.length === 1 &&
    restored.bindings.projects[0].localDir === 'D:\\work\\照片2',
  JSON.stringify(restored?.bindings?.projects)?.slice(0, 120),
);
check('恢复带 at 时间', typeof restored.at === 'string', restored.at);

// ── 4. download 能解析 JSON
const got = await cfg.download(listed[0].ref ?? listed[0].seq);
check('download 解出合法 JSON', got.bindings?.projects?.length === 1);
check('download 重算 sha256 与备份一致', got.sha256 === r2.sha256);

// ── 5. 损坏内容必须被拒绝（不能静默当成合法配置）
{
  const bad = createMemoryAdapter();
  const cfg2 = createConfigBackup({ storage: bad, identity, logger });
  // 直接塞一个非法 JSON
  await bad.put({
    collection: 'config',
    key: 'X',
    meta: { version: { machineId: 'MC-X', archiveSha256: 'a'.repeat(64), version: 't' }, volume: {} },
    body: Buffer.from('这不是 JSON'),
  });
  const l = await cfg2.list();
  let threw = false;
  try {
    await cfg2.download(l[0].ref ?? l[0].seq);
  } catch (err) {
    threw = /合法 JSON/.test(err.message);
  }
  check('非 JSON 的备份被拒绝', threw);
}

// ── 6. 没有备份时 restoreMine 返回 null（不是抛错）
{
  const empty = createMemoryAdapter();
  const cfg3 = createConfigBackup({ storage: empty, identity, logger });
  const r = await cfg3.restoreMine();
  check('无备份时 restoreMine 返回 null', r === null, String(r));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
