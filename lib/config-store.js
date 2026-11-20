// 本机身份 + 配置的远端备份/恢复（§3.5）。
//
// 备份是「本机专属存档」：只用于这台机器自己恢复，不参与任何合并。
// 存放在独立的 collection（IMAP 上是 Sync-Shuttle-Config 文件夹），与数据物理隔离。
//
// 存储访问方式：优先通过 storage adapter 的 collection:'config'，
// 这样换后端（SMB 等）时本模块不用改。adapter 不可用时回退到直连 IMAP 的旧路径。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MAIL_FOLDERS, CONFIG_HEADERS, resolveMailFolders } from './paths.js';
import { randomMachineId, writeFileAtomic, sha256Buffer, humanBytes } from './util.js';
import { buildConfigSubject, buildConfigHeaders, readConfigHeaders } from './envelope.js';
import { buildRawMessage } from './builder.js';
import { describeImapError } from './mail.js';
import { simpleParser } from 'mailparser';

export function createMachineIdentity({ paths, logger }) {
  let cached = null;

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.machine, 'utf8'));
      if (parsed && typeof parsed.machineId === 'string' && parsed.machineId) {
        return {
          machineId: parsed.machineId,
          hostname: parsed.hostname || os.hostname(),
          createdAt: parsed.createdAt || new Date().toISOString(),
        };
      }
    } catch {
      /* 不存在或损坏 → 重新生成 */
    }
    return null;
  }

  function ensure() {
    if (cached) return cached;
    let identity = read();
    if (!identity) {
      identity = {
        machineId: randomMachineId(),
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      try {
        writeFileAtomic(paths.machine, JSON.stringify(identity, null, 2));
        logger?.info('已生成本机身份', { machineId: identity.machineId });
      } catch (err) {
        logger?.warn('写本机身份失败', { message: err.message });
      }
    } else if (identity.hostname !== os.hostname()) {
      // 主机名变了不算错，同步一下（显示用，不作主键）
      identity.hostname = os.hostname();
      try {
        writeFileAtomic(paths.machine, JSON.stringify(identity, null, 2));
      } catch {
        /* ignore */
      }
    }
    cached = identity;
    return identity;
  }

  return { ensure, peek: () => cached || read() };
}

/**
 * 从 mailparser 的 headers 里取配置备份时间。
 * mailparser 给的是 Map（键为小写头名），但也可能是普通对象，
 * 两种形态都要兼容，取值后 trim。
 */
function configAtHeader(headers) {
  if (!headers) return '';
  const key = CONFIG_HEADERS.at.toLowerCase();
  let value = '';
  if (typeof headers.get === 'function') {
    value = headers.get(key) ?? headers.get(CONFIG_HEADERS.at) ?? '';
  } else {
    value = headers[key] ?? headers[CONFIG_HEADERS.at] ?? '';
  }
  return String(value).trim();
}

/**
 * 配置备份器。
 *
 * @param opts.storage      storage adapter（新路径；给了就走它）
 * @param opts.makeSession  会话工厂（旧路径兜底）
 */
