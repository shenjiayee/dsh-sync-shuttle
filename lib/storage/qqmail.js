// 存储适配器：qqmail（腾讯 QQ 邮箱）。
//
// 名字叫 qqmail 而不是 imap，是刻意的：这个实现依赖的是**腾讯 QQ 邮箱的实测行为**，
// 不是 IMAP 协议通用要求：
//   · 读报文必须用 seq，UID 一律返回空
//   · 同连接 append 后 EXISTS 不刷新，必须 close + 重新 SELECT
//   · INTERNALDATE 是唯一可信的服务器时间（客户端时钟可能差几分钟）
//   · 单封附件硬上限 ≈51 MiB，超了报 TOOBIG
//   · 自定义头值必须纯 ASCII（否则被 RFC 2047 编码且 mailparser 不解码）
//   · 非空文件夹不能 DELETE
//
// 网易 163 / 126 / yeah 走同一套协议栈、共用本实现，但**未在真机实测**。
//
// 本文件是「adapter 契约 ↔ 具体实现」的翻译层：
//   上层只看到 collection / meta / body / ref
//   这里负责把 collection 映射到文件夹、把 meta 编进邮件头与正文、把 ref 映射成 seq

import { MAIL_FOLDERS, DEFAULTS, resolveMailFolders } from '../paths.js';
import { buildRawMessage, LIMITS } from '../builder.js';
import {
  buildSubject,
  buildHeaders,
  buildManifestBody,
  readDataHeaders,
  buildConfigSubject,
  buildConfigHeaders,
  readConfigHeaders,
  parseManifestBody,
} from '../envelope.js';
import { describeImapError } from '../mail.js';
import { simpleParser } from 'mailparser';
import { sha256Buffer } from '../util.js';

/**
 * 分卷大小：adapter 的固定常量，不再由用户配置。
 *
 * 依据：腾讯 IMAP 单封附件上限 ≈51 MiB（raw ≈68.9 MiB），52 MiB 起报 TOOBIG。
 * 取 40 MiB 留 11 MiB 余量——贴着上限用必然在某次附件编码膨胀时炸掉。
 */
export const QQMAIL_VOLUME_BYTES = 40 * 1024 * 1024;

/** 单封附件硬上限（实测值）。 */
export const QQMAIL_MAX_OBJECT_BYTES = 51 * 1024 * 1024;

/**
 * collection → 邮箱文件夹。
 * 锁不在这里，它由 lock* 原语独占管理。
 *
 * ⚠️ 具体文件夹名由 opts.folders 传入（见 resolveMailFolders），
 * 这样测试可以用 sync-shuttle-test-* 前缀，与生产数据彻底隔离。
 */
/** 附件文件名里的分卷后缀（下载端靠它认出正文附件）。 */
const ATTACHMENT_RE = /\.(zip|7z)\.\d+$/i;

/**
 * 创建一个 qqmail adapter。
 *
 * @param opts.makeSession     () => Promise<MailSession>（已 connect，调用方负责 close）
 * @param opts.folders         { data, config, lock } 实际使用的文件夹名（见 resolveMailFolders）
 * @param opts.logger
 * @param opts.capacityBytes   容量基线（QQ 无 QUOTA，只能手填）
 */
