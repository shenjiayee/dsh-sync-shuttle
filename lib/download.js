// 下载流程（§6）：远端版本 → 本地目录，镜像覆盖。
//
// 镜像的含义（m00942 用户确认）：下载完成后本地目录必须与上传时的源目录**完全一致**，
// 包里没有的文件要删掉。这是危险操作，所以有四道保护（§10.5）：
//   1. 执行前展示「将新增/覆盖 N 个、将删除 M 个」清单，必须人工确认
//   2. 可选先备份将被删除的文件到 <目标>\.ss-backup-<ts>\
//   3. 目录白名单：拒绝盘符根目录、拒绝空路径
//   4. 源=目标 时直接拒绝
//
// 断点续传：已下完并校验通过的卷留在 tmp\fetch\<versionId>\ 并带 .ok 标记，
// 重试时逐个比对 .ok 里的 SHA-256，一致就跳过、不一致就删掉重下。

import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import {
  checkSevenZip,
  extractArchive,
  listArchive,
  mergeVolumes,
} from './archive.js';
import { sha256Buffer, sha256File, humanBytes, humanDuration, isDriveRoot, walkFiles } from './util.js';
import { describeImapError } from './mail.js';

const BACKUP_DIR_NAME = '.ss-backup';

/** 从一封卷邮件里解出附件 Buffer。 */
async function extractVolumeAttachment(raw) {
  const parsed = await simpleParser(raw);
  // 新版是 .zip.NNN；同时兼容旧版已上传的 .7z.NNN（能否解开由后面的加密判断决定）
  const attachment = (parsed.attachments || []).find((a) => /\.(zip|7z)\.\d+$/i.test(a.filename || ''));
  if (!attachment) return null;
  return Buffer.isBuffer(attachment.content)
    ? attachment.content
    : Buffer.from(attachment.content || '');
}

