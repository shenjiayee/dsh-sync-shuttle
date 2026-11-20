// 日志：按本地日期分文件，保留 14 天，单文件 50 MB 上限。
// 规则见说明书 §3.4。绝不记录授权码、完整邮箱、加密口令、正文全文。

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 50 * 1024 * 1024;
const KEEP_DAYS = 14;

/** 脱敏邮箱：s********e@qq.com */
export function maskEmail(addr) {
  const s = String(addr || '').trim();
  if (!s) return '(未配置)';
  const at = s.lastIndexOf('@');
  if (at <= 0) return `${s.slice(0, 1)}***`;
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return `${local.slice(0, 1)}***${domain}`;
  return `${local.slice(0, 1)}******${local.slice(-1)}${domain}`;
}

// 绝不能进日志的键（授权码、口令、token）。
const SECRET_KEYS = new Set([
  'token',
  'pass',
  'password',
  'authorization',
  'authcode',
  'auth_code',
  'credential',
  'credentials',
  'secret',
  'smtp_pass',
]);
const EMAIL_KEYS = new Set(['account', 'user', 'email', 'from', 'to', 'address']);

/** 递归净化日志元数据：脱敏邮箱、抹掉密钥。 */
function scrub(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.has(key)) {
      out[k] = '***';
    } else if (EMAIL_KEYS.has(key) && typeof v === 'string' && v.includes('@')) {
      out[k] = maskEmail(v);
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 净化日志正文：把可能顺带写进来的邮箱抹掉。
 *  授权码本身不加通用长度掩码——那会误伤时间戳与版本号；
 *  真正防泄漏靠「调用方不传 token」+ 元数据键名过滤（scrub）。 */
function sanitizeLine(message) {
  return String(message == null ? '' : message).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => maskEmail(m));
}

export function createLogger(options = {}) {
  const logsDir = options.logsDir;
  let level = options.level === 'debug' ? 'debug' : 'info';
  let overflowNotified = false;

  function fileFor(dateKey) {
    return path.join(logsDir, `sync-shuttle-${dateKey}.log`);
  }

  function write(lvl, message, meta) {
    if (lvl === 'debug' && level !== 'debug') return;
    if (!logsDir) return;
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const file = fileFor(localDateKey());
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_BYTES) {
          if (!overflowNotified) {
            overflowNotified = true;
            fs.appendFileSync(
              file,
              `${new Date().toISOString()} [WARN] 日志超过 ${MAX_BYTES} 字节，当天停止写入\n`,
              'utf8',
            );
          }
          return;
        }
      } catch {
        /* 文件不存在，正常 */
      }
      const safe = meta ? scrub(meta) : null;
      const line = `${new Date().toISOString()} [${lvl.toUpperCase()}] ${sanitizeLine(message)}${
        safe ? ` ${JSON.stringify(safe)}` : ''
      }\n`;
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* 日志失败绝不影响业务 */
    }
  }

  return {
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    debug: (msg, meta) => write('debug', msg, meta),
    setLevel(next) {
      level = next === 'debug' ? 'debug' : 'info';
    },
    getLevel() {
      return level;
    },
    /** 读取某天的日志（界面「查看日志」用）。 */
    read(dateKey) {
      try {
        return fs.readFileSync(fileFor(dateKey || localDateKey()), 'utf8');
      } catch {
        return '';
      }
    },
    /** 启动时清理 14 天前的日志。 */
    prune() {
      try {
        const entries = fs.readdirSync(logsDir);
        const cutoff = Date.now() - KEEP_DAYS * 86400_000;
        for (const name of entries) {
          if (!/^sync-shuttle-\d{8}\.log$/.test(name)) continue;
          const full = path.join(logsDir, name);
          try {
            if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    },
  };
}
