// IMAP 层：连接、读清单、写卷、删卷、文件夹管理。
//
// 这里是三个 QQ 坑的唯一收口处（说明书 §9.1）：
//   1. UID 不可靠 → 读报文一律用 seq（fetchOne(String(seq), {source:true})）
//   2. SIZE 是假的 → 体积/哈希一律来自自定义头，绝不读 size
//   3. EXISTS 不刷新 → 写完之后要读，必须 mailboxClose() 再重新 select
//
// 另外 getMailboxLock() 不可重入（持锁再取锁会永久死锁），
// 所以本模块用 withMailbox() 严格串行化，任何嵌套都会被断言拦住。

import { ImapFlow } from 'imapflow';

/** 把 imapflow 的报错整理成可读文字。 */
export function describeImapError(err) {
  if (!err) return '未知错误';
  const code = err.serverResponseCode || err.code || '';
  const map = {
    TOOBIG: '单封邮件超过服务器上限（实测 QQ 约 51 MiB 附件 / 69 MiB 报文）',
    ALREADYEXISTS: '文件夹已存在',
    APPENDLIMIT: '超过服务器公告的 APPEND 上限',
    AuthenticationFailed: '登录失败：检查邮箱地址与授权码（授权码不是登录密码）',
    NoMailboxSelected: '内部错误：未选中文件夹',
    DownloadOverflow: '内部错误：服务器报文长度谎报导致下载越界',
  };
  if (map[code]) return map[code];
  if (/auth/i.test(code) || /authentication/i.test(err.message || '')) {
    return '登录失败：检查邮箱地址与授权码，并确认已在邮箱设置里开启 IMAP';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(code) || /timeout|getaddrinfo/i.test(err.message || '')) {
    return '网络不可达：检查网络与防火墙';
  }
  return `${code ? `[${code}] ` : ''}${err.message || String(err)}`;
}

/** 解析原始头块（imapflow 的 headers 返回 Buffer）。只处理小文本，安全。 */
export function parseHeaderBlock(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const out = Object.create(null);
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) {
      // 折行续行。
      // ⚠️ 实测：nodemailer 写长头值时会把值整个折到下一行，
      // 于是这里首次拼接时 out[current] 还是空串。若无条件加空格，
      // 64 字符的 SHA-256 会变成 65 字符（前面多一个空格），
      // 导致下载校验「哈希不符」——排查了很久的真实坑。
      if (current) {
        const piece = line.trim();
        out[current] = out[current] ? `${out[current]} ${piece}` : piece;
      }
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
    current = key;
  }
  return out;
}

/** 取头值（大小写不敏感）。 */
export function headerGet(headers, name) {
  if (!headers) return '';
  return headers[String(name).toLowerCase()] || '';
}

/**
 * 一个 IMAP 会话。每次业务操作开一个，用完关掉。
 * 不做长连接：两台电脑偶尔同步，复用收益低，而长连接要处理掉线重连，风险更高。
 */
export class MailSession {
  constructor(conn, { logger } = {}) {
    this.conn = conn;
    this.logger = logger;
    this.client = null;
    this.selected = null;
    this.holdingLock = false;
  }

  async connect() {
    if (!this.conn.account || !this.conn.token) {
      throw new Error('未配置邮箱凭据：请在设置页填写邮箱地址与授权码');
    }
    const client = new ImapFlow({
      host: this.conn.imapHost,
      port: this.conn.imapPort,
      secure: this.conn.imapSecure !== false,
      auth: { user: this.conn.account, pass: this.conn.token },
      logger: false,
      socketTimeout: 120_000,
      greetingTimeout: 30_000,
    });
    // imapflow 会发 error 事件，不监听会因未捕获异常退出
    client.on('error', (err) => {
      this.logger?.warn('IMAP 连接错误', { message: describeImapError(err) });
    });
    await client.connect();
    this.client = client;
    return this;
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.selected = null;
    if (!client) return;
    try {
      if (client.usable) {
        try {
          if (this.selected) await client.mailboxClose();
        } catch {
          /* ignore */
        }
        await client.logout();
      }
    } catch {
      /* ignore */
    }
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }

  /** 确保文件夹存在。CREATE 幂等（已存在返回 created:false，不抛异常）。 */
  async ensureFolder(name) {
    const res = await this.client.mailboxCreate(name);
    const created = Boolean(res && res.created);
    if (created) this.logger?.info('已创建邮箱文件夹', { folder: name });
    return created;
  }

  /** 列出所有文件夹名。 */
  async listFolders() {
    const list = await this.client.list();
    return (list || []).map((b) => b.path).filter(Boolean);
  }

  async folderExists(name) {
    const all = await this.listFolders();
    return all.includes(name);
  }

