// 离线：IMAP 连接失效后的自动恢复（不联网）。
//
// 背景：页面打开后闲置几分钟，QQ 会断开 IMAP 连接。
// 此时 adapter 内部的 session 对象还在，但底层 client.usable=false。
// 原实现只判 `if (session) return session`，于是继续用死连接，
// 报 [NoConnection] Connection not available，界面显示「读取远端失败」。
//
// 修复后有两层保护：
//   1. ensureSession() 检查 client.usable，失效则丢弃重建
//   2. withReconnect() 在操作抛连接类错误时，丢弃会话、重连、重试一次
//
// 本测试用假 makeSession 验证这两层都生效。
import fs from 'node:fs';
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
    console.log(`FAIL ${name}${extra ? ' :: ' + String(extra).slice(0, 220) : ''}`);
  }
};

const { createQqmailAdapter } = await imp('storage/qqmail.js');
const { MAIL_FOLDERS } = await imp('paths.js');

// ── 构造可控的假 MailSession
function makeFakeSessionFactory() {
  const created = [];
  // 每个会话有自己的 usable 状态：模拟「旧连接断了，新建的连接是好的」
  let failNextWith = null;

  const factory = async () => {
    const state = { usable: true };
    const s = {
      conn: { account: 'a@b.c', token: 'x' },
      _state: state,
      client: {
        get usable() {
          return state.usable;
        },
      },
      closed: false,
      async close() {
        this.closed = true;
      },
      async listFolders() {
        if (failNextWith) {
          const e = failNextWith;
          failNextWith = null;
          throw e;
        }
        if (!state.usable) {
          const e = new Error('Connection not available');
          e.code = 'NoConnection';
          throw e;
        }
        return [MAIL_FOLDERS.data, MAIL_FOLDERS.config];
      },
      async listMessages() {
        if (failNextWith) {
          const e = failNextWith;
          failNextWith = null;
          throw e;
        }
        if (!state.usable) {
          const e = new Error('Connection not available');
          e.code = 'NoConnection';
          throw e;
        }
        return [];
      },
      async fetchRawBySeq() {
        return Buffer.from('From: a\r\n\r\nx');
      },
      async deleteBySeq() {
        return true;
      },
      async ensureFolder() {
        return false;
      },
      async appendRaw() {
        return {};
      },
      capabilities() {
        return { IMAP4: true };
      },
    };
    created.push(s);
    return s;
  };

  return {
    factory,
    created,
    /** 让「当前最后一个」会话失效，模拟服务器断开 */
    breakCurrent() {
      const cur = created[created.length - 1];
      if (cur) cur._state.usable = false;
    },
    failOnce(err) {
      failNextWith = err;
    },
  };
}

// ── 1. 首次调用会建立会话
{
  const f = makeFakeSessionFactory();
  const adapter = createQqmailAdapter({
    makeSession: f.factory,
    folders: { data: MAIL_FOLDERS.data, config: MAIL_FOLDERS.config, lock: MAIL_FOLDERS.lock },
    capacityBytes: 1,
  });

  const list1 = await adapter.list({ collection: 'data' });
  check('首次 list 成功', Array.isArray(list1), typeof list1);
  check('建立了 1 个会话', f.created.length === 1, String(f.created.length));

  // 复用：同一会话，不重复建连
  await adapter.list({ collection: 'data' });
  check('连接可用时复用会话（未重复建连）', f.created.length === 1, String(f.created.length));
}

// ── 2. 连接失效后，ensureSession 应该重建
console.log('\n=== 连接失效后自动重建 ===');
{
  const f = makeFakeSessionFactory();
  const adapter = createQqmailAdapter({
    makeSession: f.factory,
    folders: { data: MAIL_FOLDERS.data, config: MAIL_FOLDERS.config, lock: MAIL_FOLDERS.lock },
    capacityBytes: 1,
  });

  await adapter.list({ collection: 'data' });
  check('初始建连 1 次', f.created.length === 1);

  // 模拟服务器断开：当前会话的 usable 变 false
  f.breakCurrent();

  let err = null;
  let result = null;
  try {
    result = await adapter.list({ collection: 'data' });
  } catch (e) {
    err = e;
  }

  check('连接失效后不抛 NoConnection（已自动重建）', err === null, err?.message);
  check('自动重建了新会话', f.created.length >= 2, `建连 ${f.created.length} 次`);
  check('旧会话被 close 掉', f.created[0].closed === true);
  check('返回结果正常', Array.isArray(result));
}

// ── 3. 操作中途抛 NoConnection → withReconnect 重试一次
console.log('\n=== 操作中途断连自动重试 ===');
{
  const f = makeFakeSessionFactory();
  const adapter = createQqmailAdapter({
    makeSession: f.factory,
    folders: { data: MAIL_FOLDERS.data, config: MAIL_FOLDERS.config, lock: MAIL_FOLDERS.lock },
    capacityBytes: 1,
  });

  await adapter.list({ collection: 'data' });
  const before = f.created.length;

  // 让下一次 listMessages 抛 NoConnection（模拟执行中连接被断）
  const e = new Error('Connection not available');
  e.code = 'NoConnection';
  f.failOnce(e);

  let err = null;
  let result = null;
  try {
    result = await adapter.list({ collection: 'data' });
  } catch (ex) {
    err = ex;
  }

  check('中途断连后重试成功', err === null, err?.message);
  check('重试时重建了连接', f.created.length > before, `${before} → ${f.created.length}`);
  check('拿到了结果', Array.isArray(result));
}

// ── 4. 业务错误不应重试（避免无意义重连）
console.log('\n=== 业务错误不重试 ===');
{
  const f = makeFakeSessionFactory();
  const adapter = createQqmailAdapter({
    makeSession: f.factory,
    folders: { data: MAIL_FOLDERS.data, config: MAIL_FOLDERS.config, lock: MAIL_FOLDERS.lock },
    capacityBytes: 1,
  });

  await adapter.list({ collection: 'data' });
  const before = f.created.length;

  const bizErr = new Error('Mailbox does not exist');
  bizErr.code = 'NONEXISTENT';
  f.failOnce(bizErr);

  let err = null;
  try {
    await adapter.list({ collection: 'data' });
  } catch (ex) {
    err = ex;
  }

  check('业务错误原样抛出', err && /does not exist/.test(err.message), err?.message);
  check('业务错误不触发重连', f.created.length === before, `${before} → ${f.created.length}`);
}

// ── 5. 源码级断言：两层保护都存在
console.log('\n=== 源码断言 ===');
{
  const src = fs.readFileSync('D:/dsh-project/sync-shuttle/lib/storage/qqmail.js', 'utf8');
  check('定义了 sessionUsable（检查 client.usable）', /function sessionUsable/.test(src));
  check('sessionUsable 里判断 client.usable', /s\.client\s*&&\s*s\.client\.usable/.test(src));
  check('ensureSession 会丢弃失效会话', /dropSession\('connection lost'\)/.test(src));
  check('定义了 withReconnect', /async function withReconnect/.test(src));
  check('识别 NoConnection 等连接类错误', /NoConnection\|Connection not available/.test(src));
  check('list 走 withReconnect', /withReconnect\('list'/.test(src));
  check('get 走 withReconnect', /withReconnect\('get'/.test(src));
  check('remove 走 withReconnect', /withReconnect\('remove'/.test(src));
  check('put.append 走 withReconnect', /withReconnect\('put\.append'/.test(src));
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
