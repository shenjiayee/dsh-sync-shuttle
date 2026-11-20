// 上传流程（§4）。
//
// 关键点：
//   · 第 ⑤ 步回读校验不可跳过 —— 「写入成功」不等于「读得回来」
//   · 旧版本清理排在校验全部通过之后，且失败只记日志
//   · 单卷失败只重试该卷（先删同 versionId 同卷号的半成品）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createArchive, testArchive } from './archive.js';
import { buildRawMessage, LIMITS } from './builder.js';
import { buildSubject, buildHeaders, buildManifestBody } from './envelope.js';
import {
  sha256File,
  versionStamp,
  randomVersionId,
  dirStats,
  humanBytes,
  humanDuration,
  formatRate,
  formatEta,
  percentOf,
} from './util.js';
import { describeImapError } from './mail.js';
import { simpleParser } from 'mailparser';

const MAX_RETRY_PER_VOLUME = 3;

/**
 * 把多个文件按顺序流式喂进同一个 SHA-256，得到「拼接后整包」的哈希。
 * 用于算分卷归档的整包哈希：不必真的把分卷拼成一个几十 GB 的文件。
 */
function sha256OfFiles(files) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let i = 0;
    const next = () => {
      if (i >= files.length) {
        resolve(hash.digest('hex'));
        return;
      }
      const stream = fs.createReadStream(files[i], { highWaterMark: 1024 * 1024 });
      i += 1;
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', next);
    };
    next();
  });
}

/**
 * 执行一次完整上传。
 *
 * @param ctx { storage, session, settings, logger, project, localDir, options, reporter }
 *   storage —— 存储 adapter（新路径，优先使用）
 *   session —— 旧的 IMAP 会话（过渡期保留，storage 缺失时回退）
 */
