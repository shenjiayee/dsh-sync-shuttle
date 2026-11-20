// 清单：把存储层返回的零散对象聚合成「项目 → 版本 → 分卷」。
//
// 铁律：远端存储是唯一事实来源。每次刷新都重新扫，不缓存排序结果（§5）。
//
// 本模块不认识 IMAP：入参是 storage adapter 的 list() 输出。
// 每个 entry 形如 { ref, key, meta, sizeBytes, createdAtMs }，
// 具体怎么编解码由 adapter 负责（邮件头/正文清单，或 SMB 的旁挂 meta 文件）。

import { humanBytes } from './util.js';

/**
 * 判断一个 entry 是不是数据集合里的「分卷」对象。
 * 用形状判断而非来源判断，这样换后端时本函数不用改。
 */
function volumeOf(entry) {
  const v = entry?.meta?.version;
  const vol = entry?.meta?.volume;
  if (!v || !vol) return null;
  if (!v.project || !v.version || !v.versionId) return null;
  if (!Number.isFinite(Number(vol.index)) || Number(vol.index) < 1) return null;
  return { v, vol };
}

/**
 * 把 adapter.list() 的输出聚合成结构化版本。
 *
 * @param entries adapter.list({ collection: 'data' }) 的结果
 */
export function aggregateVersions(entries) {
  const groups = new Map(); // key = project + '\u0000' + version

  for (const entry of entries || []) {
    const parsed = volumeOf(entry);
    if (!parsed) continue;
    const { v, vol } = parsed;

    const key = `${v.project}\u0000${v.version}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        project: v.project,
        version: v.version,
        versionId: v.versionId,
        total: Number(v.total) || 0,
        archiveBytes: Number(v.archiveBytes) || 0,
        archiveSha256: v.archiveSha256 || '',
        sourceBytes: Number(v.sourceBytes) || 0,
        sourceFiles: Number(v.sourceFiles) || 0,
        encrypted: Boolean(v.encrypted),
        keepPrev: Boolean(v.keepPrev),
        compression: v.compression || 'zip deflate',
        topDir: v.topDir || '',
        volumes: [],
        uploadedAt: null,
      };
      groups.set(key, group);
    }

    group.volumes.push({
      // ref 取代原来的 seq：上层只把它当「定位这个对象的句柄」，不关心它是什么
      ref: entry.ref,
      index: Number(vol.index),
      bytes: Number(vol.bytes) || 0,
      sha256: vol.sha256 || '',
    });

    // 上传时间取服务器记录的创建时刻，取该版本所有分卷里最新的一个
    const at = Number(entry.createdAtMs) || 0;
    if (at && (!group.uploadedAt || at > group.uploadedAt.getTime())) {
      group.uploadedAt = new Date(at);
    }
  }

  const versions = [];
  for (const group of groups.values()) {
    group.volumes.sort((a, b) => a.index - b.index);

    // 卷完整性：1..total 都在，且字节数相加等于 archiveBytes（若给了）
    const present = new Set(group.volumes.map((v) => v.index));
    const missing = [];
    for (let i = 1; i <= group.total; i += 1) {
      if (!present.has(i)) missing.push(i);
    }
    const sumBytes = group.volumes.reduce((s, v) => s + v.bytes, 0);
    const sizeOk = !group.archiveBytes || sumBytes === group.archiveBytes;

    let status = 'complete';
    if (missing.length) status = 'missing';
    else if (!sizeOk) status = 'size-mismatch';

    versions.push({
      ...group,
      sumBytes,
      missing,
      sizeOk,
      status,
      volumeCount: group.volumes.length,
    });
  }

  // 全局排序：Version 降序；同秒按 Version-Id 字典序升序（§5 唯一规则）
  versions.sort((a, b) => {
    if (a.version !== b.version) return a.version < b.version ? 1 : -1;
    return a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0;
  });

  return versions;
}

/** 把版本按项目分组，并标记哪个是最新。 */
export function groupByProject(versions) {
  const map = new Map();
  for (const v of versions) {
    let list = map.get(v.project);
    if (!list) {
      list = [];
      map.set(v.project, list);
    }
    list.push(v);
  }
  const projects = [];
  for (const [project, list] of map.entries()) {
    // list 已按版本降序，第 1 个就是最新（即使缺卷也不回退，§5）
    const latest = list[0];
    const history = list.slice(1);
    projects.push({
      project,
      latest,
      history,
      versionCount: list.length,
      /** 该项目在远端占用的字节（所有版本分卷字节之和） */
      occupiedBytes: list.reduce((s, v) => s + v.sumBytes, 0),
    });
  }
  projects.sort((a, b) => {
    const at = a.latest?.uploadedAt?.getTime() || 0;
    const bt = b.latest?.uploadedAt?.getTime() || 0;
    return bt - at;
  });
  return projects;
}

/** 计算本插件占用的总字节（容量看护用，§5）。 */
export function totalOccupied(versions) {
  return versions.reduce((s, v) => s + v.sumBytes, 0);
}

/** 状态的中文描述。 */
export function describeVersionStatus(v) {
  if (!v) return '无版本';
  if (v.status === 'missing') {
    const list = v.missing.length > 6 ? `${v.missing.slice(0, 6).join('、')}…` : v.missing.join('、');
    return `缺第 ${list} 卷`;
  }
  if (v.status === 'size-mismatch') {
    return `字节数不符（清单 ${humanBytes(v.archiveBytes)} / 实收 ${humanBytes(v.sumBytes)}）`;
  }
  return '完整';
}

/** 版本号显示：v3（取 version 时间戳的日期与序号感） */
export function shortVersionLabel(version, uploadedAt) {
  if (uploadedAt instanceof Date) {
    const mm = String(uploadedAt.getMonth() + 1).padStart(2, '0');
    const dd = String(uploadedAt.getDate()).padStart(2, '0');
    const hh = String(uploadedAt.getHours()).padStart(2, '0');
    const mi = String(uploadedAt.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }
  return String(version || '');
}
