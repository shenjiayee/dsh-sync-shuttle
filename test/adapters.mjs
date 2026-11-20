// 离线：存储适配器契约 + 通用租约层测试。
//
// 这一步不改动核心流程，所以本套测试只验证「新抽出来的那层自己是对的」：
//   · adapter 接口形状符合契约（缺方法要在启动期就报错，不是运行时）
//   · qqmail 的分卷常量符合实测依据（40 MiB / 51 MiB）
//   · meta 校验能挡住结构错误
//   · 租约状态机：陈锁判定必须用服务器时间、拿不到时间不许判陈、
//     release 不许删别人的锁、空锁要等满心跳周期
//
// 全程不联网：用一个内存假 adapter 驱动租约层。
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

const { assertAdapter, validateMeta, COLLECTIONS } = await imp('storage/adapter.js');
const { createStorageAdapter, STORAGE_KINDS } = await imp('storage/index.js');
const { QQMAIL_VOLUME_BYTES, QQMAIL_MAX_OBJECT_BYTES } = await imp('storage/qqmail.js');
const { LeaseGuard } = await imp('lease.js');

const MB = 1024 * 1024;

// ── 1. 契约校验：缺方法必须在构造期就炸，不能等到运行时
check('assertAdapter 拒绝空值', (() => {
  try {
    assertAdapter(null);
    return false;
  } catch {
    return true;
  }
})());

const missingMethod = {
  id: 'x',
  volumeBytes: 1024,
  maxObjectBytes: null,
  open() {},
  close() {},
  ping() {},
  put() {},
  get() {},
  list() {},
  remove() {},
  lockTryCreate() {},
  lockInspect() {},
  lockRenew() {},
  // 故意漏 lockRelease
  capacity() {},
};
check('assertAdapter 能发现缺失的方法', (() => {
  try {
    assertAdapter(missingMethod);
    return false;
  } catch (err) {
    return /lockRelease/.test(err.message);
  }
})());

check('assertAdapter 拒绝非正数 volumeBytes', (() => {
  try {
    assertAdapter({ ...missingMethod, lockRelease() {}, volumeBytes: 0 });
    return false;
  } catch (err) {
    return /volumeBytes/.test(err.message);
  }
})());

check('assertAdapter 允许 maxObjectBytes 为 null（无上限后端）', (() => {
  try {
    assertAdapter({ ...missingMethod, lockRelease() {}, maxObjectBytes: null });
    return true;
  } catch {
    return false;
  }
})());

// ── 2. 工厂
check('工厂能构造 qqmail', (() => {
  const a = createStorageAdapter('qqmail', { makeSession: async () => null });
  return a.id === 'qqmail' && typeof a.put === 'function';
})());

check('工厂对未知后端明确报错', (() => {
  try {
    createStorageAdapter('smb-not-yet', {});
    return false;
  } catch (err) {
    return /未知的存储后端/.test(err.message);
  }
})());

check('STORAGE_KINDS 里登记了 qqmail', Object.prototype.hasOwnProperty.call(STORAGE_KINDS, 'qqmail'));

// ── 3. qqmail 常量必须符合实测依据
check('分卷大小 = 40 MiB（51 MiB 上限留 11 MiB 余量）', QQMAIL_VOLUME_BYTES === 40 * MB, String(QQMAIL_VOLUME_BYTES / MB));
check('单封上限 = 51 MiB（实测值）', QQMAIL_MAX_OBJECT_BYTES === 51 * MB, String(QQMAIL_MAX_OBJECT_BYTES / MB));
check('分卷大小不超过单封上限', QQMAIL_VOLUME_BYTES <= QQMAIL_MAX_OBJECT_BYTES);

const qa = createStorageAdapter('qqmail', { makeSession: async () => null });
check('adapter 暴露 volumeBytes', qa.volumeBytes === QQMAIL_VOLUME_BYTES);
check('adapter 暴露 maxObjectBytes', qa.maxObjectBytes === QQMAIL_MAX_OBJECT_BYTES);
check('adapter 有 displayName', typeof qa.displayName === 'string' && qa.displayName.length > 0);