export async function runUpload(ctx) {
  const {
    storage,
    session,
    settings,
    logger,
    project,
    localDir,
    options = {},
    reporter = {},
    dataFolder,
  } = ctx;

  const snap = settings.snapshot();
  // 分卷大小归 adapter 所有：它才知道后端能装多大。
  // 旧路径（无 storage）回退到配置值，仅为过渡期兼容。
  const volumeBytes = Number(storage?.volumeBytes || options.volumeBytes || snap.volumeBytes);
  const keepPrev = options.keepPrev === undefined ? snap.keepPrevDefault : Boolean(options.keepPrev);
  const gapMs = Number(snap.volumeGapMs);

  const report = (stage, detail) => {
    try {
      reporter.onProgress?.({ stage, ...detail });
    } catch {
      /* 界面回调异常绝不影响上传 */
    }
  };

  // ① 前置检查
  report('precheck', { message: '检查源目录与归档后端' });
  if (!fs.existsSync(localDir)) {
    throw new Error(`源目录不存在：${localDir}`);
  }
  const stats = dirStats(localDir);
  if (!stats.files) {
    throw new Error('源目录是空的，没有可上传的内容');
  }
  // 打包后端已改为内置的纯 JS ZIP，不再依赖外部 7-Zip 可执行文件。
  // checkSevenZip 保留调用只为保持流程结构，本质上恒为可用。
  const { checkSevenZip } = await import('./archive.js');
  const backend = await checkSevenZip();
  if (!backend.ok) {
    throw new Error(`归档后端不可用：${backend.message}`);
  }

  // 容量看护：100% 拒绝上传（§5）
  const used = Number(options.usedBytes || 0);
  if (snap.capacityBytes > 0 && used > 0) {
    const projected = used + stats.bytes;
    if (projected > snap.capacityBytes) {
      const err = new Error(
        `邮箱容量不足：已用 ${humanBytes(used)}，本次约 ${humanBytes(stats.bytes)}，` +
          `容量上限 ${humanBytes(snap.capacityBytes)}。请先删除旧项目或调整容量设置。`,
      );
      err.code = 'CAPACITY_EXCEEDED';
      throw err;
    }
  }

  const version = versionStamp();
  const versionId = randomVersionId();
  const buildDir = path.join(settings.paths.buildDir, versionId);
  fs.mkdirSync(buildDir, { recursive: true });

  let volumeFiles = [];
  let archiveFile = '';

  try {
    // ② 打包（纯 JS ZIP，边打包边切片落盘）
    report('packing', { message: `正在打包 ${stats.files} 个文件（${humanBytes(stats.bytes)}）` });
    const packed = await createArchive({
      sourceDir: localDir,
      outDir: buildDir,
      baseName: versionId,
      volumeBytes,
      onProgress: (written) =>
        report('packing', {
          // 进度按已写入字节 / 源字节估，压缩率差异只影响观感
          percent: stats.bytes > 0 ? Math.min(100, Math.round((written / stats.bytes) * 100)) : 0,
          // 本阶段进度条按字节算
          bytes: written,
          totalBytes: stats.bytes,
          // 同时给出「已写入/总大小」和百分比，避免只看到数字不动而误以为卡住。
          // 数字长时间不涨是正常的：源文件多为已压缩内容（jpg/zip/mp4），
          // deflate 压不动，写入量与源大小基本相等。
          message:
            `打包 ${humanBytes(written)} / ${humanBytes(stats.bytes)}` +
            `（${stats.bytes > 0 ? Math.min(100, Math.round((written / stats.bytes) * 100)) : 0}%）`,
        }),
    });
    volumeFiles = packed.volumeFiles;
    archiveFile = packed.archiveFile;

    // 打包后立即做全量校验（校验 A）：逐个条目读出并让 zip.js 校验 CRC32
    const tested = await testArchive(archiveFile);
    if (!tested.ok) {
      throw new Error(`归档自检失败：${tested.message}`);
    }

    // ③ 逐卷算哈希 + 字节
    // 先统计全部卷的字节总和，用于本阶段进度条（按字节算，不按卷数）
    const totalVolumeBytes = volumeFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
    report('hashing', {
      percent: 0,
      message: `计算 ${volumeFiles.length} 卷的 SHA-256（共 ${humanBytes(totalVolumeBytes)}）`,
      index: 0,
      total: volumeFiles.length,
      totalBytes: totalVolumeBytes,
    });
    const volumes = [];
    const hashStarted = Date.now();
    let hashedBytes = 0;
    for (let i = 0; i < volumeFiles.length; i += 1) {
      const file = volumeFiles[i];
      const bytes = fs.statSync(file).size;
      const sha256 = await sha256File(file);
      // 单卷上限由 adapter 决定（它才知道后端能装多大）。
      // maxObjectBytes 为 null 表示该后端不限制。
      const limit = storage?.maxObjectBytes ?? LIMITS.attachmentBytes;
      if (limit && bytes > limit) {
        throw new Error(
          `第 ${i + 1} 卷 ${humanBytes(bytes)} 超过单卷上限 ${humanBytes(limit)}，` +
            `请把分卷大小调小`,
        );
      }
      volumes.push({ index: i + 1, file, bytes, sha256 });
      hashedBytes += bytes;
      report('hashing', {
        percent: Math.round(((i + 1) / volumeFiles.length) * 100),
        index: i + 1,
        total: volumeFiles.length,
        bytes: hashedBytes,
        // 带上速度：本地算哈希通常极快，能立刻看出是否卡在磁盘 IO 上
        message:
          `校验和 ${i + 1}/${volumeFiles.length} 卷` +
          `（${humanBytes(hashedBytes)}，${formatRate(hashedBytes, Date.now() - hashStarted)}）`,
      });
    }

    // 整包大小 = 各卷字节之和（分卷就是同一个 zip 的连续字节，拼起来即整包）
    const archiveBytes = packed.archiveBytes ?? volumes.reduce((s, v) => s + v.bytes, 0);
    // 整包 SHA-256：单卷时就是该卷哈希；多卷时把卷按顺序流式喂进同一个 hash，
    // 避免为了算哈希再把几十 GB 拼成一个文件落盘。
    const archiveSha256 =
      volumes.length === 1 ? volumes[0].sha256 : await sha256OfFiles(volumes.map((v) => v.file));

    const meta = {
      project,
      version,
      versionId,
      total: volumes.length,
      compression: 'zip deflate',
      encrypted: false, // 本版不支持加密（方案 A3）
      topDir: path.basename(localDir),
      sourceFiles: stats.files,
      sourceBytes: stats.bytes,
      archiveBytes,
      archiveSha256,
      created: new Date().toISOString(),
      keepPrev,
      volumes: volumes.map((v) => ({ index: v.index, bytes: v.bytes, sha256: v.sha256 })),
    };

    const manifestBody = buildManifestBody(meta);

    // ④ 逐卷写入
    report('uploading', {
      percent: 0,
      index: 0,
      total: volumes.length,
      bytes: 0,
      totalBytes: archiveBytes,
      message: `开始上传 ${volumes.length} 卷（共 ${humanBytes(archiveBytes)}）`,
    });

    if (storage) {
      // ── 新路径：全部经 adapter，不碰 IMAP 细节
      const versionMeta = {
        project: meta.project,
        version: meta.version,
        versionId: meta.versionId,
        total: meta.total,
        compression: meta.compression,
        encrypted: meta.encrypted,
        topDir: meta.topDir,
        sourceFiles: meta.sourceFiles,
        sourceBytes: meta.sourceBytes,
        archiveBytes: meta.archiveBytes,
        archiveSha256: meta.archiveSha256,
        created: meta.created,
        keepPrev: meta.keepPrev,
        // adapter 写入时需要完整的分卷清单来冗余进每封邮件正文
        volumes: meta.volumes,
      };
      // 上传进度需要一个跨卷的累计状态（已传字节 + 起始时间），
      // 否则每卷只能报「第 k/N」，看不出总体进度与速率。
      const uploadState = { sentBytes: 0, startedAt: Date.now() };
      for (const vol of volumes) {
        await putVolumeViaStorage({
          storage,
          versionMeta,
          vol,
          logger,
          gapMs,
          total: volumes.length,
          archiveBytes,
          state: uploadState,
          report,
        });
      }

      // ⑤ 回读校验：全部写完后 list() 一次，逐卷读回比对
      report('verifying', {
        percent: 0,
        index: 0,
        total: volumes.length,
        bytes: 0,
        totalBytes: archiveBytes,
        message: `正在回读校验 ${volumes.length} 卷（写入成功 ≠ 能读回，不可跳过）`,
      });
      const verify = await verifyViaStorage({ storage, meta, volumes, report });
      if (!verify.ok) throw new Error(`回读校验失败：${verify.message}`);

      // ⑥ 清理旧版本
      report('cleaning', { message: '清理旧版本' });
      const cleaned = await cleanupViaStorage({
        storage,
        project,
        keepVersion: version,
        keep: keepPrev ? 2 : 1,
        logger,
      });

      return {
        ok: true,
        project,
        version,
        versionId,
        volumes: volumes.length,
        volumeCount: volumes.length,
        verified: true,
        sourceFiles: stats.files,
        sourceBytes: stats.bytes,
        archiveBytes,
        archiveSha256,
        cleaned: cleaned.deleted,
        cleanMessage: cleaned.message,
      };
    }

    // ── 旧路径（过渡期保留）
    await session.ensureFolder(dataFolder);
    for (const vol of volumes) {
      await appendVolumeWithRetry({
        session,
        dataFolder,
        vol,
        meta,
        manifestBody,
        conn: settings.connection(),
        logger,
        gapMs,
        report,
      });
    }

    // ⑤ 回读校验（关键，不可跳过）
    report('verifying', { message: '正在回读校验（不可跳过）' });
    const verify = await verifyUploaded({
      session,
      dataFolder,
      meta,
      volumes,
      report,
    });
    if (!verify.ok) {
      throw new Error(`回读校验失败：${verify.message}`);
    }

    // ⑥ 清理旧版本（只在校验全部通过之后）
    report('cleaning', { message: '清理旧版本' });
    const cleaned = await cleanupOldVersions({
      session,
      dataFolder,
      project,
      keepVersion: version,
      keep: keepPrev ? 2 : 1,
      logger,
    });

    return {
      ok: true,
      project,
      version,
      versionId,
      volumes: volumes.length,
      volumeCount: volumes.length,
      // 只有回读校验（校验 C）全部通过才会走到这里，所以恒为 true
      verified: true,
      sourceFiles: stats.files,
      sourceBytes: stats.bytes,
      archiveBytes,
      archiveSha256,
      cleaned: cleaned.deleted,
      cleanMessage: cleaned.message,
    };
  } finally {
    // 清理打包临时目录（build 目录启动时也会被清空，这里主动清更省空间）
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 通过 storage adapter 写入一卷。失败只重试该卷。 */
async function putVolumeViaStorage({
  storage,
  versionMeta,
  vol,
  logger,
  gapMs,
  total,
  archiveBytes,
  state,
  report,
}) {
  const body = await fs.promises.readFile(vol.file);
  const meta = {
    version: versionMeta,
    volume: { index: vol.index, bytes: vol.bytes, sha256: vol.sha256 },
  };
  const key = `${versionMeta.project}\u0000${versionMeta.version}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRY_PER_VOLUME; attempt += 1) {
    try {
      const volStarted = Date.now();
      await storage.put({ collection: 'data', key, meta, body });
      const volMs = Date.now() - volStarted;
      // 累计整包进度：sentBytes 包含已写成功的所有卷
      state.sentBytes = (state.sentBytes || 0) + vol.bytes;
      const elapsed = Date.now() - (state.startedAt || volStarted);
      const pct = percentOf(state.sentBytes, archiveBytes || vol.bytes * total);
      const rate = formatRate(state.sentBytes, elapsed);
      const eta = formatEta(state.sentBytes, archiveBytes || vol.bytes * total, elapsed);
      report('uploading', {
        percent: pct,
        index: vol.index,
        total,
        bytes: state.sentBytes,
        totalBytes: archiveBytes || vol.bytes * total,
        message:
          `写入第 ${vol.index}/${total} 卷完成` +
          `（${humanBytes(state.sentBytes)} / ${humanBytes(archiveBytes || vol.bytes * total)}，${pct}%` +
          `，${rate}${eta ? `，剩余${eta}` : ''}，本卷 ${humanDuration(volMs)}）`,
      });
      if (gapMs > 0 && vol.index < total) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      return;
    } catch (err) {
      lastErr = err;
      logger?.warn('写卷失败', {
        versionId: versionMeta.versionId,
        index: vol.index,
        attempt,
        message: err?.message || String(err),
      });
      // 删掉可能已写进去的半成品，避免重试造成重复卷
      try {
        const entries = await storage.list({ collection: 'data' });
        const dup = entries.filter((e) => {
          const v = e.meta?.version;
          const vi = e.meta?.volume;
          return (
            v &&
            vi &&
            String(v.versionId).toLowerCase() === String(versionMeta.versionId).toLowerCase() &&
            Number(vi.index) === vol.index
          );
        });
        if (dup.length) await storage.remove({ collection: 'data', refs: dup.map((e) => e.ref) });
      } catch {
        /* ignore */
      }
      if (attempt < MAX_RETRY_PER_VOLUME) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw new Error(
    `第 ${vol.index} 卷连续 ${MAX_RETRY_PER_VOLUME} 次写入失败：${lastErr?.message || String(lastErr)}`,
  );
}

/**
 * 回读校验（校验 C）：list() 一次定位本版本全部卷，逐卷 get() 读回比对 SHA-256。
 * 这是整套设计的核心——「写入成功」绝不等于「读得回来」。
 */
async function verifyViaStorage({ storage, meta, volumes, report }) {
  const entries = await storage.list({ collection: 'data' });
  const mine = entries.filter((e) => {
    const v = e.meta?.version;
    return (
      v &&
      String(v.versionId).toLowerCase() === String(meta.versionId).toLowerCase() &&
      v.version === meta.version
    );
  });

  if (mine.length !== volumes.length) {
    return {
      ok: false,
      message: `期望 ${volumes.length} 卷，实际只找到 ${mine.length} 卷（疑似写入未生效）`,
    };
  }

  const byIndex = new Map();
  for (const e of mine) byIndex.set(Number(e.meta?.volume?.index), e);

  // 校验进度也做累计：已校验字节 / 整包字节，给百分比与读回速率
  const totalBytes = volumes.reduce((s, v) => s + v.bytes, 0);
  const verifyStarted = Date.now();
  let verifiedBytes = 0;

  for (const vol of volumes) {
    const entry = byIndex.get(vol.index);
    if (!entry) return { ok: false, message: `回读时缺少第 ${vol.index} 卷` };

    const volStarted = Date.now();
    let got;
    try {
      got = await storage.get({ collection: 'data', ref: entry.ref });
    } catch (err) {
      return { ok: false, message: `读取第 ${vol.index} 卷失败：${err?.message || String(err)}` };
    }

    const content = Buffer.isBuffer(got?.body) ? got.body : Buffer.from(got?.body || []);
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    if (sha !== vol.sha256) {
      return {
        ok: false,
        message: `第 ${vol.index} 卷哈希不符（期望 ${vol.sha256.slice(0, 12)}… 实得 ${sha.slice(0, 12)}…）`,
      };
    }
    if (content.length !== vol.bytes) {
      return {
        ok: false,
        message: `第 ${vol.index} 卷字节数不符（期望 ${vol.bytes} 实得 ${content.length}）`,
      };
    }

    verifiedBytes += vol.bytes;
    const elapsed = Date.now() - verifyStarted;
    const pct = percentOf(verifiedBytes, totalBytes);
    const rate = formatRate(verifiedBytes, elapsed);
    const eta = formatEta(verifiedBytes, totalBytes, elapsed);
    report('verifying', {
      percent: pct,
      index: vol.index,
      total: volumes.length,
      bytes: verifiedBytes,
      message:
        `回读校验 ${vol.index}/${volumes.length} 卷通过` +
        `（${humanBytes(verifiedBytes)} / ${humanBytes(totalBytes)}，${pct}%` +
        `，${rate}${eta ? `，剩余${eta}` : ''}）`,
    });
  }
  return { ok: true };
}

/**
 * 清理旧版本（§4 第 ⑥ 步）。
 * 只针对本项目、只针对完整版本；失败不影响新版本有效性。
 */
async function cleanupViaStorage({ storage, project, keepVersion, keep, logger }) {
  const { aggregateVersions, groupByProject } = await import('./manifest.js');
  const entries = await storage.list({ collection: 'data' });
  const versions = aggregateVersions(entries);
  const grouped = groupByProject(versions);
  const target = grouped.find((g) => g.project === project);
  if (!target) return { deleted: 0, message: '没有找到项目历史' };

  const others = target.history.filter((v) => v.version !== keepVersion);
  const keepCount = Math.max(1, Number(keep) || 1);
  const toDelete = others.slice(keepCount - 1);
  if (!toDelete.length) return { deleted: 0, message: '无需清理' };

  const refs = [];
  for (const v of toDelete) for (const vol of v.volumes) refs.push(vol.ref);

  try {
    await storage.remove({ collection: 'data', refs });
    logger?.info('已清理旧版本', {
      project,
      deletedVersions: toDelete.length,
      deletedMessages: refs.length,
    });
    return {
      deleted: toDelete.length,
      message: `已删除 ${toDelete.length} 个旧版本（${refs.length} 封邮件）`,
    };
  } catch (err) {
    logger?.warn('清理旧版本失败（不影响新版本）', { project, message: err?.message || String(err) });
    return {
      deleted: 0,
      message: `旧版本未清理（${err?.message || String(err)}），可稍后手动清理`,
    };
  }
}

/** 写一卷，失败只重试该卷；重试前先删掉同 versionId 同卷号的半成品。 */
async function appendVolumeWithRetry({ session, dataFolder, vol, meta, manifestBody, conn, logger, gapMs, report }) {
  const subject = buildSubject({
    project: meta.project,
    version: meta.version,
    index: vol.index,
    total: meta.total,
  });
  const headers = buildHeaders({ ...meta, index: vol.index, volumeBytes: vol.bytes, volumeSha256: vol.sha256 });

  const content = await fs.promises.readFile(vol.file);
  const raw = await buildRawMessage({
    from: conn.account,
    to: conn.account,
    subject,
    headers,
    text: manifestBody,
    attachments: [{ filename: `${meta.versionId}.zip.${String(vol.index).padStart(3, '0')}`, content }],
  });
  if (raw.length > LIMITS.rawBytes) {
    throw new Error(
      `第 ${vol.index} 卷报文 ${humanBytes(raw.length)} 超过服务器上限 ${humanBytes(LIMITS.rawBytes)}`,
    );
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRY_PER_VOLUME; attempt += 1) {
    try {
      await session.appendRaw(dataFolder, raw);
      report('uploading', {
        percent: Math.round((vol.index / meta.total) * 100),
        index: vol.index,
        total: meta.total,
        bytes: vol.bytes,
        totalBytes: meta.archiveBytes,
        message: `写入第 ${vol.index}/${meta.total} 卷完成（${humanBytes(vol.bytes)}）`,
      });
      if (gapMs > 0 && vol.index < meta.total) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      return;
    } catch (err) {
      lastErr = err;
      logger?.warn('写卷失败', {
        versionId: meta.versionId,
        index: vol.index,
        attempt,
        message: describeImapError(err),
      });
      // 删掉可能已写进去的半成品，避免重试造成重复卷
      try {
        await removeVolumeCopies({ session, dataFolder, versionId: meta.versionId, index: vol.index });
      } catch {
        /* ignore */
      }
      if (attempt < MAX_RETRY_PER_VOLUME) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw new Error(
    `第 ${vol.index} 卷连续 ${MAX_RETRY_PER_VOLUME} 次写入失败：${describeImapError(lastErr)}`,
  );
}

/** 删掉某版本某卷的所有副本（重试前防重复）。 */
async function removeVolumeCopies({ session, dataFolder, versionId, index }) {
  const list = await session.listMessages(dataFolder);
  const targets = [];
  for (const msg of list) {
    const h = msg.headers || {};
    const vid = h['x-sync-shuttle-version-id'] || '';
    const vol = h['x-sync-shuttle-volume'] || '';
    if (vid.toLowerCase() === versionId.toLowerCase() && vol.startsWith(`${index}/`)) {
      targets.push(msg.seq);
    }
  }
  if (targets.length) {
    await session.deleteBySeq(dataFolder, targets);
  }
  return targets.length;
}

/**
 * 回读校验（校验 C）：close + 重新 SELECT，按 Version-Id 定位本版本，
 * 逐卷 seq 读回 → mailparser 解附件 → 重算 SHA-256。
 */
async function verifyUploaded({ session, dataFolder, meta, volumes, report }) {
  const list = await session.listMessages(dataFolder);
  const mine = list.filter((m) => {
    const h = m.headers || {};
    return (
      (h['x-sync-shuttle-version-id'] || '').toLowerCase() === meta.versionId.toLowerCase() &&
      (h['x-sync-shuttle-version'] || '') === meta.version
    );
  });

  if (mine.length !== volumes.length) {
    return {
      ok: false,
      message: `期望 ${volumes.length} 卷，实际只找到 ${mine.length} 卷（疑似写入未生效）`,
    };
  }

  // 按卷号排序，逐卷比对
  const byIndex = new Map();
  for (const m of mine) {
    const vol = m.headers['x-sync-shuttle-volume'] || '';
    const idx = Number(vol.split('/')[0]);
    byIndex.set(idx, m);
  }

  for (const vol of volumes) {
    const msg = byIndex.get(vol.index);
    if (!msg) return { ok: false, message: `回读时缺少第 ${vol.index} 卷` };

    let raw;
    try {
      raw = await session.fetchRawBySeq(dataFolder, msg.seq);
    } catch (err) {
      return { ok: false, message: `读取第 ${vol.index} 卷失败：${describeImapError(err)}` };
    }

    let attachment = null;
    try {
      const parsed = await simpleParser(raw);
      attachment = (parsed.attachments || []).find((a) => /\.(zip|7z)\.\d+$/i.test(a.filename || ''));
    } catch (err) {
      return { ok: false, message: `解析第 ${vol.index} 卷失败：${err.message}` };
    }
    if (!attachment) return { ok: false, message: `第 ${vol.index} 卷邮件里找不到附件` };

    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content || '');
    const got = await sha256BufferAsync(content);
    if (got !== vol.sha256) {
      return {
        ok: false,
        message: `第 ${vol.index} 卷哈希不符（期望 ${vol.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…）`,
      };
    }
    if (content.length !== vol.bytes) {
      return {
        ok: false,
        message: `第 ${vol.index} 卷字节数不符（期望 ${vol.bytes} 实得 ${content.length}）`,
      };
    }
    report('verifying', {
      percent: Math.round((vol.index / volumes.length) * 100),
      index: vol.index,
      total: volumes.length,
      bytes: vol.bytes,
      totalBytes: volumes.reduce((s, v) => s + v.bytes, 0),
      message: `回读校验 ${vol.index}/${volumes.length} 卷通过（${humanBytes(vol.bytes)}）`,
    });
  }

  return { ok: true };
}

function sha256BufferAsync(buf) {
  return import('node:crypto').then((crypto) =>
    crypto.createHash('sha256').update(buf).digest('hex'),
  );
}

/**
 * 清理旧版本（§4 第 ⑥ 步）。
 * 只针对本项目、只针对完整版本；失败只记日志不报错（否则会造成"新版本失败"的假故障）。
 *
 * 两种调用方式：
 *   cleanupOldVersions({ storage, project, keepVersion, keep, logger })          ← 新路径
 *   cleanupOldVersions({ session, dataFolder, project, keepVersion, keep, logger }) ← 旧路径
 */
export async function cleanupOldVersions(opts) {
  const { storage, session, dataFolder, project, keepVersion, keep, logger } = opts;
  const { aggregateVersions, groupByProject } = await import('./manifest.js');

  // 新路径：走 adapter 拿 entries
  if (storage) {
    const entries = await storage.list({ collection: 'data' });
    const versions = aggregateVersions(entries);
    const grouped = groupByProject(versions);
    const target = grouped.find((g) => g.project === project);
    if (!target) return { deleted: 0, message: '没有找到项目历史' };

    const others = target.history.filter((v) => v.version !== keepVersion);
    const keepCount = Math.max(1, Number(keep) || 1);
    const toDelete = others.slice(keepCount - 1);
    if (!toDelete.length) return { deleted: 0, message: '无需清理' };

    const refs = [];
    for (const v of toDelete) for (const vol of v.volumes) refs.push(vol.ref);
    try {
      await storage.remove({ collection: 'data', refs });
      logger?.info('已清理旧版本', {
        project,
        deletedVersions: toDelete.length,
        deletedMessages: refs.length,
      });
      return {
        deleted: toDelete.length,
        message: `已删除 ${toDelete.length} 个旧版本（${refs.length} 封邮件）`,
      };
    } catch (err) {
      logger?.warn('清理旧版本失败（不影响新版本）', {
        project,
        message: err?.message || String(err),
      });
      return {
        deleted: 0,
        message: `旧版本未清理（${err?.message || String(err)}），可稍后手动清理`,
      };
    }
  }

  const list = await session.listMessages(dataFolder);
  const versions = aggregateVersions(list);
  const grouped = groupByProject(versions);
  const target = grouped.find((g) => g.project === project);
  if (!target) return { deleted: 0, message: '没有找到项目历史' };

  // 排除刚上传的这一版，其余按版本降序
  const others = target.history.filter((v) => v.version !== keepVersion);
  const keepCount = Math.max(1, Number(keep) || 1);
  // keep=1 → 保留最新 1 个（即刚上传的），删所有 others
  // keep=2 → 保留最新 2 个（刚上传的 + 最近的 1 个 others）
  const toDelete = others.slice(keepCount - 1);
  if (!toDelete.length) return { deleted: 0, message: '无需清理' };

  const seqs = [];
  for (const v of toDelete) {
    for (const vol of v.volumes) seqs.push(vol.seq);
  }
  try {
    await session.deleteBySeq(dataFolder, seqs);
    logger?.info('已清理旧版本', { project, deletedVersions: toDelete.length, deletedMessages: seqs.length });
    return {
      deleted: toDelete.length,
      message: `已删除 ${toDelete.length} 个旧版本（${seqs.length} 封邮件）`,
    };
  } catch (err) {
    logger?.warn('清理旧版本失败（不影响新版本）', { project, message: describeImapError(err) });
    return {
      deleted: 0,
      message: `旧版本未清理（${describeImapError(err)}），可稍后手动清理`,
    };
  }
}
