// 存储适配器契约（adapter pattern）。
//
// 为什么要有这层：核心流程（打包 / 上传 / 回读校验 / 清单 / 下载 / 镜像 / 锁）
// 本来直接依赖 IMAP 的细节——seq、邮件头、文件夹 CREATE、51 MiB 上限。
// 这些是**腾讯 QQ 邮箱的实测行为**，不是 IMAP 协议通用要求。
// 把 QQ 的行为抽成一个名为 qqmail 的 adapter，核心流程只认下面这组方法，
// 以后加局域网 SMB（或任何别的后端）只需要再实现一遍本契约。
//
// ── 三条硬性要求（实现新 adapter 时必须遵守）────────────────────────
//
// 1. **meta 必须随每个对象走，不能每个版本只写一份清单。**
//    这是原设计的「护栏 3」：清单在每封邮件里完整冗余一份，删到只剩 1 封
//    仍知道应该有哪几卷。SMB 这类没有邮件头的后端，必须给**每个分片**
//    旁挂一份 meta（例如 <分片>.meta.json），否则某个元数据文件一丢，
//    整个版本就失联——比 IMAP 更脆弱。
//
// 2. **lockInspect() 必须回传服务器时间（serverTimeMs）。**
//    两台机器的客户端时钟可能差几分钟。陈锁判定必须用**服务器**记录的时间，
//    不能用本地 Date.now()，否则会误抢别人正在生效的锁。
//    IMAP 用邮件 INTERNALDATE；SMB 用锁文件的 mtime。两者都是服务器时钟。
//    拿不到服务器时间时返回 null，由上层按「无法判定 → 当作活跃」处理。
//
// 3. **ref 只在一次会话内有效，不得跨会话持久化。**
//    IMAP 的 seq 会随删信漂移（实测 UID 又读不回来）；SMB 的路径看似稳定，
//    但为了统一语义，仍按「一次会话内有效」对待。上层的重试必须重新 list()。
//
// ── 接口 ────────────────────────────────────────────────────────────
//
// {
//   id: 'qqmail',                       // adapter 标识
//   displayName: 'QQ 邮箱',
//
//   // 分卷大小：adapter 的固定常量，不可由用户配置。
//   // 理由：每个后端的合理值由它的硬限制决定（IMAP 51 MiB / SMB 几乎无限），
//   // 让用户手填只会制造「贴着上限用」的误配置。
//   volumeBytes: 40 * 1024 * 1024,
//
//   // 单个对象硬上限；null 表示不限制（SMB）
//   maxObjectBytes: 51 * 1024 * 1024,
//
//   async open()                                  // 建立会话/连接
//   async close()                                 // 释放
//   async ping()                                  // => { ok, detail }
//
//   async put({ collection, key, meta, body })    // => { accepted: true }
//   async get({ collection, ref })                // => { key, meta, body }
//   async list({ collection })                    // => [{ ref, key, meta, sizeBytes, createdAtMs }]
//   async remove({ collection, refs })            // => { removed }
//
//   ⚠️ list() 必须为每个对象给出 createdAtMs —— 服务器记录的创建时刻（毫秒）。
//      上层要用它决定「哪个版本最新」并显示上传时间。不能用客户端写入时刻代替：
//      两台机器时钟可能不一致，而「最新版本」的判定必须两边算出来一致。
//      IMAP = 邮件 INTERNALDATE；SMB = 文件 mtime。拿不到时给 0（上层会排到最后）。
//
//   ⚠️ put() **不返回 ref**，也不承诺「写完立刻读得到」。
//      原因：写入成功 ≠ 读得回来（本设计的核心论断，见说明书 §10.3 CP2）。
//      让 put 承诺可读，等于把不可靠假设藏进接口；而 ref 又是会话内易变量，
//      此刻返回的值到校验时多半已失效。定位由调用方在全部写完后 list() 一次解决。
//
//   // 锁：只做 4 个原子原语，重试/排队/心跳/nonce 校验在 lib/lease.js
//   async lockTryCreate({ owner, nonce, ttlMs, op })  // => { acquired, holder? }
//   async lockInspect()                               // => { holder, serverTimeMs } | null
//   async lockRenew({ nonce })                        // => { ok }
//   async lockRelease({ nonce })                      // => { released, reason }
//
//   async capacity()   // => { totalBytes, exact, note }
// }
//
// collection 只允许两个值：
//   'data'   —— 项目分卷（所有机器共享读写）
//   'config' —— 本机配置备份（每台机器只读自己的）
//   （锁不占 collection，它由 lock* 原语独占管理）