// ── 4. meta 校验
const goodMeta = {
  version: {
    project: '照片归档',
    version: '20261119T152041',
    versionId: 'SS-7K2M9Q',
    total: 2,
    archiveBytes: 1000,
    archiveSha256: 'a'.repeat(64),
    sourceFiles: 10,
    sourceBytes: 2000,
  },
  volume: { index: 1, bytes: 500, sha256: 'b'.repeat(64) },
};
check('合法 meta 通过校验', validateMeta(goodMeta).ok === true, validateMeta(goodMeta).message);
check('缺 version 被拒', validateMeta({ volume: goodMeta.volume }).ok === false);
check('缺 volume 被拒', validateMeta({ version: goodMeta.version }).ok === false);
check('大写哈希被拒（精确比对不允许大小写混用）', (() => {
  const bad = { ...goodMeta, volume: { ...goodMeta.volume, sha256: 'B'.repeat(64) } };
  return validateMeta(bad).ok === false;
})());
check('63 位哈希被拒（少一位必须报错）', (() => {
  const bad = { ...goodMeta, volume: { ...goodMeta.volume, sha256: 'b'.repeat(63) } };
  return validateMeta(bad).ok === false;
})());
check('卷号从 1 开始', (() => {
  const bad = { ...goodMeta, volume: { ...goodMeta.volume, index: 0 } };
  return validateMeta(bad).ok === false;
})());
check('COLLECTIONS 只有 data / config', COLLECTIONS.length === 2 && COLLECTIONS.includes('data') && COLLECTIONS.includes('config'));

// ── 5. 租约状态机（内存假 adapter）
const NOW = Date.now();

function makeFakeAdapter(overrides = {}) {
  const state = {
    tried: [],
    released: [],
    renewed: [],
    tryCreateResult: { acquired: false },
    inspectResult: null,
  };
  const fake = {
    id: 'fake',
    volumeBytes: MB,
    maxObjectBytes: null,
    async open() {},
    async close() {},
    async ping() {
      return { ok: true };
    },
    async put() {
      return { accepted: true };
    },
    async get() {
      return { key: null, meta: null, body: Buffer.alloc(0) };
    },
    async list() {
      return [];
    },
    async remove() {
      return { removed: 0 };
    },
    async lockTryCreate(opts) {
      state.tried.push(opts);
      return state.tryCreateResult;
    },
    async lockInspect() {
      return state.inspectResult;
    },
    async lockRenew(opts) {
      state.renewed.push(opts);
      return { ok: true };
    },
    async lockRelease(opts) {
      state.released.push(opts);
      return { released: true, reason: 'OK' };
    },
    async capacity() {
      return { totalBytes: 0, exact: false, note: '' };
    },
    ...overrides,
  };
  return { fake, state };
}

// 5.1 抢锁成功
{
  const { fake, state } = makeFakeAdapter({});
  state.tryCreateResult = { acquired: true };
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME', heartbeatMs: 60_000, ttlMs: 300_000 });
  const got = await lease.acquire('upload test');
  check('抢锁成功返回 lease', Boolean(got && got.nonce), JSON.stringify(got));
  check('抢锁把 owner/nonce/op 传给 adapter', state.tried.length === 1 && state.tried[0].owner === 'MC-ME');
  await lease.release();
}

// 5.2 别人占着 → LOCK_BUSY，且不删别人的锁
{
  const { fake, state } = makeFakeAdapter({});
  state.tryCreateResult = { acquired: false };
  state.inspectResult = {
    holder: { owner: 'MC-OTHER', nonce: 'n-other', op: 'upload x', ttlMs: 300_000 },
    // 服务器时间 = 刚刚 → 远未超期
    serverTimeMs: NOW - 1000,
  };
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME', heartbeatMs: 60_000, ttlMs: 300_000 });
  let err = null;
  try {
    await lease.acquire('upload mine');
  } catch (e) {
    err = e;
  }
  check('被别人占着报 LOCK_BUSY', err?.code === 'LOCK_BUSY', err?.code);
  check('LOCK_BUSY 带持有者信息', err?.detail?.owner === 'MC-OTHER', JSON.stringify(err?.detail));
  check('绝不删别人的活锁', state.released.length === 0, JSON.stringify(state.released));
}

// 5.3 陈锁 → 清理后重试（关键：判定用服务器时间）
{
  const { fake, state } = makeFakeAdapter({});
  state.tryCreateResult = { acquired: false };
  state.inspectResult = {
    holder: { owner: 'MC-OTHER', nonce: 'n-old', op: 'upload', ttlMs: 300_000 },
    // 服务器时间 = 10 分钟前，ttl 5 分钟 + 宽限 1 分钟 → 已超期
    serverTimeMs: NOW - 10 * 60_000,
  };
  const lease = new LeaseGuard(fake, {
    machineId: 'MC-ME',
    heartbeatMs: 60_000,
    ttlMs: 300_000,
    graceMs: 60_000,
  });
  let err = null;
  try {
    await lease.acquire('upload mine');
  } catch (e) {
    err = e;
  }
  check('超期锁判为陈锁并清理', err?.code === 'LOCK_STALE_CLEARED', err?.code);
  check('清理陈锁带 force', state.released.length === 1 && state.released[0].force === true);
}

