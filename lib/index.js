// 插件入口。
//
// 单例兜底：link: 方式安装时，DSH 热重载会再次调用 apply()，
// 若不清理上一次实例，会出现双 dispatcher / 双定时器。
// 沿用 ifos-monitor 的做法：globalThis[Symbol.for(...)]。

import fs from 'node:fs';
import { createSettings } from './settings.js';
import { createLogger } from './log.js';
import { createMachineIdentity, createConfigBackup } from './config-store.js';
import { createBindingsStore } from './bindings.js';
import { MailSession } from './mail.js';
import { createDispatcher, SYNC_SHUTTLE_RPC_CHANNEL } from './web-rpc.js';
import { MAIL_FOLDERS, ensureDirs, resolveMailFolders } from './paths.js';
import { createStorageAdapter } from './storage/index.js';
import { LeaseGuard } from './lease.js';

export const name = 'sync-shuttle';
export const inject = ['tools'];

const INSTANCE_KEY = Symbol.for('dsh-sync-shuttle.instance');
const WEB_RETRY_MS = 500;
const WEB_RETRY_MAX = 20;

/**
 * 拿 webServer 服务。
 * Cordis 的 ctx 是 Proxy：访问尚未就绪的服务会直接抛错，
 * 所以必须 try 包裹，并且再兜一层 ctx.get()（ifos-monitor 的写法）。
 */