/** 允许的 collection 值。 */
export const COLLECTIONS = Object.freeze(['data', 'config']);

/** meta 里必须有的字段（用于校验 adapter 实现是否漏写）。 */
const REQUIRED_VERSION_FIELDS = [
  'project',
  'version',
  'versionId',
  'total',
  'archiveBytes',
  'archiveSha256',
  'sourceFiles',
  'sourceBytes',
];

const REQUIRED_VOLUME_FIELDS = ['index', 'bytes', 'sha256'];

/**
 * 校验一个 meta 结构是否满足契约。
 * 供 adapter 自检与测试使用；核心层不依赖它（避免每次读写都跑一遍）。
 * @returns { ok: boolean, message?: string }
 */
export function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') return { ok: false, message: 'meta 不是对象' };
  const v = meta.version;
  const vol = meta.volume;
  if (!v || typeof v !== 'object') return { ok: false, message: 'meta.version 缺失' };
  if (!vol || typeof vol !== 'object') return { ok: false, message: 'meta.volume 缺失' };

  for (const f of REQUIRED_VERSION_FIELDS) {
    if (v[f] === undefined || v[f] === null) {
      return { ok: false, message: `meta.version.${f} 缺失` };
    }
  }
  for (const f of REQUIRED_VOLUME_FIELDS) {
    if (vol[f] === undefined || vol[f] === null) {
      return { ok: false, message: `meta.volume.${f} 缺失` };
    }
  }
  // 哈希必须是 64 位小写 hex —— 上传/下载都靠它做精确比对，
  // 多一个空格或大写都会导致「哈希不符」这种极难排查的故障。
  if (!/^[0-9a-f]{64}$/.test(String(v.archiveSha256))) {
    return { ok: false, message: 'meta.version.archiveSha256 不是 64 位小写 hex' };
  }
  if (!/^[0-9a-f]{64}$/.test(String(vol.sha256))) {
    return { ok: false, message: 'meta.volume.sha256 不是 64 位小写 hex' };
  }
  if (Number(vol.index) < 1) return { ok: false, message: 'meta.volume.index 必须从 1 开始' };
  if (Number(v.total) < 1) return { ok: false, message: 'meta.version.total 必须 >= 1' };
  return { ok: true };
}

/**
 * 断言一个 adapter 对象是否满足契约。
 * 工厂函数在返回前调用它，把「实现了但漏了方法」这类错误挡在启动期。
 */
export function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('storage adapter 必须是对象');
  }
  const methods = [
    'open',
    'close',
    'ping',
    'put',
    'get',
    'list',
    'remove',
    'lockTryCreate',
    'lockInspect',
    'lockRenew',
    'lockRelease',
    'capacity',
  ];
  for (const m of methods) {
    if (typeof adapter[m] !== 'function') {
      throw new Error(`storage adapter 缺少方法：${m}`);
    }
  }
  if (typeof adapter.id !== 'string' || !adapter.id) {
    throw new Error('storage adapter 缺少 id');
  }
  // volumeBytes 必须是正数常量；maxObjectBytes 允许 null（表示不限制）
  if (!Number.isFinite(adapter.volumeBytes) || adapter.volumeBytes <= 0) {
    throw new Error('storage adapter.volumeBytes 必须是正数');
  }
  if (adapter.maxObjectBytes !== null && !Number.isFinite(adapter.maxObjectBytes)) {
    throw new Error('storage adapter.maxObjectBytes 必须是正数或 null');
  }
  return adapter;
}
