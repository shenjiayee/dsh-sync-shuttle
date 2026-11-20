// 宿主半侧 RPC：用 ctx.webServer.register() 挂前缀路由。
//
// ⚠️ 不能用 ctx.connection.rpc.handle()（实测 POST 返回 405）。
// 线协议（与 ifos-monitor / dsh-better-sidebar / dshmarket 一致）：
//   客户端 POST /sync-shuttle/<endpoint>
//     body { type:'client-request', rpcId, method:<endpoint>, payload }
//   宿主回 { type:'server-response', rpcId, result }
//     result = { ok:true, value } | { ok:false, error:{ code, message } }
//
// 上传/下载是长任务，用「任务 + 轮询」而不是长连接：
//   job.start 立刻返回 jobId，客户端每 500ms 拉 job.status 拿进度。

import fs from 'node:fs';
import path from 'node:path';
import { resolveMailFolders } from './paths.js';
import { humanBytes, dirStats, isDriveRoot, checkWritableDir, humanDuration } from './util.js';
import { describeImapError } from './mail.js';
import { aggregateVersions, groupByProject, totalOccupied } from './manifest.js';

export const SYNC_SHUTTLE_RPC_CHANNEL = '/sync-shuttle';

export const ENDPOINTS = Object.freeze({
  status: 'status.get',
  settings: 'settings.get',
  settingsPatch: 'settings.patch',
  credentialsSave: 'credentials.save',
  credentialsClear: 'credentials.clear',
  testConnection: 'connection.test',
  projectsList: 'projects.list',
  projectBind: 'project.bind',
  projectCreate: 'project.create',
  projectDelete: 'project.delete',
  projectKeepPrev: 'project.keepPrev',
  projectCleanResidue: 'project.cleanResidue',
  uploadStart: 'upload.start',
  downloadStart: 'download.start',
  jobStatus: 'job.status',
  jobCancel: 'job.cancel',
  lockStatus: 'lock.status',
  configBackups: 'config.backups',
  configBackupNow: 'config.backupNow',
  configRestore: 'config.restore',
  logsRead: 'logs.read',
  capacityGet: 'capacity.get',
});

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JOB_RETENTION_MS = 10 * 60 * 1000;