/** 读 .ok 标记（内含 SHA-256），与期望值一致才算有效。 */
function readOkMarker(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 执行一次完整下载 + 镜像覆盖。
 * @param ctx { session, settings, logger, project, localDir, version, options, reporter, dataFolder }
 */
export async function runDownload(ctx) {
  const {
    storage,
    session,
    settings,
    logger,
    project,
    localDir,
    version,
    options = {},
    reporter = {},
    dataFolder,
  } = ctx;

  const snap = settings.snapshot();
  const report = (stage, detail) => {
    try {
      reporter.onProgress?.({ stage, ...detail });
    } catch {
      /* 界面回调异常绝不影响流程 */
    }
  };

  // ── 保护 3/4：目标目录合法性
  if (!localDir || !String(localDir).trim()) {
    throw new Error('没有绑定本地目录：请先为这个项目选择目标文件夹');
  }
  if (isDriveRoot(localDir)) {
    throw new Error(`拒绝把盘符根目录当作镜像目标：${localDir}（镜像会删除包里没有的文件）`);
  }
  const targetDir = path.resolve(localDir);
  if (options.sourceDir && path.resolve(options.sourceDir) === targetDir) {
    throw new Error('源目录与目标目录相同：请换一个目标文件夹（镜像会删除文件）');
  }

  // 归档后端已是内置纯 JS ZIP，不再需要外部 7-Zip
  const backend = await checkSevenZip();
  if (!backend.ok) throw new Error(`归档后端不可用：${backend.message}`);

  if (!version || !version.volumes?.length) {
    throw new Error('没有可下载的版本');
  }
  if (version.status === 'missing') {
    throw new Error(
      `版本不完整，缺少第 ${version.missing.join('、')} 卷，无法解包。` +
        `请在另一台电脑重新上传，或选择其他版本。`,
    );
  }

  // 加密包已被移除（方案 A3）。若远端下载到旧版 7z 加密包，明确告知不支持，
  // 而不是静默失败或让用户干等。
  if (version.encrypted) {
    const err = new Error(
      '该版本是旧版加密归档，当前版本已移除加密支持，无法解包。请在另一台电脑用新版本重新上传。',
    );
    err.code = 'ENCRYPTED_UNSUPPORTED';
    throw err;
  }

  const fetchRoot = path.join(settings.paths.fetchDir, version.versionId);
  fs.mkdirSync(fetchRoot, { recursive: true });

  const started = Date.now();

  // ── ② 逐卷下载 + 校验 D
  report('downloading', {
    percent: 0,
    index: 0,
    total: version.volumes.length,
    bytes: 0,
    totalBytes: version.archiveBytes,
    message: `准备下载 ${version.volumes.length} 卷（共 ${humanBytes(version.archiveBytes)}）`,
  });
  const localVolumes = [];
  let downloadedBytes = 0;
  let skippedVolumes = 0;

  for (const vol of version.volumes) {
    const name = `${version.versionId}.zip.${String(vol.index).padStart(3, '0')}`;
    const file = path.join(fetchRoot, name);
    const okFile = `${file}.ok`;

    // 续传：已下完且哈希一致就跳过
    if (fs.existsSync(file) && fs.existsSync(okFile)) {
      const marked = readOkMarker(okFile);
      if (marked === vol.sha256) {
        localVolumes.push({ index: vol.index, file, bytes: vol.bytes });
        skippedVolumes += 1;
        downloadedBytes += vol.bytes;
        report('downloading', {
          message: `第 ${vol.index}/${version.volumes.length} 卷已存在且校验通过，跳过`,
          index: vol.index,
          total: version.volumes.length,
          bytes: downloadedBytes,
          totalBytes: version.archiveBytes,
          percent: Math.round((downloadedBytes / version.archiveBytes) * 100),
        });
        continue;
      }
      // .ok 与实际期望不符 → 不可信，删掉重下
      try {
        fs.rmSync(file, { force: true });
        fs.rmSync(okFile, { force: true });
      } catch {
        /* ignore */
      }
    }

    let content = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (storage) {
          // 新路径：ref 是 adapter 给的不透明句柄（QQ 上是 seq，SMB 上是路径）
          const got = await storage.get({ collection: 'data', ref: vol.ref });
          content = Buffer.isBuffer(got?.body) ? got.body : Buffer.from(got?.body || []);
          if (!content.length) throw new Error('读回的分卷内容为空');
        } else {
          const raw = await session.fetchRawBySeq(dataFolder, vol.seq);
          content = await extractVolumeAttachment(raw);
          if (!content) throw new Error('邮件里找不到分卷附件');
        }
        break;
      } catch (err) {
        lastErr = err;
        logger?.warn('下载卷失败', {
          index: vol.index,
          attempt,
          message: describeImapError(err),
        });
        if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    if (!content) {
      throw new Error(`第 ${vol.index} 卷下载失败：${describeImapError(lastErr)}`);
    }

    // 校验 D：立刻比对 SHA-256 与字节数
    const got = sha256Buffer(content);
    if (got !== vol.sha256) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      throw new Error(
        `第 ${vol.index} 卷哈希不符（期望 ${vol.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…），` +
          `数据在服务器上可能已损坏，已拒绝继续`,
      );
    }
    if (content.length !== vol.bytes) {
      throw new Error(`第 ${vol.index} 卷字节数不符（期望 ${vol.bytes} 实得 ${content.length}）`);
    }

    fs.writeFileSync(file, content);
    fs.writeFileSync(okFile, got);
    localVolumes.push({ index: vol.index, file, bytes: content.length });
    downloadedBytes += content.length;
    report('downloading', {
      message: `第 ${vol.index}/${version.volumes.length} 卷完成（${humanBytes(content.length)}）`,
      index: vol.index,
      total: version.volumes.length,
      bytes: downloadedBytes,
      totalBytes: version.archiveBytes,
      percent: Math.round((downloadedBytes / version.archiveBytes) * 100),
    });
  }

  // ── ③ 合并 + 整包校验（校验 E）
  report('merging', { message: '合并分卷并校验整包' });
  const mergedFile = path.join(fetchRoot, `${version.versionId}.merged.zip`);
  const volumeFiles = localVolumes.sort((a, b) => a.index - b.index).map((v) => v.file);
  await mergeVolumes(volumeFiles, mergedFile);

  const mergedBytes = fs.statSync(mergedFile).size;
  if (version.archiveBytes && mergedBytes !== version.archiveBytes) {
    throw new Error(
      `合并后整包大小不符（清单 ${version.archiveBytes} 实得 ${mergedBytes}），已拒绝解包`,
    );
  }
  if (version.archiveSha256) {
    const mergedSha = await sha256File(mergedFile);
    if (mergedSha !== version.archiveSha256) {
      throw new Error(
        `合并后整包 SHA-256 不符（清单 ${version.archiveSha256.slice(0, 12)}… 实得 ${mergedSha.slice(0, 12)}…），` +
          `已拒绝解包`,
      );
    }
  }

  // ── ④ 读到归档内文件清单
  report('planning', { message: '计算将写入与将删除的文件' });
  const listed = await listArchive(mergedFile);
  if (!listed.ok) {
    throw new Error(`读取归档索引失败：${listed.message}`);
  }

  const archiveFiles = new Set(listed.files.map((f) => normalizeRel(f.rel)));
  const incomingBytes = new Map(listed.files.map((f) => [normalizeRel(f.rel), Number(f.bytes) || 0]));
  const existing = walkFiles(targetDir)
    .filter((f) => !isInsideBackup(f.rel))
    .map((f) => ({ rel: normalizeRel(f.rel), bytes: f.bytes }));
  const existingMap = new Map(existing.map((f) => [f.rel, f.bytes]));

  // 「覆盖」只统计内容确实不同的文件（§6 步骤④：界面要报「覆盖 N / 删除 M」）。
  // 之前按「同名」统计，导致内容完全一致的文件也被算成覆盖，
  // 用户看到「覆盖 800 个」而实际一个字节都没变，很容易劝退。
  // 这里用大小做代理判断：大小相同视为未变（不算覆盖），大小不同必须覆盖。
  const sameFiles = [];
  const overwriteFiles = [];
  for (const [rel, bytes] of incomingBytes) {
    if (!existingMap.has(rel)) continue;
    if (existingMap.get(rel) === bytes) sameFiles.push(rel);
    else overwriteFiles.push(rel);
  }

  const toDelete = existing.filter((f) => !archiveFiles.has(f.rel));
  const toCreate = archiveFiles.size - sameFiles.length - overwriteFiles.length;
  const toOverwrite = overwriteFiles.length;

  const plan = {
    targetDir,
    toCreate,
    toOverwrite,
    toUnchanged: sameFiles.length,
    toDeleteCount: toDelete.length,
    toDeleteBytes: toDelete.reduce((s, f) => s + f.bytes, 0),
    toDelete: toDelete.slice(0, 200).map((f) => f.rel),
    overwriteSample: overwriteFiles.slice(0, 50),
    incomingFiles: archiveFiles.size,
  };

  // ── 保护 1：必须确认
  if (typeof reporter.onConfirm === 'function') {
    const yes = await reporter.onConfirm(plan);
    if (!yes) {
      const err = new Error('已取消：未确认镜像覆盖（本地文件未改动）');
      err.code = 'CANCELLED';
      throw err;
    }
  } else if (options.confirm !== true) {
    const err = new Error(
      `镜像覆盖需要确认：将新建 ${toCreate} 个、覆盖 ${toOverwrite} 个、` +
        `删除 ${toDelete.length} 个文件（未变 ${sameFiles.length} 个）`,
    );
    err.code = 'NEED_CONFIRM';
    err.plan = plan;
    // 保留已下载的卷，下次确认后直接复用
    throw err;
  }

  // ── 保护 2：可选备份将被删除的文件
  let backupDir = null;
  if (options.backupBeforeDelete && toDelete.length) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
    backupDir = path.join(targetDir, `${BACKUP_DIR_NAME}-${stamp}`);
    for (const f of toDelete) {
      const src = path.join(targetDir, f.rel);
      const dst = path.join(backupDir, f.rel);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (err) {
        logger?.warn('备份待删文件失败', { rel: f.rel, message: err.message });
      }
    }
    report('planning', { message: `已备份 ${toDelete.length} 个待删文件到 ${backupDir}` });
  }

  // ── ⑥ 解包（覆盖同名）
  report('extracting', { message: `解包到 ${targetDir}` });
  fs.mkdirSync(targetDir, { recursive: true });
  await extractArchive(mergedFile, targetDir);

  // ── ⑦ 镜像删除：删掉包里没有的文件
  const deleted = [];
  if (toDelete.length) {
    report('mirroring', { message: `删除 ${toDelete.length} 个包内不存在的文件` });
    for (const f of toDelete) {
      const abs = path.join(targetDir, f.rel);
      try {
        fs.rmSync(abs, { force: true });
        deleted.push(f.rel);
      } catch (err) {
        logger?.warn('删除多余文件失败', { rel: f.rel, message: err.message });
      }
    }
    pruneEmptyDirs(targetDir);
  }

  // ── ⑧ 抽查报告（校验 F）
  const after = walkFiles(targetDir).filter((f) => !isInsideBackup(f.rel));
  const afterSet = new Set(after.map((f) => normalizeRel(f.rel)));
  const missingAfter = [...archiveFiles].filter((r) => !afterSet.has(r));
  const extraAfter = [...afterSet].filter((r) => !archiveFiles.has(r));
  const afterBytes = after.reduce((s, f) => s + f.bytes, 0);

  report('done', { message: '下载完成' });

  return {
    ok: true,
    project,
    version: version.version,
    versionId: version.versionId,
    targetDir,
    filesWritten: archiveFiles.size,
    created: toCreate,
    overwritten: toOverwrite,
    unchanged: sameFiles.length,
    deleted: deleted.length,
    bytes: afterBytes,
    volumeCount: localVolumes.length,
    skippedVolumes,
    backupDir,
    missingAfter,
    extraAfter,
    elapsedMs: Date.now() - started,
    elapsedText: humanDuration(Date.now() - started),
  };
}

