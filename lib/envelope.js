// 邮件信封：主题、自定义头、正文清单的构造与解析。
//
// 铁律（§3.2）：所有自定义头的值必须纯 ASCII。
//   项目名 → encodeURIComponent；
//   人读的中文 → 只放主题与正文。
//
// 铁律（§3.1）：主题只给人看，不承担机器解析。

import { HEADERS, LOCK_HEADERS, SUBJECT_PREFIX, CONFIG_SUBJECT_PREFIX, CONFIG_HEADERS } from './paths.js';
import { sanitizeSubjectName } from './util.js';

/** 项目名 → 头值（纯 ASCII）。 */
export function encodeProject(name) {
  return encodeURIComponent(String(name || ''));
}

/** 头值 → 项目名。解码失败时原样返回（容忍手工构造的邮件）。 */
export function decodeProject(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 卷序号显示用：2/12 */
export function volumeLabel(index, total) {
  return `${index}/${total}`;
}

/** 数据邮件的主题：[SYNC-SHUTTLE] 照片归档 | v3 | 卷 2/12 */
export function buildSubject({ project, version, index, total }) {
  const safe = sanitizeSubjectName(project);
  return `${SUBJECT_PREFIX} ${safe} | v${version} | 卷 ${volumeLabel(index, total)}`;
}

/** 配置备份的主题：[SYNC-SHUTTLE-CONFIG] MC-7K2M9Q | DESKTOP-A | 2026-11-19T15:20:41Z */
export function buildConfigSubject({ machineId, hostname, at }) {
  const host = String(hostname || '').replace(/[\r\n\t|]+/g, ' ').slice(0, 40);
  return `${CONFIG_SUBJECT_PREFIX} ${machineId} | ${host} | ${at}`;
}

/** 构造数据邮件的自定义头对象（值全部 ASCII）。 */
export function buildHeaders(meta) {
  return {
    [HEADERS.project]: encodeProject(meta.project),
    [HEADERS.version]: String(meta.version),
    [HEADERS.versionId]: String(meta.versionId),
    [HEADERS.volume]: volumeLabel(meta.index, meta.total),
    [HEADERS.volumeBytes]: String(meta.volumeBytes),
    [HEADERS.volumeSha256]: String(meta.volumeSha256),
    [HEADERS.archiveBytes]: String(meta.archiveBytes),
    [HEADERS.archiveSha256]: String(meta.archiveSha256),
    [HEADERS.sourceBytes]: String(meta.sourceBytes),
    [HEADERS.sourceFiles]: String(meta.sourceFiles),
    [HEADERS.encrypted]: meta.encrypted ? '1' : '0',
    [HEADERS.keepPrev]: meta.keepPrev ? '1' : '0',
  };
}

/**
 * 构造正文清单（§3.3）。
 * volumeList 每行 `卷号|字节数|SHA-256`，恰好 3 段，按卷号升序，不截断。
 */
export function buildManifestBody(meta) {
  const lines = [
    `project=${meta.project}`,
    `version=${meta.version}`,
    `versionId=${meta.versionId}`,
    `volumes=${meta.total}`,
    `compression=${meta.compression || '7z -mx1'}`,
    `encrypted=${meta.encrypted ? 'true' : 'false'}`,
    `topDir=${meta.topDir || ''}`,
    `sourceFiles=${meta.sourceFiles}`,
    `sourceBytes=${meta.sourceBytes}`,
    `archiveBytes=${meta.archiveBytes}`,
    `archiveSha256=${meta.archiveSha256}`,
    `created=${meta.created || new Date().toISOString()}`,
    'volumeList:',
  ];
  for (const v of meta.volumes) {
    lines.push(`  ${v.index}|${v.bytes}|${v.sha256}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 解析正文清单。返回 {fields, volumes, complete} —— 解析失败不抛异常。 */
export function parseManifestBody(text) {
  const result = { fields: {}, volumes: [], complete: false };
  const raw = String(text || '');
  if (!raw) return result;

  const lines = raw.split(/\r?\n/);
  let inList = false;
  for (const line of lines) {
    if (!line) continue;
    if (!inList && /^volumeList:?\s*$/.test(line.trim())) {
      inList = true;
      continue;
    }
    if (inList) {
      const m = /^\s*(\d+)\|(\d+)\|([0-9a-fA-F]{64})\s*$/.exec(line);
      if (m) {
        result.volumes.push({ index: Number(m[1]), bytes: Number(m[2]), sha256: m[3].toLowerCase() });
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      result.fields[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
  }

  const declared = Number(result.fields.volumes);
  result.complete =
    Number.isFinite(declared) &&
    declared > 0 &&
    result.volumes.length === declared &&
    result.volumes.every((v, i) => v.index === i + 1);
  return result;
}

/**
 * 把一封邮件的头解析成结构化元数据。
 * 返回 null 表示这封不是本插件的数据邮件。
 */
export function readDataHeaders(headers) {
  if (!headers) return null;
  // 一律 trim：头值可能因为折行展开而带进多余空白，
  // 而 SHA-256 是精确比对，多一个空格就会判成「哈希不符」。
  const get = (name) => String(headers[String(name).toLowerCase()] || '').trim();
  const projectRaw = get(HEADERS.project);
  const version = get(HEADERS.version);
  const versionId = get(HEADERS.versionId);
  if (!projectRaw || !version || !versionId) return null;

  const volumeRaw = get(HEADERS.volume);
  const vm = /^(\d+)\s*\/\s*(\d+)$/.exec(volumeRaw);
  if (!vm) return null;

  const num = (name) => {
    const v = Number(get(name));
    return Number.isFinite(v) ? v : 0;
  };

  return {
    project: decodeProject(projectRaw),
    version,
    versionId,
    index: Number(vm[1]),
    total: Number(vm[2]),
    volumeBytes: num(HEADERS.volumeBytes),
    volumeSha256: get(HEADERS.volumeSha256).toLowerCase(),
    archiveBytes: num(HEADERS.archiveBytes),
    archiveSha256: get(HEADERS.archiveSha256).toLowerCase(),
    sourceBytes: num(HEADERS.sourceBytes),
    sourceFiles: num(HEADERS.sourceFiles),
    encrypted: get(HEADERS.encrypted) === '1',
    keepPrev: get(HEADERS.keepPrev) === '1',
  };
}

/** 读锁邮件头。 */
export function readLockHeaders(headers) {
  if (!headers) return null;
  // trim 同样必要：nonce 是精确比对的，多一个空格就会判成「锁不是我的」
  const get = (name) => String(headers[String(name).toLowerCase()] || '').trim();
  const owner = get(LOCK_HEADERS.owner);
  const nonce = get(LOCK_HEADERS.nonce);
  if (!owner || !nonce) return null;
  return {
    owner,
    nonce,
    at: get(LOCK_HEADERS.at),
    ttlMs: Number(get(LOCK_HEADERS.ttl)) || 0,
    op: get(LOCK_HEADERS.op),
  };
}

/** 构造配置备份邮件的头。 */
export function buildConfigHeaders({ machineId, hostname, at, sha256 }) {
  return {
    [CONFIG_HEADERS.machineId]: String(machineId),
    [CONFIG_HEADERS.hostname]: String(hostname || '').replace(/[^\x20-\x7e]/g, '') || 'unknown',
    [CONFIG_HEADERS.at]: String(at),
    [CONFIG_HEADERS.sha256]: String(sha256),
  };
}

/** 读配置备份邮件头。 */
export function readConfigHeaders(headers) {
  if (!headers) return null;
  // trim 同样必要：sha256 是精确比对的
  const get = (name) => String(headers[String(name).toLowerCase()] || '').trim();
  const machineId = get(CONFIG_HEADERS.machineId);
  if (!machineId) return null;
  return {
    machineId,
    hostname: get(CONFIG_HEADERS.hostname),
    at: get(CONFIG_HEADERS.at),
    sha256: get(CONFIG_HEADERS.sha256).toLowerCase(),
  };
}

/** 构造锁邮件的头。 */
export function buildLockHeaders({ owner, nonce, at, ttlMs, op }) {
  return {
    [LOCK_HEADERS.owner]: String(owner),
    [LOCK_HEADERS.nonce]: String(nonce),
    [LOCK_HEADERS.at]: String(at),
    [LOCK_HEADERS.ttl]: String(Math.round(ttlMs)),
    [LOCK_HEADERS.op]: String(op || '').replace(/[^\x20-\x7e]/g, '').slice(0, 80),
  };
}
