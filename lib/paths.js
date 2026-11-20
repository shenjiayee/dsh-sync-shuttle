// 本机数据目录与远端文件夹名。
//
// 所有路径集中在这里，避免业务代码到处拼字符串。
// 本机状态放 $DSH_HOME/sync-shuttle/（沿用 ifos-monitor 等插件的约定，
// 不往 profile 目录里塞数据）。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * 远端（QQ 邮箱）里的三个文件夹的基础名。名字必须是纯 ASCII。
 *
 * ⚠️ 实际用的名字由 resolveMailFolders() 在基础名前**拼接前缀**得到。
 * 这样做是为了让**测试与生产彻底隔离**：测试跑在带前缀的独立文件夹里，
 * 即使测试中途崩溃、清理失败，也绝不会碰到生产数据、生产锁、生产配置备份。
 */
const BASE_FOLDERS = Object.freeze({
  data: 'Sync-Shuttle',
  config: 'Sync-Shuttle-Config',
  lock: 'Sync-Shuttle-Lock',
});

/**
 * 解析当前应使用的远端文件夹名。
 *
 * 前缀来源（优先级从高到低）：
 *   1. 显式传入的 folderPrefix 参数
 *   2. 环境变量 SS_FOLDER_PREFIX
 *   3. 空 → 生产文件夹 Sync-Shuttle / Sync-Shuttle-Config / Sync-Shuttle-Lock
 *
 * 前缀是**真正的前缀**——拼在基础名前面，语义与字段名一致：
 *   prefix='Test-' →
 *     Test-Sync-Shuttle / Test-Sync-Shuttle-Config / Test-Sync-Shuttle-Lock
 *
 * 因此前缀通常以 '-' 结尾（如 'Test-'），便于和后接的基础名分隔开。
 * 不强制要求，但推荐。
 *
 * 前缀里只允许 [A-Za-z0-9-]，保证生成的文件夹名仍是纯 ASCII——
 * 中文文件夹名在 IMAP 上要经过 modified UTF-7 编码，客户端之间容易对不上。
 *
 * @param folderPrefix 可选前缀，如 'Test-'
 * @returns {{data: string, config: string, lock: string, prefix: string}}
 */
export function resolveMailFolders(folderPrefix) {
  const raw = folderPrefix ?? process.env.SS_FOLDER_PREFIX ?? '';
  const prefix = String(raw).trim();
  if (prefix && !/^[A-Za-z0-9-]+$/.test(prefix)) {
    throw new Error(`非法文件夹前缀：${prefix}（只允许字母、数字、连字符）`);
  }
  return {
    data: `${prefix}${BASE_FOLDERS.data}`,
    config: `${prefix}${BASE_FOLDERS.config}`,
    lock: `${prefix}${BASE_FOLDERS.lock}`,
    prefix,
  };
}

/**
 * 生产环境的远端文件夹名（默认值）。
 * 业务代码应优先使用通过 adapter/settings 传下来的实际文件夹名，
 * 只有明确「就是要生产名」的地方（如诊断脚本）才直接用它。
 */
export const MAIL_FOLDERS = Object.freeze({ ...BASE_FOLDERS });

/** 主题前缀。机器判定一律走自定义头，前缀只用于粗筛。 */
export const SUBJECT_PREFIX = '[SYNC-SHUTTLE]';
export const CONFIG_SUBJECT_PREFIX = '[SYNC-SHUTTLE-CONFIG]';

/** 自定义头（值必须纯 ASCII，见说明书 §3.2）。 */
export const HEADERS = Object.freeze({
  project: 'X-Sync-Shuttle-Project',
  version: 'X-Sync-Shuttle-Version',
  versionId: 'X-Sync-Shuttle-Version-Id',
  volume: 'X-Sync-Shuttle-Volume',
  volumeBytes: 'X-Sync-Shuttle-Volume-Bytes',
  volumeSha256: 'X-Sync-Shuttle-Volume-Sha256',
  archiveBytes: 'X-Sync-Shuttle-Archive-Bytes',
  archiveSha256: 'X-Sync-Shuttle-Archive-Sha256',
  sourceBytes: 'X-Sync-Shuttle-Source-Bytes',
  sourceFiles: 'X-Sync-Shuttle-Source-Files',
  encrypted: 'X-Sync-Shuttle-Encrypted',
  keepPrev: 'X-Sync-Shuttle-Keep-Prev',
});

/** 锁邮件专用头（§10.8.3）。 */
export const LOCK_HEADERS = Object.freeze({
  owner: 'X-Sync-Shuttle-Lock-Owner',
  nonce: 'X-Sync-Shuttle-Lock-Nonce',
  at: 'X-Sync-Shuttle-Lock-At',
  ttl: 'X-Sync-Shuttle-Lock-Ttl',
  op: 'X-Sync-Shuttle-Lock-Op',
});

/** 配置备份邮件的标识头。 */
export const CONFIG_HEADERS = Object.freeze({
  machineId: 'X-Sync-Shuttle-Machine',
  hostname: 'X-Sync-Shuttle-Hostname',
  at: 'X-Sync-Shuttle-Config-At',
  sha256: 'X-Sync-Shuttle-Config-Sha256',
});

/** 默认参数（§8）。 */
export const DEFAULTS = Object.freeze({
  volumeBytes: 40 * 1024 * 1024,
  volumeGapMs: 600,
  lockTtlMs: 300_000,
  lockHeartbeatMs: 60_000,
  lockRetryIntervalMs: 3_000,
  lockRetryMax: 20,
  lockGraceMs: 60_000,
  // 容量基线：QQ 免费邮箱上限 16 GB，但**刻意只用 12 GB** ——
  // 留 4 GB 给收件箱、已发送、其他文件夹，以及服务商自身的对齐损耗。
  // 邮箱被占满会导致新邮件被拒（连正常收信都失败），风险远大于少存几 GB。
  capacityBytes: 12 * 1024 * 1024 * 1024,
  maxUploadBytes: 0, // 0 = 无硬限
});

/**
 * 解析本机数据目录。
 * @param env NodeJS.ProcessEnv
 */
export function resolveDataDir(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sync-shuttle');
}

/**
 * 组装数据目录下所有具体路径。
 * @param dataDir string
 */
export function buildPaths(dataDir) {
  return {
    root: dataDir,
    projects: path.join(dataDir, 'projects.json'),
    machine: path.join(dataDir, 'machine.json'),
    credentials: path.join(dataDir, 'credentials.json'),
    cacheDir: path.join(dataDir, 'cache'),
    manifestCache: path.join(dataDir, 'cache', 'manifest.json'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.join(dataDir, 'tmp'),
    buildDir: path.join(dataDir, 'tmp', 'build'),
    fetchDir: path.join(dataDir, 'tmp', 'fetch'),
  };
}

/** 确保数据目录结构存在。 */
export function ensureDirs(paths) {
  for (const dir of [
    paths.root,
    paths.cacheDir,
    paths.logsDir,
    paths.tmpDir,
    paths.buildDir,
    paths.fetchDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