/** 统一成目录内的相对路径（正斜杠、无前导 ./）。 */
function normalizeRel(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** 备份目录本身不算进镜像比对。 */
function isInsideBackup(rel) {
  return normalizeRel(rel).startsWith(`${BACKUP_DIR_NAME}-`);
}

/** 删掉空目录（镜像后可能留下一堆空壳）。 */
function pruneEmptyDirs(rootDir) {
  const dirs = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(rootDir, rel) : rootDir;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const childRel = rel ? path.join(rel, e.name) : e.name;
        dirs.push(childRel);
        stack.push(childRel);
      }
    }
  }
  // 从最深的开始删，这样父目录才有机会变空
  dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const rel of dirs) {
    if (String(rel).startsWith(BACKUP_DIR_NAME)) continue;
    try {
      const abs = path.join(rootDir, rel);
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 清理过期的下载缓存（§10.4：mtime > 7 天的整个版本目录删掉）。
 * 每次启动调一次。
 */
export function pruneFetchCache(fetchDir, { maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(fetchDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const abs = path.join(fetchDir, e.name);
    let latest = 0;
    try {
      for (const f of fs.readdirSync(abs)) {
        const st = fs.statSync(path.join(abs, f));
        if (st.mtimeMs > latest) latest = st.mtimeMs;
      }
    } catch {
      continue;
    }
    if (latest && now - latest > maxAgeMs) {
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        removed.push(e.name);
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}