  /**
   * 选中文件夹并持锁执行 fn。
   *
   * ⚠️ 不可重入：内部用 holdingLock 断言，嵌套调用会直接抛错而不是死锁。
   * ⚠️ 每次调用都 close + 重新 SELECT，绕开 QQ 的 EXISTS 不刷新。
   */
  async withMailbox(name, fn) {
    if (this.holdingLock) {
      throw new Error('内部错误：withMailbox 不可重入（会造成 IMAP 死锁）');
    }
    this.holdingLock = true;
    let lock = null;
    try {
      if (this.selected) {
        try {
          await this.client.mailboxClose();
        } catch {
          /* ignore */
        }
        this.selected = null;
      }
      lock = await this.client.getMailboxLock(name);
      this.selected = name;
      // 把 client 传进去：调用方需要直接 fetch/append，拿不到 client 极易写错
      return await fn(this.client);
    } finally {
      this.selected = null;
      try {
        lock?.release();
      } catch {
        /* ignore */
      }
      this.holdingLock = false;
      try {
        if (this.client?.usable) await this.client.mailboxClose();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 列出一个文件夹里所有邮件的元信息（不含正文，尽量轻）。
   * 返回 [{seq, uid, subject, fromName, internalDate, headers, bodyStructure}]
   */
  async listMessages(folder, { headers: wantHeaders = true } = {}) {
    if (!(await this.folderExists(folder))) return [];
    return this.withMailbox(folder, async () => {
      const total = Number(this.client.mailbox?.exists ?? 0);
      if (!total) return [];
      const out = [];
      const query = {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
      };
      if (wantHeaders) query.headers = true;
      for await (const msg of this.client.fetch('1:*', query, { uid: false })) {
        out.push({
          seq: msg.seq,
          uid: msg.uid,
          subject: msg.envelope?.subject || '',
          internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
          headers: msg.headers ? parseHeaderBlock(msg.headers) : null,
          bodyStructure: msg.bodyStructure || null,
        });
      }
      return out;
    });
  }

  /**
   * 读一封完整报文（含附件）。
   * ⚠️ 必须用 seq。UID 在 QQ 上不可靠（实测一律返回空）。
   */
  async fetchRawBySeq(folder, seq) {
    return this.withMailbox(folder, async () => {
      const msg = await this.client.fetchOne(String(seq), { source: true }, { uid: false });
      if (!msg || !msg.source) {
        throw new Error(`读取第 ${seq} 封失败：服务器没有返回报文内容`);
      }
      return msg.source;
    });
  }

  /**
   * 写入一封完整报文。
   * ⚠️ 不依赖返回值判断成功——APPEND 抛异常也可能已写成（实测踩过）。
   *    调用方必须回读校验。
   */
  async appendRaw(folder, raw, { flags = ['\\Seen'] } = {}) {
    const res = await this.client.append(folder, raw, flags);
    return res || {};
  }

  /** 按 seq 删信（QQ 上 UID 不稳，统一用 seq）。 */
  async deleteBySeq(folder, seqs) {
    if (!seqs || !seqs.length) return false;
    return this.withMailbox(folder, async () => {
      const range = seqs.join(',');
      return this.client.messageDelete(range, { uid: false });
    });
  }

  /** 按 uid 删信（仅当同一会话内刚取到 uid 且确定可靠时用）。 */
  async deleteByUid(folder, uids) {
    if (!uids || !uids.length) return false;
    return this.withMailbox(folder, async () => {
      return this.client.messageDelete(uids, { uid: true });
    });
  }

  /** 清空文件夹里所有邮件（删文件夹前必须先做，非空 DELETE 会失败）。 */
  async emptyFolder(folder) {
    if (!(await this.folderExists(folder))) return 0;
    return this.withMailbox(folder, async () => {
      const total = Number(this.client.mailbox?.exists ?? 0);
      if (!total) return 0;
      await this.client.messageDelete('1:*', { uid: false });
      return total;
    });
  }

  /** 删除文件夹（先清空）。文件夹不存在时静默成功。 */
  async dropFolder(folder) {
    if (!(await this.folderExists(folder))) return false;
    await this.emptyFolder(folder);
    return this.client.mailboxDelete(folder);
  }

  /** 服务器公告的能力集（诊断用）。 */
  capabilities() {
    const caps = this.client?.capabilities;
    if (!caps) return {};
    const obj = {};
    for (const [k, v] of caps.entries()) {
      obj[k] = typeof v === 'bigint' ? String(v) : v;
    }
    return obj;
  }
}

/** 开一个会话执行 fn，结束时一定关闭连接。 */
export async function withSession(conn, fn, { logger } = {}) {
  const session = new MailSession(conn, { logger });
  await session.connect();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** 连接测试：分别测 IMAP 与目录可访问性。 */
export async function testConnection(conn, { logger, dataFolder } = {}) {
  const started = Date.now();
  const session = new MailSession(conn, { logger });
  const result = { ok: false, imap: null, folder: null, capabilities: null, elapsedMs: 0 };
  try {
    await session.connect();
    session.client.noop();
    result.imap = { ok: true, host: conn.imapHost, port: conn.imapPort };
    result.capabilities = session.capabilities();
    const folders = await session.listFolders();
    result.folder = {
      ok: true,
      dataFolderExists: folders.includes(dataFolder || 'Sync-Shuttle'),
      folderCount: folders.length,
    };
    result.ok = true;
    return result;
  } catch (err) {
    result.imap = { ok: false, message: describeImapError(err) };
    return result;
  } finally {
    result.elapsedMs = Date.now() - started;
    await session.close();
  }
}