function webServerOf(ctx) {
  try {
    const direct = ctx?.webServer;
    if (direct && typeof direct.register === 'function') return direct;
  } catch {
    /* 服务还没就绪，继续兜底 */
  }
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('webServer') : null;
    if (viaGet && typeof viaGet.register === 'function') return viaGet;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 取环境变量表。
 *
 * 环境变量不是 Cordis 服务：`ctx.env` 未在 inject 声明时会直接抛
 * `cannot get property "env" without inject`，插件因此整个激活失败。
 * 这里按 ifos-monitor 取 webServer 的同样写法——try 包裹后回退 process.env。
 * DSH_HOME 缺失时 resolveDataDir 会退回 ~/.dsh，结果与宿主一致。
 */
function envOf(ctx) {
  try {
    const direct = ctx?.env;
    if (direct && typeof direct === 'object') return direct;
  } catch {
    /* 不是服务，正常回退 */
  }
  return process.env;
}

export function apply(ctx, rawConfig = {}) {
  const previous = globalThis[INSTANCE_KEY];
  globalThis[INSTANCE_KEY] = null;
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch {
      /* ignore */
    }
  }

  const env = envOf(ctx);
  const settings = createSettings(rawConfig || {}, { env });
  const paths = settings.paths;
  ensureDirs(paths);
  const logger = createLogger({ logsDir: paths.logsDir, level: settings.snapshot().logLevel });

  // 启动清理（§10.4）：build 全删；fetch 保留用于续传
  try {
    fs.rmSync(paths.buildDir, { recursive: true, force: true });
    fs.mkdirSync(paths.buildDir, { recursive: true });
  } catch (err) {
    logger.warn('清理打包临时目录失败', { message: err.message });
  }

  const identity = createMachineIdentity({ paths, logger });

  /** 开一个已连接的新会话（调用方负责 close）。 */
  async function makeSession() {
    const session = new MailSession(settings.connection(), { logger });
    await session.connect();
    return session;
  }

  // ── 存储适配器（adapter pattern）─────────────────────────────────
  //
  // 核心流程只认这个 adapter，不再直接依赖 IMAP 细节。
  //
  // 远端文件夹名在这里解析：
  //   生产 → sync-shuttle / -config / -lock
  //   测试 → 由 SS_FOLDER_PREFIX 加前缀（如 sync-shuttle-test-），
  //          让测试与生产数据彻底隔离，测试崩溃也不会碰到生产邮件。
  const snap0 = settings.snapshot();
  const storageKind = snap0.storageKind || 'qqmail';
  let folders;
  try {
    folders = resolveMailFolders(snap0.folderPrefix);
  } catch (err) {
    logger.error('远端文件夹前缀非法，回落到生产文件夹', { message: err.message });
    folders = resolveMailFolders();
  }
  if (folders.prefix) {
    logger.warn('当前使用带前缀的远端文件夹（测试隔离模式）', {
      data: folders.data,
      config: folders.config,
      lock: folders.lock,
    });
  }

  let storage = null;
  try {
    storage = createStorageAdapter(storageKind, {
      makeSession,
      logger,
      settings,
      folders,
      capacityBytes: snap0.capacityBytes,
    });
  } catch (err) {
    // adapter 构造失败不应让整个插件起不来：旧路径仍然可用，
    // 但要在日志里说清楚，否则以后切过去会莫名其妙失败。
    logger.error('存储适配器构造失败（旧路径仍可用）', {
      kind: storageKind,
      message: err.message,
    });
  }

  /**
   * 每次操作一个新的锁对象。
   * 锁一律走 LeaseGuard + adapter 原语（原 RemoteLock 已删除）。
   * adapter 构造失败会直接报错——没有 adapter 就没有存储，锁也无从谈起。
   */
  function makeLock(extra = {}) {
    if (!storage) {
      const err = new Error('存储适配器不可用：无法建立远端锁');
      err.code = 'NO_STORAGE';
      throw err;
    }
    const snap = settings.snapshot();
    const me = identity.ensure();
    return new LeaseGuard(storage, {
      logger,
      ttlMs: snap.lockTtlMs,
      heartbeatMs: snap.lockHeartbeatMs,
      machineId: me.machineId,
      hostname: me.hostname,
      ...extra,
    });
  }

  const configBackup = createConfigBackup({
    storage,
    makeSession,
    identity,
    logger,
    folder: folders.config,
  });
  const bindings = createBindingsStore({ paths, logger, configBackup });

  const dispatcher = createDispatcher({
    settings,
    bindings,
    identity,
    configBackup,
    logger,
    makeSession,
    makeLock,
    storage,
    folders,
  });

  // 注册 HTTP 路由（webServer 可能还没就绪，重试）
  let webHandle = null;
  let webTimer = null;
  let webAttempt = 0;
  let disposed = false;

  function tryRegister() {
    if (disposed) return;
    const webServer = webServerOf(ctx);
    if (!webServer || typeof webServer.register !== 'function') {
      webAttempt += 1;
      if (webAttempt <= WEB_RETRY_MAX) {
        webTimer = setTimeout(tryRegister, WEB_RETRY_MS);
        if (typeof webTimer.unref === 'function') webTimer.unref();
      } else {
        logger.error('webServer 不可用，RPC 路由未注册', { attempts: webAttempt });
      }
      return;
    }
    try {
      webHandle = webServer.register({
        kind: 'prefix',
        path: SYNC_SHUTTLE_RPC_CHANNEL,
        handler: (req, res, url) =>
          Promise.resolve(dispatcher(req, res, url)).catch((err) => {
            logger.error('RPC 处理未捕获异常', { message: err.message });
            try {
              res.statusCode = 500;
              res.end(
                JSON.stringify({ type: 'server-response', result: { ok: false, error: { code: 'INTERNAL', message: err.message } } }),
              );
            } catch {
              /* ignore */
            }
          }),
      });
      logger.info('RPC 路由已注册', { path: SYNC_SHUTTLE_RPC_CHANNEL });
    } catch (err) {
      logger.error('注册 RPC 路由失败', { message: err.message });
    }
  }
  tryRegister();

  // 启动 3 秒后清理过期下载缓存 + 过期日志（不阻塞启动）
  const pruneTimer = setTimeout(() => {
    // 日志 14 天清理（§8）：之前从没被调用过，日志会无限增长
    try {
      const removedLogs = logger.prune?.() || [];
      if (removedLogs.length) logger.info('已清理过期日志', { count: removedLogs.length });
    } catch (err) {
      logger.warn('清理过期日志失败', { message: err.message });
    }
    import('./download.js')
      .then((m) => {
        const removed = m.pruneFetchCache(paths.fetchDir);
        if (removed.length) logger.info('已清理过期下载缓存', { count: removed.length });
      })
      .catch(() => {});
  }, 3000);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

  // 之后每 6 小时再清一次日志，防止长驻进程跨天不落新文件也不清旧文件
  const logPruneTimer = setInterval(() => {
    try {
      logger.prune?.();
    } catch {
      /* ignore */
    }
  }, 6 * 60 * 60 * 1000);
  if (typeof logPruneTimer.unref === 'function') logPruneTimer.unref();

  const instance = {
    dispose() {
      disposed = true;
      if (webTimer) clearTimeout(webTimer);
      if (pruneTimer) clearTimeout(pruneTimer);
      if (logPruneTimer) clearInterval(logPruneTimer);
      webTimer = null;
      try {
        if (typeof webHandle === 'function') webHandle();
        else webHandle?.dispose?.();
      } catch {
        /* ignore */
      }
      webHandle = null;
    },
    settings,
    bindings,
    identity,
    logger,
    applyAt: new Date().toISOString(),
  };
  globalThis[INSTANCE_KEY] = instance;

  return () => {
    try {
      instance.dispose();
    } finally {
      if (globalThis[INSTANCE_KEY] === instance) globalThis[INSTANCE_KEY] = null;
    }
  };
}