const ok = (value) => ({ ok: true, value });
const fail = (code, message, extra) => ({ ok: false, error: { code, message, ...(extra || {}) } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

/**
 * @param deps { settings, bindings, identity, configBackup, logger, makeSession, makeLock, storage, folders }
 */
export function createDispatcher(deps) {
  const { settings, bindings, identity, configBackup, logger, makeSession, makeLock, storage } = deps;

  // 实际使用的远端文件夹名（生产名或测试前缀名）。
  // adapter 内部已知道自己用哪个；这里拿一份是为了 ping / dataFolder 提示。
  const folders = deps.folders || resolveMailFolders(settings.snapshot().folderPrefix);

  /** 后台任务表。 */
  const jobs = new Map();

  function newJob(kind, project) {
    const id = `JOB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const job = {
      id,
      kind,
      project,
      status: 'running',
      stage: 'starting',
      message: '准备中',
      percent: 0,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
      log: [],
    };
    jobs.set(id, job);
    // 清理老任务，避免进程长跑后内存堆积
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [k, v] of jobs.entries()) {
      if (v.finishedAt && v.finishedAt < cutoff) jobs.delete(k);
    }
    return job;
  }

  function jobReporter(job) {
    return {
      onProgress: (evt) => {
        job.stage = evt.stage || job.stage;
        if (typeof evt.percent === 'number') job.percent = evt.percent;
        if (evt.message) {
          job.message = evt.message;
          job.log.push({ at: new Date().toISOString(), message: evt.message });
          if (job.log.length > 200) job.log.shift();
        }
      },
      // 下载的确认与口令走「预检返回 NEED_* → 客户端补齐参数再调一次」，
      // 不在任务内部阻塞等待，避免 RPC 挂住。
      onNeedPassword: null,
      onConfirm: null,
    };
  }

  /** 取当前本机绑定表。 */
  async function currentBindings() {
    const res = await bindings.ensureBindings();
    return res;
  }

  /**
   * 只读模式守卫：readOnly=true 时禁止一切远端写操作（上传、删项目、清理残留…）。
   * 之前 readOnly 只在快照里回显、没有任何代码检查它，等于开关没接上。
   */
  function readOnlyBlocked(what) {
    if (!settings.snapshot().readOnly) return null;
    return fail(
      'READ_ONLY',
      `当前是只读模式，已禁止${what}。如需写入远端，请在 profile 的 cordis.patch.yml 里把 readOnly 设为 false 并重启 DSH`,
    );
  }

  /** 扫远端所有卷，聚合成项目清单。 */
  async function scanRemote() {
    const conn = settings.connection();
    if (!conn.account || !conn.token) {
      const err = new Error('未配置邮箱：请先在设置页填写邮箱地址与授权码');
      err.code = 'NO_CREDENTIALS';
      throw err;
    }
    // 通过 adapter 列对象，manifest 只认 entries 结构。
    // 若 adapter 不可用则直接报错——没有存储就没有项目清单，
    // 不再保留「另开 IMAP 会话兜底」的第二条路径（那会让换后端时行为不一致）。
    if (!storage) {
      const err = new Error('存储适配器不可用：无法读取项目清单');
      err.code = 'NO_STORAGE';
      throw err;
    }
    const entries = await storage.list({ collection: 'data' });
    const versions = aggregateVersions(entries);
    return { versions, occupiedBytes: totalOccupied(versions), folderExists: entries.length > 0 };
  }

  /** 合并视图：远端项目 ∪ 本地项目。 */
  async function buildProjectList() {
    const { bindings: local, source, recovered } = await currentBindings();
    let remote = { versions: [], occupiedBytes: 0, folderExists: false, error: null };
    try {
      remote = await scanRemote();
    } catch (err) {
      remote.error = { code: err.code || 'SCAN_FAILED', message: describeImapError(err) };
    }

    const grouped = groupByProject(remote.versions);
    const remoteNames = new Set(grouped.map((g) => g.project));
    const localByName = new Map(local.projects.map((p) => [p.name, p]));

    const projects = [];
    for (const g of grouped) {
      const bound = localByName.get(g.project) || null;
      projects.push({
        project: g.project,
        localDir: bound?.localDir || '',
        bound: Boolean(bound),
        // keepPrev 是本机偏好，优先取本机绑定表；没记录时回落到远端最新版邮件头
        keepPrev: bound?.keepPrev !== undefined ? Boolean(bound.keepPrev) : Boolean(g.latest?.keepPrev),
        latest: summariseVersion(g.latest),
        history: g.history.map(summariseVersion),
        versionCount: g.versionCount,
        occupiedBytes: g.occupiedBytes,
        state: bound ? 'linked' : 'unbound', // 蓝实心 / 灰虚线
      });
    }
    for (const p of local.projects) {
      if (remoteNames.has(p.name)) continue;
      projects.push({
        project: p.name,
        localDir: p.localDir,
        bound: true,
        keepPrev: p.keepPrev !== undefined ? Boolean(p.keepPrev) : Boolean(settings.snapshot().keepPrevDefault),
        latest: null,
        history: [],
        versionCount: 0,
        occupiedBytes: 0,
        state: 'local-only', // 蓝虚线「未上传」
      });
    }
    projects.sort((a, b) => {
      const at = a.latest?.uploadedAtMs || 0;
      const bt = b.latest?.uploadedAtMs || 0;
      if (bt !== at) return bt - at;
      return a.project.localeCompare(b.project, 'zh');
    });

    return {
      projects,
      bindingsSource: source,
      recovered,
      remoteError: remote.error,
      occupiedBytes: remote.occupiedBytes,
      capacityBytes: settings.snapshot().capacityBytes,
      machineId: identity.ensure().machineId,
      hostname: identity.ensure().hostname,
    };
  }

  function summariseVersion(v) {
    if (!v) return null;
    return {
      version: v.version,
      versionId: v.versionId,
      total: v.total,
      volumes: v.volumeCount,
      missing: v.missing,
      status: v.status,
      archiveBytes: v.archiveBytes,
      sourceBytes: v.sourceBytes,
      sourceFiles: v.sourceFiles,
      encrypted: v.encrypted,
      keepPrev: v.keepPrev,
      uploadedAtMs: v.uploadedAt ? v.uploadedAt.getTime() : 0,
      uploadedAt: v.uploadedAt ? v.uploadedAt.toISOString() : '',
      sizeText: humanBytes(v.sumBytes),
    };
  }

  /** 在远端找到一个具体版本（含每卷 ref）。 */
  async function findVersion(project, versionId) {
    if (!storage) {
      const err = new Error('存储适配器不可用：无法定位版本');
      err.code = 'NO_STORAGE';
      throw err;
    }
    const entries = await storage.list({ collection: 'data' });
    const versions = aggregateVersions(entries);
    return (
      versions.find((v) => v.project === project && (!versionId || v.versionId === versionId)) ||
      null
    );
  }

  const handlers = {
    async [ENDPOINTS.status]() {
      const snap = settings.snapshot();
      const me = identity.ensure();
      let lock = null;
      if (snap.hasToken) {
        try {
          const l = makeLock();
          lock = await l.status();
        } catch (err) {
          lock = { error: describeImapError(err) };
        }
      }
      return ok({
        configured: Boolean(snap.account && snap.hasToken),
        account: snap.accountMasked,
        hasToken: snap.hasToken,
        imapHost: snap.imapHost,
        imapPort: snap.imapPort,
        dataDir: snap.dataDir,
        archiveBackend: snap.archiveBackend,
        storageKind: snap.storageKind,
        storageInfo: storage
          ? {
              id: storage.id,
              displayName: storage.displayName,
              volumeBytes: storage.volumeBytes,
              maxObjectBytes: storage.maxObjectBytes,
            }
          : null,
        machineId: me.machineId,
        hostname: me.hostname,
        lock,
        capacityBytes: snap.capacityBytes,
        readOnly: snap.readOnly,
      });
    },

    async [ENDPOINTS.settings]() {
      const snap = settings.snapshot();
      const me = identity.ensure();
      return ok({ settings: snap, machineId: me.machineId, hostname: me.hostname });
    },

    async [ENDPOINTS.settingsPatch](payload) {
      // 设置只改运行期默认值；持久化由用户在 profile patch 里决定。
      // 这里返回当前快照，让界面知道生效值。
      return ok({ note: '设置项来自 profile 配置，运行期只读', settings: settings.snapshot(), applied: payload || {} });
    },

    async [ENDPOINTS.credentialsSave](payload) {
      const account = String(payload?.account || '').trim();
      const token = String(payload?.token || '').trim();
      if (!account || !token) return fail('INVALID', '邮箱地址与授权码都要填');
      try {
        const saved = settings.saveCredentials({ account, token });
        return ok(saved);
      } catch (err) {
        return fail('SAVE_FAILED', err.message);
      }
    },

    async [ENDPOINTS.credentialsClear]() {
      settings.clearCredentials();
      return ok({ cleared: true });
    },

    async [ENDPOINTS.testConnection]() {
      const { testConnection: probe } = await import('./mail.js');
      const conn = settings.connection();
      if (!conn.account || !conn.token) return fail('NO_CREDENTIALS', '请先填写邮箱地址与授权码');
      const res = await probe(conn, { logger, dataFolder: folders.data });
      return res.ok ? ok(res) : fail('CONNECT_FAILED', res.imap?.message || '连接失败', { detail: res });
    },

    async [ENDPOINTS.projectsList]() {
      try {
        return ok(await buildProjectList());
      } catch (err) {
        return fail(err.code || 'LIST_FAILED', describeImapError(err));
      }
    },

    async [ENDPOINTS.projectCreate](payload) {
      const name = String(payload?.name || '').trim();
      const localDir = String(payload?.localDir || '').trim();
      if (!name) return fail('INVALID_NAME', '项目名不能为空');
      if (!localDir) return fail('INVALID_DIR', '请选择本地目录');
      const dirErr = checkWritableDir(localDir);
      if (dirErr) return fail('INVALID_DIR', `本地目录不可用：${dirErr}`);
      if (isDriveRoot(localDir)) return fail('INVALID_DIR', '不要把盘符根目录当项目目录');

      const { bindings: current } = await currentBindings();
      // 唯一性：本地已有同名 → 拒绝（远端同名则属于「绑定」而非「新建」）
      if (bindings.findByName(current.projects, name)) {
        return fail('NAME_TAKEN', `本机已有同名项目「${name}」`);
      }
      const remote = await scanRemote().catch(() => ({ versions: [] }));
      const remoteHas = groupByProject(remote.versions).some((g) => g.project === name);
      if (remoteHas) {
        return fail(
          'NAME_ON_REMOTE',
          `远端已存在同名项目「${name}」，请直接在清单里为它绑定本地目录，不要新建`,
        );
      }

      const res = await bindings.mutateBindings((draft) => {
        draft.projects.push({ name, localDir });
        return draft;
      });
      return ok({
        project: name,
        localDir,
        backup: res.backup,
        note: res.backup?.ok ? '已保存并备份到远端' : '已保存到本机，远端备份待补',
      });
    },

    async [ENDPOINTS.projectBind](payload) {
      const name = String(payload?.name || '').trim();
      const localDir = String(payload?.localDir || '').trim();
      if (!name) return fail('INVALID_NAME', '项目名不能为空');
      if (!localDir) return fail('INVALID_DIR', '请选择本地目录');
      const dirErr = checkWritableDir(localDir);
      if (dirErr) return fail('INVALID_DIR', `本地目录不可用：${dirErr}`);
      if (isDriveRoot(localDir)) return fail('INVALID_DIR', '不要把盘符根目录当项目目录');

      const res = await bindings.mutateBindings((draft) => {
        const existing = draft.projects.find((p) => p.name === name);
        if (existing) existing.localDir = localDir;
        else draft.projects.push({ name, localDir });
        return draft;
      });
      return ok({
        project: name,
        localDir,
        backup: res.backup,
        note: res.backup?.ok ? '已更新并备份' : '已更新本机，远端备份待补',
      });
    },

    async [ENDPOINTS.projectDelete](payload) {
      const name = String(payload?.name || '').trim();
      const removeLocal = payload?.removeLocal === true;
      if (!name) return fail('INVALID_NAME', '项目名不能为空');
      // 只删本机绑定不动远端数据时，不属于远端写操作，只读模式下允许
      const conn = settings.connection();
      const touchesRemote = Boolean(conn.account && conn.token);
      if (touchesRemote) {
        const blocked = readOnlyBlocked('删除远端项目数据');
        if (blocked) return blocked;
      }

      const result = { project: name, deletedMessages: 0, removedLocal: false };
      if (touchesRemote) {
        // 通过 adapter 删除：ref 由 adapter 给出，不关心底层是 seq 还是路径
        const entries = await storage.list({ collection: 'data' });
        const versions = aggregateVersions(entries).filter((v) => v.project === name);
        const refs = [];
        for (const v of versions) for (const vol of v.volumes) refs.push(vol.ref);
        if (refs.length) {
          await storage.remove({ collection: 'data', refs });
          result.deletedMessages = refs.length;
        }
      }
      if (removeLocal) {
        await bindings.mutateBindings((draft) => {
          draft.projects = draft.projects.filter((p) => p.name !== name);
          return draft;
        });
        result.removedLocal = true;
      }
      return ok(result);
    },

    async [ENDPOINTS.projectKeepPrev](payload) {
      // 开关是「本机偏好」：落在 projects.json 里，下一次上传时写进邮件头并对历史版本生效。
      // 之前这里只回报不落库，导致界面上的按钮永远没效果。
      const name = String(payload?.name || '').trim();
      if (!name) return fail('INVALID_NAME', '项目名不能为空');
      const keepPrev = payload?.keepPrev === true;

      const { bindings: current } = await currentBindings();
      const existing = bindings.findByName(current.projects, name);
      if (!existing) return fail('NOT_BOUND', `项目「${name}」还没有绑定本地目录`);

      const res = await bindings.mutateBindings((draft) => {
        const target = draft.projects.find((p) => p.name === name);
        if (target) target.keepPrev = keepPrev;
        return draft;
      });
      return ok({
        project: name,
        keepPrev,
        backup: res.backup,
        note: keepPrev
          ? '已开启「保留上一版」：下一次上传后会保留最近 2 个版本'
          : '已关闭「保留上一版」：下一次上传后只保留最新 1 个版本',
      });
    },

    async [ENDPOINTS.projectCleanResidue](payload) {
      const name = String(payload?.name || '').trim();
      const blocked = readOnlyBlocked('清理远端残留');
      if (blocked) return blocked;
      const entries = await storage.list({ collection: 'data' });
      const versions = aggregateVersions(entries).filter((v) => v.project === name);
      // 只清「不完整」的版本
      const broken = versions.filter((v) => v.status !== 'complete');
      const refs = [];
      for (const v of broken) for (const vol of v.volumes) refs.push(vol.ref);
      if (!refs.length) return ok({ deleted: 0, message: '没有需要清理的残留' });
      await storage.remove({ collection: 'data', refs });
      return ok({ deleted: refs.length, message: `已清理 ${broken.length} 个不完整版本（${refs.length} 封）` });
    },

    async [ENDPOINTS.uploadStart](payload) {
      const name = String(payload?.name || '').trim();
      if (!name) return fail('INVALID_NAME', '项目名不能为空');
      const blocked = readOnlyBlocked('上传');
      if (blocked) return blocked;
      const { bindings: current } = await currentBindings();
      const bound = bindings.findByName(current.projects, name);
      if (!bound) return fail('NOT_BOUND', `项目「${name}」还没有绑定本地目录`);
      if (!fs.existsSync(bound.localDir)) return fail('DIR_MISSING', `本地目录不存在：${bound.localDir}`);
      const stats = dirStats(bound.localDir);
      if (!stats.files) return fail('DIR_EMPTY', '本地目录是空的，没有可上传的内容');

      const conn = settings.connection();
      if (!conn.account || !conn.token) return fail('NO_CREDENTIALS', '请先配置邮箱');

      const job = newJob('upload', name);
      // 容量预检：把远端真实占用带进上传流程，否则 upload.js 里的容量看护永远不生效
      let usedBytes = 0;
      try {
        const remote = await scanRemote();
        usedBytes = Number(remote.occupiedBytes) || 0;
        job.message = `剩余容量检查：已用 ${humanBytes(usedBytes)}`;
      } catch {
        /* 容量检查失败不阻断上传 */
      }

      // keepPrev 优先取本次请求，其次取本机绑定表里记录的值，最后交给 upload.js 回落配置默认
      const keepPrev = payload?.keepPrev === undefined ? bound.keepPrev : payload.keepPrev === true;

      const run = async () => {
        let lock = null;
        try {
          // 不再预先开 IMAP 会话：adapter 内部自己 ensureSession()，
          // 这样换后端时 web-rpc 完全不用知道「连接」长什么样。
          lock = makeLock({
            onLost: (err) => {
              job.log.push({ at: new Date().toISOString(), message: `锁心跳失败：${err?.message || String(err)}` });
            },
          });
          job.stage = 'locking';
          job.message = '正在获取远端锁';
          await lock.acquireWithRetry(`upload ${name}`, {
            onWait: ({ attempt, err }) => {
              job.message = `远端正被占用（${err.message}），排队中 ${attempt}`;
            },
          });

          const { runUpload } = await import('./upload.js');
          const result = await runUpload({
            storage,
            settings,
            logger,
            project: name,
            localDir: bound.localDir,
            dataFolder: folders.data,
            options: {
              volumeBytes: payload?.volumeBytes,
              keepPrev,
              // 容量看护用：远端已占字节（QQ 无 QUOTA，只能自己算）
              usedBytes,
            },
            reporter: jobReporter(job),
          });
          job.result = result;
          job.status = 'done';
          job.percent = 100;
          job.stage = 'done';
          job.message = `上传完成：${result.volumes} 卷 / ${humanBytes(result.archiveBytes)}`;
        } catch (err) {
          job.status = 'failed';
          job.stage = 'failed';
          job.error = { code: err.code || 'UPLOAD_FAILED', message: describeImapError(err) };
          job.message = job.error.message;
          logger?.error('上传失败', { project: name, message: job.message });
        } finally {
          if (lock) {
            try {
              await lock.release();
            } catch {
              /* ignore */
            }
          }
          job.finishedAt = Date.now();
        }
      };

      run().catch(() => {});
      return ok({ jobId: job.id, project: name, files: stats.files, bytes: stats.bytes });
    },

    async [ENDPOINTS.downloadStart](payload) {
      const name = String(payload?.name || '').trim();
      if (!name) return fail('INVALID_NAME', '项目名不能为空');
      // 只读模式允许下载
      const versionId = payload?.versionId || null;
      const { bindings: current } = await currentBindings();
      const bound = bindings.findByName(current.projects, name);
      if (!bound) return fail('NOT_BOUND', `项目「${name}」还没有绑定本地目录`);

      const conn = settings.connection();
      if (!conn.account || !conn.token) return fail('NO_CREDENTIALS', '请先配置邮箱');

      const job = newJob('download', name);
      const run = async () => {
        let lock = null;
        // target 必须在 try 外声明：catch 里要用它的 versionId 回填 need-input 任务，
        // 写进 try 里会变成块级 const，catch 访问直接 ReferenceError。
        let target = null;
        try {
          // 不开 IMAP 会话：adapter 内部自己 ensureSession()
          target = await findVersion(name, versionId);
          if (!target) throw new Error(`远端找不到项目「${name}」的版本`);
          if (target.status === 'missing') {
            throw new Error(`版本不完整，缺少第 ${target.missing.join('、')} 卷，无法解包`);
          }

          lock = makeLock({
            onLost: (err) => {
              job.log.push({ at: new Date().toISOString(), message: `锁心跳失败：${err?.message || String(err)}` });
            },
          });
          job.stage = 'locking';
          job.message = '正在获取远端锁';
          await lock.acquireWithRetry(`download ${name}`, {
            onWait: ({ attempt, err }) => {
              job.message = `远端正被占用（${err.message}），排队中 ${attempt}`;
            },
          });

          const { runDownload } = await import('./download.js');
          const result = await runDownload({
            storage,
            settings,
            logger,
            project: name,
            localDir: bound.localDir,
            version: target,
            dataFolder: folders.data,
            options: {
              confirm: payload?.confirm === true,
              backupBeforeDelete: payload?.backupBeforeDelete === true,
            },
            reporter: jobReporter(job),
          });
          job.result = result;
          job.status = 'done';
          job.percent = 100;
          job.stage = 'done';
          job.message = `下载完成：${result.filesWritten} 个文件 → ${result.targetDir}`;
        } catch (err) {
          if (err.code === 'NEED_CONFIRM') {
            // 需要用户补充信息：任务转为「等待输入」，客户端补齐参数后重新发起
            job.status = 'need-input';
            job.stage = err.code;
            job.versionId = target?.versionId || null;
            job.error = {
              code: err.code,
              message: err.message,
              plan: err.plan || null,
              versionId: target?.versionId || null,
            };
            job.message = err.message;
          } else {
            job.status = 'failed';
            job.stage = 'failed';
            job.error = { code: err.code || 'DOWNLOAD_FAILED', message: describeImapError(err) };
            job.message = job.error.message;
            logger?.error('下载失败', { project: name, message: job.message });
          }
        } finally {
          if (lock) {
            try {
              await lock.release();
            } catch {
              /* ignore */
            }
          }
          job.finishedAt = Date.now();
        }
      };

      run().catch(() => {});
      return ok({ jobId: job.id, project: name, versionId });
    },

    async [ENDPOINTS.jobStatus](payload) {
      const job = jobs.get(String(payload?.jobId || ''));
      if (!job) return fail('JOB_NOT_FOUND', '任务不存在或已过期');
      return ok({
        id: job.id,
        kind: job.kind,
        project: job.project,
        versionId: job.versionId || null,
        status: job.status,
        stage: job.stage,
        message: job.message,
        percent: job.percent,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        elapsedText: humanDuration((job.finishedAt || Date.now()) - job.startedAt),
        result: job.result,
        error: job.error,
        log: job.log.slice(-30),
      });
    },

    async [ENDPOINTS.jobCancel]() {
      // 上传/下载都在单线程里跑，无法安全强杀；只标记，让循环在下一卷前自行退出。
      // 第一版明确告知用户：取消会在当前卷结束后生效。
      return fail(
        'CANCEL_NOT_SUPPORTED',
        '取消会在当前分卷结束后生效，第一版暂不提供强制中断（避免留下不完整的远端数据）',
      );
    },

    async [ENDPOINTS.lockStatus]() {
      const conn = settings.connection();
      if (!conn.account || !conn.token) return fail('NO_CREDENTIALS', '请先配置邮箱');
      try {
        const lock = makeLock();
        return ok(await lock.status());
      } catch (err) {
        return fail('LOCK_STATUS_FAILED', describeImapError(err));
      }
    },

    async [ENDPOINTS.configBackups]() {
      const conn = settings.connection();
      if (!conn.account || !conn.token) return fail('NO_CREDENTIALS', '请先配置邮箱');
      // configBackup 内部每次操作自开会话，这里不需要额外连接
      const list = await configBackup.list();
      return ok({ backups: list });
    },

    async [ENDPOINTS.configBackupNow]() {
      const conn = settings.connection();
      if (!conn.account || !conn.token) return fail('NO_CREDENTIALS', '请先配置邮箱');
      try {
        // 手动「立即备份」：把本机当前绑定表整份推到远端（§3.5）
        // 只备份、不写本机（写本机会改 mtime、还会触发一次多余的原子写）
        const { bindings: current, backup } = await bindings.backupNow();
        return ok({
          ok: backup?.ok === true,
          at: backup?.at || null,
          count: current.projects.length,
          message: backup?.ok
            ? `已备份 ${current.projects.length} 个项目到远端`
            : `远端备份失败：${backup?.message || '未知原因'}`,
          backup,
        });
      } catch (err) {
        return fail('BACKUP_FAILED', describeImapError(err));
      }
    },

    async [ENDPOINTS.configRestore](payload) {
      const seq = Number(payload?.seq);
      if (!seq) return fail('INVALID', '缺少备份序号');
      try {
        const got = await configBackup.download(seq);
        const { bindings: current } = await currentBindings();
        const incoming = new Map(got.bindings.projects.map((p) => [p.name, p]));
        const existing = new Map(current.projects.map((p) => [p.name, p]));
        const added = [...incoming.keys()].filter((n) => !existing.has(n));
        const changed = [...incoming.keys()].filter(
          (n) => existing.has(n) && existing.get(n).localDir !== incoming.get(n).localDir,
        );
        const removed = [...existing.keys()].filter((n) => !incoming.has(n));
        const diff = { added, changed, removed };

        if (payload?.confirm !== true) {
          return ok({ needConfirm: true, diff, at: got.at, source: 'remote' });
        }

        // 应用前先把当前文件备份成 .bak-<ts>
        try {
          if (fs.existsSync(settings.paths.projects)) {
            const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
            fs.copyFileSync(settings.paths.projects, `${settings.paths.projects}.bak-${stamp}`);
          }
        } catch {
          /* ignore */
        }

        // 保留本机已有的 keepPrev 覆盖值（备份里可能没有这个字段）
        await bindings.mutateBindings((draft) => {
          const prev = new Map(draft.projects.map((p) => [p.name, p]));
          draft.projects = got.bindings.projects.map((p) => {
            const old = prev.get(p.name);
            const next = { name: p.name, localDir: p.localDir };
            if (old && old.keepPrev !== undefined) next.keepPrev = Boolean(old.keepPrev);
            return next;
          });
          return draft;
        });
        return ok({ applied: true, diff, at: got.at });
      } catch (err) {
        return fail('RESTORE_FAILED', err.message);
      }
      // 注意：这里不能写 finally { await session.close() }。
      // configBackup 每次操作自己开/关临时会话，本 handler 作用域内没有 session，
      // 之前那行会让无论成功失败都抛 ReferenceError，恢复永远报错。
    },

    async [ENDPOINTS.logsRead](payload) {
      const days = Math.min(7, Math.max(1, Number(payload?.days) || 1));
      const out = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date(Date.now() - i * 86400000);
        const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const file = path.join(settings.paths.logsDir, `sync-shuttle-${key}.log`);
        try {
          const text = fs.readFileSync(file, 'utf8');
          const lines = text.trim().split('\n').filter(Boolean).slice(-200);
          out.push({ date: key, lines });
        } catch {
          out.push({ date: key, lines: [] });
        }
      }
      return ok({ logs: out });
    },

    async [ENDPOINTS.capacityGet]() {
      try {
        const remote = await scanRemote();
        const cap = settings.snapshot().capacityBytes;
        return ok({
          occupiedBytes: remote.occupiedBytes,
          occupiedText: humanBytes(remote.occupiedBytes),
          capacityBytes: cap,
          capacityText: humanBytes(cap),
          percent: cap > 0 ? Math.round((remote.occupiedBytes / cap) * 100) : 0,
          note: '仅统计本插件占用（QQ 不提供 QUOTA，真实邮箱用量请在网页版查看）',
        });
      } catch (err) {
        return fail('CAPACITY_FAILED', describeImapError(err));
      }
    },
  };

  return async function handle(req, res, url) {
    const pathname = String(url || req.url || '');
    const endpoint = pathname.startsWith(SYNC_SHUTTLE_RPC_CHANNEL)
      ? pathname.slice(SYNC_SHUTTLE_RPC_CHANNEL.length).replace(/^\//, '').split('?')[0]
      : '';

    if (req.method !== 'POST') {
      sendJson(res, 405, fail('METHOD_NOT_ALLOWED', '只接受 POST'));
      return;
    }
    // 必须要求 JSON：与 ifos-monitor 一致，否则 text/plain 的合法 JSON 也能进来，
    // 等于给跨站表单留了个口子。
    const ctype = String(req.headers?.['content-type'] || '').toLowerCase();
    if (!ctype.includes('application/json')) {
      sendJson(res, 415, fail('UNSUPPORTED_MEDIA_TYPE', 'content-type 必须是 application/json'));
      return;
    }
    if (!endpoint) {
      sendJson(res, 404, fail('NOT_FOUND', '缺少 endpoint'));
      return;
    }
    const handler = handlers[endpoint];
    if (!handler) {
      sendJson(res, 404, fail('UNKNOWN_ENDPOINT', `未知接口：${endpoint}`));
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, fail('BAD_REQUEST', err.message));
      return;
    }

    if (body?.type !== 'client-request' || body.method !== endpoint) {
      sendJson(res, 400, fail('BAD_REQUEST', '报文格式不符（type/method）'));
      return;
    }

    try {
      const result = await handler(body.payload || {});
      sendJson(res, 200, { type: 'server-response', rpcId: body.rpcId, result });
    } catch (err) {
      logger?.error('RPC 执行异常', { endpoint, message: err.message });
      sendJson(res, 200, {
        type: 'server-response',
        rpcId: body.rpcId,
        result: fail(err.code || 'INTERNAL', describeImapError(err)),
      });
    }
  };
}
