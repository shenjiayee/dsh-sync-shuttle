// 设置：合并「profile patch 配置」与「本机 credentials.json」，token 优先读本机。
//
// 为什么 token 不写 cordis.patch.yml：patch 是明文、会进 git/快照。
// 本机 credentials.json（600 权限）才是授权码的家。patch 里只放非敏感项。

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, resolveDataDir, buildPaths, ensureDirs } from './paths.js';
import { maskEmail } from './log.js';

/** 已知邮箱服务商的默认服务器（界面上可改）。 */
export const PRESETS = Object.freeze({
  qq: { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465, title: 'QQ 邮箱' },
  '163': { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465, title: '网易 163' },
  '126': { imapHost: 'imap.126.com', imapPort: 993, smtpHost: 'smtp.126.com', smtpPort: 465, title: '网易 126' },
  yeah: { imapHost: 'imap.yeah.net', imapPort: 993, smtpHost: 'smtp.yeah.net', smtpPort: 465, title: '网易 yeah' },
  custom: { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, title: '自定义' },
});

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * @param rawConfig  来自 cordis.patch.yml 的 config（非敏感项）
 */
export function createSettings(rawConfig = {}, { env = process.env, logger } = {}) {
  const dataDir = rawConfig.dataDir || resolveDataDir(env);
  const paths = buildPaths(dataDir);
  ensureDirs(paths);

  const patch = rawConfig || {};

  function readCredFile() {
    const v = readJsonSafe(paths.credentials);
    if (!v || typeof v !== 'object') return null;
    const account = typeof v.account === 'string' ? v.account.trim() : '';
    const token = typeof v.token === 'string' ? v.token.trim() : '';
    if (!account || !token) return null;
    return { account, token };
  }

  let credCache = readCredFile();
  let credMtime = 0;
  try {
    credMtime = fs.statSync(paths.credentials).mtimeMs;
  } catch {
    credMtime = 0;
  }

  function refreshCred() {
    let mtime = 0;
    try {
      mtime = fs.statSync(paths.credentials).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime !== credMtime) {
      credMtime = mtime;
      credCache = readCredFile();
    }
    return credCache;
  }

  function pick(name, fallback) {
    const v = patch[name];
    return v === undefined || v === null || v === '' ? fallback : v;
  }

  return {
    paths,
    dataDir,

    /** 完整设置（含脱敏后的账号信息，token 不返回给界面）。 */
    snapshot() {
      const cred = refreshCred();
      const presetKey = pick('preset', 'qq');
      const preset = PRESETS[presetKey] || PRESETS.qq;
      return {
        preset: presetKey,
        account: cred?.account || '',
        accountMasked: cred ? maskEmail(cred.account) : '',
        hasToken: Boolean(cred?.token),
        imapHost: pick('imapHost', preset.imapHost),
        imapPort: Number(pick('imapPort', preset.imapPort)),
        imapSecure: pick('imapSecure', true) !== false,
        smtpHost: pick('smtpHost', preset.smtpHost),
        smtpPort: Number(pick('smtpPort', preset.smtpPort)),
        smtpSecure: pick('smtpSecure', true) !== false,
        dataDir,
        // 存储后端：目前只有 qqmail（QQ 邮箱 IMAP）。
        storageKind: pick('storageKind', 'qqmail'),
        // 远端文件夹前缀：空 = 生产（sync-shuttle / -config / -lock）；
        // 设了前缀则所有文件夹加前缀，用于让测试与生产数据彻底隔离。
        // 生产环境不要设它。
        folderPrefix: pick('folderPrefix', ''),
        // volumeBytes 仅作兜底：正常路径下分卷大小取自 adapter（qqmail 固定 40 MiB）。
        // 保留它是为了让「adapter 构造失败」时上传流程仍能算出合理分卷，
        // 不因为一个配置读不到就整条流程崩掉。
        volumeMiB: Math.max(1, Math.round(Number(pick('volumeBytes', DEFAULTS.volumeBytes)) / (1024 * 1024))),
        volumeBytes: Number(pick('volumeBytes', DEFAULTS.volumeBytes)),
        archiveBackend: 'zip.js',
        keepPrevDefault: pick('keepPrevDefault', false) === true,
        volumeGapMs: Number(pick('volumeGapMs', DEFAULTS.volumeGapMs)),
        capacityBytes: Number(pick('capacityBytes', DEFAULTS.capacityBytes)),
        lockTtlMs: Number(pick('lockTtlMs', DEFAULTS.lockTtlMs)),
        lockHeartbeatMs: Number(pick('lockHeartbeatMs', DEFAULTS.lockHeartbeatMs)),
        logLevel: pick('logLevel', 'info'),
        readOnly: pick('readOnly', false) === true,
      };
    },

    /** 只有宿主内部用的连接参数（含 token）。 */
    connection() {
      const cred = refreshCred();
      const s = this.snapshot();
      return {
        account: cred?.account || '',
        token: cred?.token || '',
        imapHost: s.imapHost,
        imapPort: s.imapPort,
        imapSecure: s.imapSecure,
        smtpHost: s.smtpHost,
        smtpPort: s.smtpPort,
        smtpSecure: s.smtpSecure,
      };
    },

    hasCredentials() {
      const cred = refreshCred();
      return Boolean(cred?.account && cred?.token);
    },

    /** 保存账号与授权码（只落本机 credentials.json，权限 600）。 */
    saveCredentials({ account, token }) {
      const acc = String(account || '').trim();
      const tok = String(token || '').trim();
      if (!acc || !tok) throw new Error('账号与授权码都不能为空');
      if (!/^[^\s@]+@[^\s@]+$/.test(acc)) throw new Error('邮箱地址格式不正确');
      writeJsonAtomic(paths.credentials, { account: acc, token: tok });
      try {
        fs.chmodSync(paths.credentials, 0o600);
      } catch {
        /* Windows 上一般无效，忽略 */
      }
      credCache = { account: acc, token: tok };
      try {
        credMtime = fs.statSync(paths.credentials).mtimeMs;
      } catch {
        credMtime = Date.now();
      }
      logger?.info('已保存邮箱凭据', { account: maskEmail(acc) });
      return { account: acc, accountMasked: maskEmail(acc) };
    },

    clearCredentials() {
      try {
        fs.unlinkSync(paths.credentials);
      } catch {
        /* ignore */
      }
      credCache = null;
      credMtime = 0;
      logger?.warn('已清除邮箱凭据');
    },
  };
}