export function createQqmailAdapter(opts = {}) {
  const { makeSession, logger, capacityBytes } = opts;

  // 文件夹名必须是显式传入的：默认用生产名，测试传带前缀的名字。
  // 刻意不做「悄悄回落到生产文件夹」——那正是要避免的事故。
  const folders = opts.folders || resolveMailFolders();
  const FOLDER_OF = Object.freeze({
    data: folders.data,
    config: folders.config,
  });
  const LOCK_FOLDER = folders.lock;

  /** 每个 adapter 实例自己持有一个会话，open() 时建立。 */
  let session = null;

  async function ensureSession() {
    if (session) return session;
    if (typeof makeSession !== 'function') {
      throw new Error('qqmail adapter 需要 makeSession 依赖');
    }
    session = await makeSession();
    return session;
  }

  function folderFor(collection) {
    const folder = FOLDER_OF[collection];
    if (!folder) throw new Error(`未知 collection：${collection}（只支持 data / config）`);
    return folder;
  }

  /**
   * 把一封邮件的头 + 正文还原成 { key, meta, body }。
   *
   * meta 的来源优先级：正文清单 > 自定义头。
   * 为什么正文优先：正文清单里带完整的 volumeList（每卷字节与哈希），
   * 而头里只有「这一封」的信息。正文解析失败时才降级到「仅凭头判断」。
   */
  function entryFromMessage(msg, collection) {
    // 服务器记录的创建时刻：QQ 上是邮件 INTERNALDATE。
    // 「哪个版本最新」由它决定，不能用客户端时钟。
    const createdAtMs = msg.internalDate instanceof Date ? msg.internalDate.getTime() : 0;

    if (collection === 'config') {
      const cfg = readConfigHeaders(msg.headers);
      if (!cfg) return null;
      return {
        ref: String(msg.seq),
        key: cfg.machineId,
        sizeBytes: 0,
        createdAtMs,
        meta: {
          version: {
            project: null,
            version: cfg.at,
            versionId: cfg.machineId,
            total: 1,
            archiveBytes: 0,
            archiveSha256: cfg.sha256 || '',
            sourceFiles: 0,
            sourceBytes: 0,
            kind: 'config',
            machineId: cfg.machineId,
            hostname: cfg.hostname,
          },
          volume: { index: 1, bytes: 0, sha256: cfg.sha256 || '' },
        },
        _seq: msg.seq,
      };
    }

    const meta = readDataHeaders(msg.headers);
    if (!meta) return null;
    return {
      ref: String(msg.seq),
      key: `${meta.project}\u0000${meta.version}`,
      sizeBytes: meta.volumeBytes,
      createdAtMs,
      meta: {
        version: {
          project: meta.project,
          version: meta.version,
          versionId: meta.versionId,
          total: meta.total,
          archiveBytes: meta.archiveBytes,
          archiveSha256: meta.archiveSha256,
          sourceFiles: meta.sourceFiles,
          sourceBytes: meta.sourceBytes,
          encrypted: meta.encrypted,
          keepPrev: meta.keepPrev,
        },
        volume: {
          index: meta.index,
          bytes: meta.volumeBytes,
          sha256: meta.volumeSha256,
        },
      },
      _seq: msg.seq,
    };
  }

  const adapter = {
    id: 'qqmail',
    displayName: 'QQ 邮箱（IMAP）',
    volumeBytes: QQMAIL_VOLUME_BYTES,
    maxObjectBytes: QQMAIL_MAX_OBJECT_BYTES,

    async open() {
      await ensureSession();
      return adapter;
    },

    async close() {
      const s = session;
      session = null;
      if (s) {
        try {
          await s.close();
        } catch {
          /* ignore */
        }
      }
    },

    async ping() {
      try {
        const s = await ensureSession();
        const folders = await s.listFolders();
        return {
          ok: true,
          detail: {
            folders: folders.length,
            dataFolderExists: folders.includes(FOLDER_OF.data),
            capabilities: s.capabilities(),
          },
        };
      } catch (err) {
        return { ok: false, detail: { message: describeImapError(err) } };
      }
    },

    /**
     * 写入一个对象（一个分卷）。
     * @param opts.key   逻辑键（这里用项目+版本，仅用于人读与调试）
     * @param opts.meta  必须符合契约结构
     * @param opts.body  分卷字节（Buffer）
     */
    async put({ collection, key, meta, body }) {
      const folder = folderFor(collection);
      const s = await ensureSession();
      const conn = s.conn || {};

      let raw;
      if (collection === 'config') {
        const at = meta.version.version;
        raw = await buildRawMessage({
          from: conn.account || '',
          to: conn.account || '',
          subject: buildConfigSubject({
            machineId: meta.version.machineId,
            hostname: meta.version.hostname,
            at,
          }),
          headers: buildConfigHeaders({
            machineId: meta.version.machineId,
            hostname: meta.version.hostname,
            at,
            sha256: meta.volume.sha256,
          }),
          text:
            `machine=${meta.version.machineId}\nhost=${meta.version.hostname}\nat=${at}\n` +
            `bytes=${body.length}\nsha256=${meta.volume.sha256}\n`,
          attachments: [
            { filename: 'projects.json', content: body, contentType: 'application/json' },
          ],
        });
      } else {
        const v = meta.version;
        const vol = meta.volume;
        // 单封硬上限由 adapter 自己判断——只有它知道后端能装多大
        if (body.length > adapter.maxObjectBytes) {
          const err = new Error(
            `第 ${vol.index} 卷 ${body.length} 字节超过单封上限 ${adapter.maxObjectBytes} 字节`,
          );
          err.code = 'OBJECT_TOO_LARGE';
          throw err;
        }
        raw = await buildRawMessage({
          from: conn.account || '',
          to: conn.account || '',
          subject: buildSubject({
            project: v.project,
            version: v.version,
            index: vol.index,
            total: v.total,
          }),
          headers: buildHeaders({
            project: v.project,
            version: v.version,
            versionId: v.versionId,
            index: vol.index,
            total: v.total,
            volumeBytes: vol.bytes,
            volumeSha256: vol.sha256,
            archiveBytes: v.archiveBytes,
            archiveSha256: v.archiveSha256,
            sourceBytes: v.sourceBytes,
            sourceFiles: v.sourceFiles,
            encrypted: Boolean(v.encrypted),
            keepPrev: Boolean(v.keepPrev),
          }),
          text: buildManifestBody({
            project: v.project,
            version: v.version,
            versionId: v.versionId,
            total: v.total,
            compression: v.compression || 'zip deflate',
            encrypted: Boolean(v.encrypted),
            topDir: v.topDir || '',
            sourceFiles: v.sourceFiles,
            sourceBytes: v.sourceBytes,
            archiveBytes: v.archiveBytes,
            archiveSha256: v.archiveSha256,
            created: v.created,
            volumes: v.volumes || [vol],
          }),
          attachments: [
            {
              filename: `${v.versionId}.zip.${String(vol.index).padStart(3, '0')}`,
              content: body,
            },
          ],
        });
      }

      if (raw.length > LIMITS.rawBytes) {
        const err = new Error(
          `报文 ${raw.length} 字节超过服务器上限 ${LIMITS.rawBytes} 字节`,
        );
        err.code = 'OBJECT_TOO_LARGE';
        throw err;
      }

      await s.ensureFolder(folder);
      // ⚠️ append 抛异常也可能已写成（实测踩过），所以不靠返回值判断成功，
      //    真正的判据是调用方随后的回读校验。
      try {
        await s.appendRaw(folder, raw);
      } catch (err) {
        logger?.warn('APPEND 报错，继续由回读校验判定', { message: describeImapError(err) });
      }

      // 刻意**不**在这里回读定位 ref：
      //   1. list() 内部要 close + 重新 SELECT 并 fetch('1:*')，每写一卷扫一次全表，
      //      100 卷的包会做 100 次全量扫描——性能灾难。
      //   2. 「写入成功」不等于「读得回来」，这是本设计的核心论断（§10.3 CP2）。
      //      put 若承诺「立刻能读回」，等于把不可靠假设藏进接口。
      //   3. seq 是会话内易变量，此刻拿到的 ref 到 verify 时多半已失效，返回它只会误导调用方。
      // 定位由调用方在「全部写完后」做一次 list() 统一解决。
      return { accepted: true };
    },

    /** 读一个对象：返回 meta 与分卷字节。 */
    async get({ collection, ref }) {
      const folder = folderFor(collection);
      const s = await ensureSession();
      const raw = await s.fetchRawBySeq(folder, Number(ref));
      const parsed = await simpleParser(raw);

      const attachment = (parsed.attachments || []).find((a) => ATTACHMENT_RE.test(a.filename || ''));
      const content = attachment
        ? Buffer.isBuffer(attachment.content)
          ? attachment.content
          : Buffer.from(attachment.content || '')
        : null;

      if (collection === 'config') {
        const json = (parsed.attachments || []).find(
          (a) => a.filename === 'projects.json' || /json$/i.test(a.filename || ''),
        );
        const body = json
          ? Buffer.isBuffer(json.content)
            ? json.content
            : Buffer.from(json.content || '')
          : Buffer.alloc(0);
        const sha256 = sha256Buffer(body);
        // 配置备份也要给出 meta：上层要用 archiveSha256 做回读校验，
        // 不能因为是「配置」就退化成 null。
        const cfg = readConfigHeaders(
          parsed.headers && typeof parsed.headers.get === 'function'
            ? Object.fromEntries(
                [...parsed.headers.entries()].map(([k, v]) => [String(k).toLowerCase(), String(v)]),
              )
            : parsed.headers,
        );
        return {
          key: cfg?.machineId || null,
          meta: {
            version: {
              project: null,
              version: cfg?.at || '',
              versionId: cfg?.machineId || '',
              total: 1,
              archiveBytes: body.length,
              archiveSha256: sha256,
              sourceFiles: 0,
              sourceBytes: body.length,
              kind: 'config',
              machineId: cfg?.machineId || '',
              hostname: cfg?.hostname || '',
            },
            volume: { index: 1, bytes: body.length, sha256 },
          },
          body,
          sha256,
        };
      }

      if (!content) {
        throw new Error(`第 ${ref} 封里找不到分卷附件`);
      }

      // meta 优先从正文清单还原（带完整 volumeList），失败再退回邮件头
      const headers = parsed.headers;
      const headerMeta = readDataHeaders(
        headers && typeof headers.get === 'function'
          ? Object.fromEntries(
              [...headers.entries()].map(([k, v]) => [String(k).toLowerCase(), String(v)]),
            )
          : headers,
      );
      const bodyText = parsed.text || '';
      const manifest = parseManifestBody(bodyText);

      const version = {
        project: headerMeta?.project ?? manifest.fields?.project ?? '',
        version: headerMeta?.version ?? manifest.fields?.version ?? '',
        versionId: headerMeta?.versionId ?? manifest.fields?.versionId ?? '',
        total: headerMeta?.total ?? Number(manifest.fields?.volumes) ?? 0,
        archiveBytes: headerMeta?.archiveBytes ?? Number(manifest.fields?.archiveBytes) ?? 0,
        archiveSha256: headerMeta?.archiveSha256 ?? manifest.fields?.archiveSha256 ?? '',
        sourceFiles: headerMeta?.sourceFiles ?? Number(manifest.fields?.sourceFiles) ?? 0,
        sourceBytes: headerMeta?.sourceBytes ?? Number(manifest.fields?.sourceBytes) ?? 0,
        encrypted: headerMeta?.encrypted ?? false,
        keepPrev: headerMeta?.keepPrev ?? false,
        // 完整的分卷清单（用于下载时逐卷校验与总量交叉核对）
        volumes: manifest.complete ? manifest.volumes : [],
      };
      const volume = {
        index: headerMeta?.index ?? 0,
        bytes: headerMeta?.volumeBytes ?? content.length,
        sha256: headerMeta?.volumeSha256 ?? '',
      };

      return { key: `${version.project}\u0000${version.version}`, meta: { version, volume }, body: content };
    },

    /** 列出一个 collection 里的所有对象。 */
    async list({ collection }) {
      const folder = folderFor(collection);
      const s = await ensureSession();
      const messages = await s.listMessages(folder);
      const out = [];
      for (const msg of messages) {
        const entry = entryFromMessage(msg, collection);
        if (entry) out.push(entry);
      }
      return out;
    },

    /** 删除若干对象（按 ref）。 */
    async remove({ collection, refs }) {
      const folder = folderFor(collection);
      const s = await ensureSession();
      const seqs = (refs || []).map((r) => Number(r)).filter((n) => Number.isFinite(n) && n > 0);
      if (!seqs.length) return { removed: 0 };
      await s.deleteBySeq(folder, seqs);
      return { removed: seqs.length };
    },

    // ── 锁原语 ────────────────────────────────────────────────────────
    //
    // 用一个专用文件夹当锁：CREATE 的原子性由服务器仲裁
    // （实测 3 连接并发 6 次 CREATE，恰好 1 个 created:true）。
    // 锁信息写在文件夹里的唯一一封邮件上。

    async lockTryCreate({ owner, nonce, ttlMs, op }) {
      const s = await ensureSession();
      const folder = LOCK_FOLDER;

      let created = false;
      try {
        const res = await s.client.mailboxCreate(folder);
        created = Boolean(res && res.created);
      } catch (err) {
        // 已存在时某些服务器会抛错而不是返回 created:false
        logger?.debug('mailboxCreate 抛错，按已存在处理', { message: describeImapError(err) });
        created = false;
      }
      if (!created) return { acquired: false };

      // 建成功 → 写锁信息 → 回读确认 nonce（唯一可信的成功判据）
      const raw = await buildRawMessage({
        from: s.conn?.account || '',
        to: s.conn?.account || '',
        subject: `[SYNC-SHUTTLE-LOCK] ${owner} ${op || ''}`.trim(),
        headers: {
          'X-Sync-Shuttle-Lock-Owner': String(owner),
          'X-Sync-Shuttle-Lock-Nonce': String(nonce),
          'X-Sync-Shuttle-Lock-At': new Date().toISOString(),
          'X-Sync-Shuttle-Lock-Ttl': String(Math.round(ttlMs)),
          'X-Sync-Shuttle-Lock-Op': String(op || '').replace(/[^\x20-\x7e]/g, '').slice(0, 80),
        },
        text: `lock owner=${owner} nonce=${nonce}\n`,
      });
      try {
        await s.client.append(folder, raw, ['\\Seen']);
      } catch (err) {
        logger?.warn('APPEND 锁邮件报错，继续回读确认', { message: describeImapError(err) });
      }

      const state = await adapter.lockInspect();
      const ok = state?.holder?.nonce === nonce;
      if (!ok) {
        // 建了文件夹但锁信息没写对：清掉重来
        await adapter.lockRelease({ nonce, force: true });
        return { acquired: false };
      }
      return { acquired: true };
    },

    /**
     * 读锁状态。
     * ⚠️ serverTimeMs 用邮件 INTERNALDATE（服务器记录的写入时刻）——
     * 陈锁判定必须基于它，不能用客户端时钟。
     */
    async lockInspect() {
      const s = await ensureSession();
      const folder = LOCK_FOLDER;

      const folders = await s.listFolders();
      if (!folders.includes(folder)) return null;

      const messages = await s.listMessages(folder);
      if (!messages.length) return { holder: null, serverTimeMs: null };

      // 多封时以 INTERNALDATE 最新的为准，其余视为垃圾
      let best = null;
      for (const msg of messages) {
        const h = msg.headers || {};
        const get = (n) => String(h[String(n).toLowerCase()] || '').trim();
        const owner = get('x-sync-shuttle-lock-owner');
        const nonce = get('x-sync-shuttle-lock-nonce');
        if (!owner || !nonce) continue;
        const at = msg.internalDate instanceof Date ? msg.internalDate.getTime() : 0;
        if (!best || at > best.serverTimeMs) {
          best = {
            holder: {
              owner,
              nonce,
              op: get('x-sync-shuttle-lock-op'),
              ttlMs: Number(get('x-sync-shuttle-lock-ttl')) || 0,
            },
            serverTimeMs: at || null,
          };
        }
      }
      return best || { holder: null, serverTimeMs: null };
    },

    /** 续期：删旧锁信 + 重写一封（刷新 INTERNALDATE）。 */
    async lockRenew({ nonce }) {
      const s = await ensureSession();
      const folder = LOCK_FOLDER;

      const state = await adapter.lockInspect();
      if (!state?.holder) return { ok: false, reason: '锁已不存在（可能已被清理或抢走）' };
      if (state.holder.nonce !== nonce) {
        return { ok: false, reason: `锁已被 ${state.holder.owner} 抢走` };
      }

      // 删掉旧锁信，重写一封
      try {
        const messages = await s.listMessages(folder);
        if (messages.length) await s.deleteBySeq(folder, messages.map((m) => m.seq));
      } catch (err) {
        logger?.debug('清理旧锁信失败，继续重写', { message: describeImapError(err) });
      }

      const raw = await buildRawMessage({
        from: s.conn?.account || '',
        to: s.conn?.account || '',
        subject: `[SYNC-SHUTTLE-LOCK] ${state.holder.owner} renew`,
        headers: {
          'X-Sync-Shuttle-Lock-Owner': String(state.holder.owner),
          'X-Sync-Shuttle-Lock-Nonce': String(nonce),
          'X-Sync-Shuttle-Lock-At': new Date().toISOString(),
          'X-Sync-Shuttle-Lock-Ttl': String(state.holder.ttlMs || DEFAULTS.lockTtlMs),
          'X-Sync-Shuttle-Lock-Op': 'renew',
        },
        text: `renew nonce=${nonce}\n`,
      });
      try {
        await s.client.append(folder, raw, ['\\Seen']);
      } catch (err) {
        logger?.warn('续期 APPEND 报错，继续回读确认', { message: describeImapError(err) });
      }

      const after = await adapter.lockInspect();
      if (after?.holder?.nonce !== nonce) {
        return { ok: false, reason: '续期后回读不到自己的锁' };
      }
      return { ok: true };
    },

    /**
     * 释放锁。
     * ⚠️ 安全根基：nonce 不是自己的绝不删（锁可能已被别人抢走）。
     * @param opts.force 仅用于清理「空锁 / 自己的残留」，调用方已确认持有者身份
     */
    async lockRelease({ nonce, force = false }) {
      const s = await ensureSession();
      const folder = LOCK_FOLDER;

      const folders = await s.listFolders();
      if (!folders.includes(folder)) return { released: false, reason: 'NO_FOLDER' };

      const state = await adapter.lockInspect();
      if (state?.holder && !force && state.holder.nonce !== nonce) {
        return {
          released: false,
          reason: 'LOCK_TAKEN_OVER',
          owner: state.holder.owner,
        };
      }

      // DELETE 对非空文件夹会失败，必须先清空
      try {
        const messages = await s.listMessages(folder);
        if (messages.length) await s.deleteBySeq(folder, messages.map((m) => m.seq));
      } catch (err) {
        logger?.warn('清空锁文件夹失败', { message: describeImapError(err) });
      }
      try {
        await s.client.mailboxDelete(folder);
      } catch (err) {
        logger?.warn('删除锁文件夹失败', { message: describeImapError(err) });
        return { released: false, reason: 'DELETE_FAILED' };
      }
      return { released: true, reason: 'OK' };
    },

    /**
     * 容量。
     * QQ 不提供 QUOTA（getQuota() 返回 false），所以只能用手填基线；
     * exact=false 表示这是「本插件占用 vs 手填基线」，不是邮箱真实用量。
     */
    async capacity() {
      return {
        totalBytes: Number(capacityBytes) || DEFAULTS.capacityBytes,
        exact: false,
        note: '仅统计本插件占用（QQ 不提供 QUOTA，真实邮箱用量请在网页版查看）',
      };
    },
  };

  return adapter;
}