export function createConfigBackup({
  storage,
  makeSession,
  identity,
  logger,
  folder,
}) {
  // 实际使用的配置文件夹：优先用传入的（测试会传带前缀的），否则按环境解析
  const configFolder = folder || resolveMailFolders().config;
  /** 开一个临时会话执行 fn，结束一定关闭。 */
  async function withSession(fn) {
    if (typeof makeSession !== 'function') {
      const err = new Error('未配置邮箱连接');
      err.code = 'NO_MAILBOX';
      throw err;
    }
    const session = await makeSession();
    try {
      return await fn(session);
    } finally {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** 把一份 meta 构造成 adapter 需要的形状（config collection 专用）。 */
  function configMeta({ machineId, hostname, at, sha256, bytes }) {
    return {
      version: {
        project: null,
        // config 没有「项目版本」概念，用备份时刻承载排序语义
        version: at,
        versionId: machineId,
        total: 1,
        archiveBytes: bytes,
        archiveSha256: sha256,
        sourceFiles: 0,
        sourceBytes: bytes,
        kind: 'config',
        machineId,
        hostname,
      },
      volume: { index: 1, bytes, sha256 },
    };
  }

  /**
   * 把当前 bindings 备份到远端（单封、不分卷，<10 KB）。
   * 成功后删掉该 machineId 的旧备份。
   */
  async function backup(bindings) {
    const me = identity.ensure();
    const json = Buffer.from(JSON.stringify(bindings, null, 2), 'utf8');
    const sha256 = sha256Buffer(json);
    const at = new Date().toISOString();

    // ── 新路径：经 adapter
    if (storage) {
      await storage.put({
        collection: 'config',
        key: me.machineId,
        meta: configMeta({
          machineId: me.machineId,
          hostname: me.hostname,
          at,
          sha256,
          bytes: json.length,
        }),
        body: json,
      });

      // 回读校验：确认新备份在，且能解出正确 sha256
      const entries = await storage.list({ collection: 'config' });
      const mine = entries
        .filter((e) => e.meta?.version?.machineId === me.machineId)
        .sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0));

      if (!mine.length) return { ok: false, message: '配置备份写入后回读不到' };

      const newest = mine[0];
      if (newest.meta?.version?.archiveSha256 && newest.meta.version.archiveSha256 !== sha256) {
        return { ok: false, message: '配置备份回读校验失败（SHA-256 不符）' };
      }

      const stale = mine.slice(1).map((e) => e.ref);
      if (stale.length) {
        try {
          await storage.remove({ collection: 'config', refs: stale });
        } catch (err) {
          logger?.warn('清理旧配置备份失败（不影响新备份）', { message: err?.message || String(err) });
        }
      }

      logger?.info('配置已备份到远端', {
        machineId: me.machineId,
        projects: bindings.projects.length,
        bytes: humanBytes(json.length),
      });
      return { ok: true, at, count: bindings.projects.length, bytes: json.length, sha256 };
    }

    // ── 旧路径：直连 IMAP
    return withSession(async (session) => {
      const conn = session.conn || {};
      const raw = await buildRawMessage({
        from: conn.account || '',
        to: conn.account || '',
        subject: buildConfigSubject({ machineId: me.machineId, hostname: me.hostname, at }),
        headers: buildConfigHeaders({ machineId: me.machineId, hostname: me.hostname, at, sha256 }),
        text:
          `machine=${me.machineId}\nhost=${me.hostname}\nat=${at}\n` +
          `projects=${bindings.projects.length}\nbytes=${json.length}\nsha256=${sha256}\n`,
        attachments: [
          { filename: 'projects.json', content: json, contentType: 'application/json' },
        ],
      });

      await session.ensureFolder(configFolder);
      try {
        await session.appendRaw(configFolder, raw);
      } catch (err) {
        logger?.warn('APPEND 配置备份报错，继续回读确认', { message: describeImapError(err) });
      }

      const listed = await session.listMessages(configFolder);
      const mine = listed
        .map((m) => ({ ...m, cfg: readConfigHeaders(m.headers) }))
        .filter((m) => m.cfg && m.cfg.machineId === me.machineId)
        .sort((a, b) => (b.internalDate?.getTime() || 0) - (a.internalDate?.getTime() || 0));

      if (!mine.length) return { ok: false, message: '配置备份写入后回读不到' };
      const newest = mine[0];
      if (newest.cfg.sha256 && newest.cfg.sha256 !== sha256) {
        return { ok: false, message: '配置备份回读校验失败（SHA-256 不符）' };
      }

      const staleSeqs = mine.slice(1).map((m) => m.seq);
      if (staleSeqs.length) {
        try {
          await session.deleteBySeq(configFolder, staleSeqs);
        } catch (err) {
          logger?.warn('清理旧配置备份失败（不影响新备份）', { message: describeImapError(err) });
        }
      }

      logger?.info('配置已备份到远端', {
        machineId: me.machineId,
        projects: bindings.projects.length,
        bytes: humanBytes(json.length),
      });
      return { ok: true, at, count: bindings.projects.length, bytes: json.length, sha256 };
    });
  }

  /** 列出所有机器的配置备份（界面「查看远端备份列表」用）。 */
  async function list() {
    const me = identity.ensure();

    if (storage) {
      const entries = await storage.list({ collection: 'config' });
      return entries
        .filter((e) => e.meta?.version?.machineId)
        .map((e) => ({
          machineId: e.meta.version.machineId,
          hostname: e.meta.version.hostname,
          at: e.meta.version.version,
          sha256: e.meta.version.archiveSha256,
          // 对外仍叫 seq（界面与配置恢复都按它定位），实际是 adapter 的 ref
          seq: e.ref,
          ref: e.ref,
          isMine: e.meta.version.machineId === me.machineId,
          subject: '',
        }))
        .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    }

    return withSession(async (session) => {
      if (!(await session.folderExists(configFolder))) return [];
      const listed = await session.listMessages(configFolder);
      return listed
        .map((m) => ({ ...m, cfg: readConfigHeaders(m.headers) }))
        .filter((m) => m.cfg)
        .map((m) => ({
          machineId: m.cfg.machineId,
          hostname: m.cfg.hostname,
          at: m.cfg.at,
          sha256: m.cfg.sha256,
          seq: m.seq,
          ref: String(m.seq),
          isMine: m.cfg.machineId === me.machineId,
          subject: m.subject,
        }))
        .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    });
  }

  /** 下载并解析某份配置备份，返回 { bindings, at, sha256 }。 */
  async function download(seqOrRef) {
    if (storage) {
      const got = await storage.get({ collection: 'config', ref: seqOrRef });
      const content = Buffer.isBuffer(got?.body) ? got.body : Buffer.from(got?.body || []);
      const sha256 = sha256Buffer(content);
      let parsedJson;
      try {
        parsedJson = JSON.parse(content.toString('utf8'));
      } catch {
        throw new Error('备份内容不是合法 JSON');
      }
      return { bindings: parsedJson, at: '', sha256, bytes: content.length };
    }

    return withSession(async (session) => {
      const raw = await session.fetchRawBySeq(configFolder, seqOrRef);
      const parsed = await simpleParser(raw);
      const attachment = (parsed.attachments || []).find(
        (a) => a.filename === 'projects.json' || /json$/i.test(a.filename || ''),
      );
      if (!attachment) throw new Error('该备份邮件里没有找到 projects.json 附件');
      const content = Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(attachment.content || '');
      const sha256 = sha256Buffer(content);
      let parsedJson;
      try {
        parsedJson = JSON.parse(content.toString('utf8'));
      } catch {
        throw new Error('备份内容不是合法 JSON');
      }
      return {
        bindings: parsedJson,
        // 口径统一：优先用头里的 Config-At（备份时写入的那个时间），
        // 不一致时才回落到邮件 Date 头——两处时间戳差一天会让「最新一份」判错。
        at: configAtHeader(parsed.headers) || parsed.date?.toISOString?.() || '',
        sha256,
        bytes: content.length,
      };
    });
  }

  /** 找回本机最新一份备份（ensureBindings 用）。没有任何备份时返回 null。 */
  async function restoreMine() {
    const all = await list();
    const me = identity.ensure();
    const mine = all.find((m) => m.machineId === me.machineId);
    if (!mine) return null;
    const got = await download(mine.ref ?? mine.seq);
    // 记录里的 sha256 与附件实际 sha256 必须一致
    if (mine.sha256 && got.sha256 && mine.sha256 !== got.sha256) {
      throw new Error('远端备份校验失败：SHA-256 与记录不符');
    }
    return { bindings: got.bindings, at: mine.at, sha256: got.sha256 };
  }

  return { backup, list, download, restoreMine };
}