// 5.4 拿不到服务器时间 → 不许判陈（这一条防的是误抢活锁）
{
  const { fake, state } = makeFakeAdapter({});
  state.tryCreateResult = { acquired: false };
  state.inspectResult = {
    holder: { owner: 'MC-OTHER', nonce: 'n-x', op: 'upload', ttlMs: 300_000 },
    serverTimeMs: null, // 服务器时间拿不到
  };
  const lease = new LeaseGuard(fake, {
    machineId: 'MC-ME',
    heartbeatMs: 60_000,
    ttlMs: 300_000,
    graceMs: 60_000,
  });
  let err = null;
  try {
    await lease.acquire('upload mine');
  } catch (e) {
    err = e;
  }
  check('拿不到服务器时间时按活跃处理（报 LOCK_BUSY 而非清锁）', err?.code === 'LOCK_BUSY', err?.code);
  check('拿不到时间绝不清理别人的锁', state.released.length === 0, JSON.stringify(state.released));
}

// 5.5 自己的残留锁 → 直接清
{
  const { fake, state } = makeFakeAdapter({});
  state.tryCreateResult = { acquired: false };
  state.inspectResult = {
    holder: { owner: 'MC-ME', nonce: 'n-mine-old', op: 'upload', ttlMs: 300_000 },
    serverTimeMs: NOW - 1000,
  };
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME', heartbeatMs: 60_000, ttlMs: 300_000 });
  let err = null;
  try {
    await lease.acquire('upload mine');
  } catch (e) {
    err = e;
  }
  check('自己的残留锁被清理', err?.code === 'LOCK_OWN_RESIDUE', err?.code);
  check('清理自己的残留带 force', state.released.length === 1 && state.released[0].force === true);
}

// 5.6 空锁必须等满一个心跳周期才清（防止误抢「刚建好还没写锁信」的活锁）
{
  const { fake, state } = makeFakeAdapter({});
  state.tryCreateResult = { acquired: false };
  state.inspectResult = { holder: null, serverTimeMs: null };
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME', heartbeatMs: 60_000, ttlMs: 300_000 });
  let first = null;
  try {
    await lease.acquire('upload mine');
  } catch (e) {
    first = e;
  }
  check('第一次遇到空锁只等待、不清理', first?.code === 'LOCK_EMPTY_WAIT', first?.code);
  check('第一次遇到空锁时没删任何东西', state.released.length === 0);

  // 再试一次，仍未到心跳周期 → 继续等
  let second = null;
  try {
    await lease.acquire('upload mine');
  } catch (e) {
    second = e;
  }
  check('未满心跳周期仍只等待', second?.code === 'LOCK_EMPTY_WAIT', second?.code);
  check('未满周期仍未清锁', state.released.length === 0);
}

// 5.7 release 遇到锁已易主 → 什么都不删
{
  const { fake, state } = makeFakeAdapter({
    async lockRelease() {
      return { released: false, reason: 'LOCK_TAKEN_OVER', owner: 'MC-OTHER' };
    },
  });
  state.tryCreateResult = { acquired: true };
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME', heartbeatMs: 60_000, ttlMs: 300_000 });
  await lease.acquire('upload');
  const res = await lease.release();
  check('锁易主时 release 报 LOCK_TAKEN_OVER', res.reason === 'LOCK_TAKEN_OVER', JSON.stringify(res));
  check('锁易主时 released=false', res.released === false);
}

// 5.8 status 只读且不清理
{
  const { fake, state } = makeFakeAdapter({});
  state.inspectResult = {
    holder: { owner: 'MC-OTHER', nonce: 'n', op: 'download', ttlMs: 300_000 },
    serverTimeMs: NOW - 5000,
  };
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME', heartbeatMs: 60_000, ttlMs: 300_000 });
  const st = await lease.status();
  check('status 报出持有者', st.holder?.owner === 'MC-OTHER');
  check('status 判定非空闲', st.free === false);
  check('status 不删任何东西', state.released.length === 0);
  check('status 标出不是我的锁', st.isMine === false);
}

// 5.9 空闲状态
{
  const { fake, state } = makeFakeAdapter({});
  state.inspectResult = null;
  const lease = new LeaseGuard(fake, { machineId: 'MC-ME' });
  const st = await lease.status();
  check('没锁时 status 报空闲', st.free === true && st.holder === null);
}

console.log(`\n== ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
