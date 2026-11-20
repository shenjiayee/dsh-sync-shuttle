// 本机绑定表：唯一读写口（§3.6）。
//
// 铁律：
//   1. 所有目录读取都走 ensureBindings()，业务代码禁止直接 readFile('projects.json')
//   2. 本机合法就在本机解决，远端备份永不覆盖已存在的合法配置
//   3. 绝不跨机器自动套用

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './util.js';

const EMPTY = Object.freeze({ version: 1, projects: [] });

function isValidShape(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value.projects)) return false;
  return value.projects.every(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof p.name === 'string' &&
      p.name.length > 0 &&
      typeof p.localDir === 'string' &&
      p.localDir.length > 0,
  );
}

/** 项目名唯一性判定：解码后的原文严格相等，不做任何归一化（§2.1 铁律 1）。 */
function findByName(projects, name) {
  return projects.find((p) => p.name === name) || null;
}

export function createBindingsStore({ paths, logger, configBackup }) {
  let cache = null; // { bindings, mtimeMs, recovered }
  let queue = Promise.resolve();

  function readLocal() {
    let text;
    try {
      text = fs.readFileSync(paths.projects, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { state: 'missing', bindings: null };
      return { state: 'unreadable', bindings: null, message: err.message };
    }
    try {
      const parsed = JSON.parse(text);
      if (!isValidShape(parsed)) return { state: 'invalid', bindings: null };
      return { state: 'ok', bindings: { version: parsed.version || 1, projects: parsed.projects } };
    } catch {
      return { state: 'invalid', bindings: null };
    }
  }

  function localMtime() {
    try {
      return fs.statSync(paths.projects).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** 把损坏文件改名保留，绝不直接删（万一是我解析 bug）。 */
  function quarantine() {
    try {
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
      const dest = path.join(path.dirname(paths.projects), `projects.json.bak-${stamp}`);
      fs.renameSync(paths.projects, dest);
      logger?.warn('本机配置损坏，已改名保留', { file: dest });
      return dest;
    } catch {
      return null;
    }
  }

  function persist(bindings) {
    writeFileAtomic(paths.projects, JSON.stringify(bindings, null, 2));
    cache = { bindings, mtimeMs: localMtime(), recovered: null };
    return bindings;
  }

  /**
   * 统一入口。命中本地快路径时绝不联网。
   * @returns { bindings, source: 'local'|'restored'|'empty', recovered }
   */
  async function ensureBindings() {
    const mtime = localMtime();
    if (cache && cache.mtimeMs === mtime) {
      return { bindings: cache.bindings, source: 'local', recovered: cache.recovered };
    }

    const local = readLocal();
    if (local.state === 'ok') {
      cache = { bindings: local.bindings, mtimeMs: mtime, recovered: null };
      return { bindings: local.bindings, source: 'local', recovered: null };
    }

    // 本机缺失/损坏 → 尝试从远端备份恢复
    logger?.warn('本机配置不可用，尝试从远端备份恢复', { state: local.state });

    // 损坏（不是"不存在"）的文件必须先改名留档：
    // 否则后面任何一次 mutateBindings 的原子写都会把它直接覆盖掉，
    // 万一是我方解析 bug 就永久丢失用户的绑定表（§10.6）。
    const corruptBackup = local.state === 'missing' ? null : quarantine();

    if (!configBackup) {
      cache = { bindings: { ...EMPTY, projects: [] }, mtimeMs: 0, recovered: null };
      return { bindings: { ...EMPTY, projects: [] }, source: 'empty', recovered: null, corruptBackup };
    }

    let restored = null;
    try {
      restored = await configBackup.restoreMine();
    } catch (err) {
      logger?.warn('从远端恢复配置失败', { message: err.message });
    }

    if (restored && isValidShape(restored.bindings)) {
      const bindings = { version: 1, projects: restored.bindings.projects };
      persist(bindings);
      cache.recovered = { at: restored.at, count: bindings.projects.length };
      logger?.info('已从远端备份恢复本机配置', { count: bindings.projects.length, at: restored.at });
      return { bindings, source: 'restored', recovered: cache.recovered, corruptBackup };
    }

    const empty = { version: 1, projects: [] };
    cache = { bindings: empty, mtimeMs: localMtime(), recovered: null };
    return { bindings: empty, source: 'empty', recovered: null, corruptBackup };
  }

  /**
   * 所有变更都走这里：加锁 → 读基线 → 变更 → 原子写 → 失效缓存 → 异步备份。
   * 备份失败不回滚本地变更（§3.6）。
   */
  function mutateBindings(fn) {
    const task = queue.then(async () => {
      const { bindings } = await ensureBindings();
      const draft = { version: 1, projects: bindings.projects.map((p) => ({ ...p })) };
      const result = await fn(draft);
      const next = result && result.projects ? result : draft;
      const saved = persist({ version: 1, projects: next.projects });

      let backup = { ok: false, skipped: true };
      if (configBackup) {
        try {
          backup = await configBackup.backup(saved);
        } catch (err) {
          logger?.warn('配置远端备份失败（本地已生效）', { message: err.message });
          backup = { ok: false, message: err.message };
        }
      }
      return { bindings: saved, backup };
    });
    // 队列不能因一次失败卡死
    queue = task.catch(() => {});
    return task;
  }

  /**
   * 手动「立即备份」：只把当前绑定表推到远端，不改本机内容。
   * 走 queue 串行，避免和 mutateBindings 同时在写同一个文件。
   */
  function backupNow() {
    const task = queue.then(async () => {
      const { bindings } = await ensureBindings();
      if (!configBackup) return { bindings, backup: { ok: false, skipped: true } };
      try {
        const backup = await configBackup.backup({ version: 1, projects: bindings.projects });
        return { bindings, backup };
      } catch (err) {
        logger?.warn('手动配置备份失败', { message: err.message });
        return { bindings, backup: { ok: false, message: err.message } };
      }
    });
    queue = task.catch(() => {});
    return task;
  }

  return {
    ensureBindings,
    mutateBindings,
    backupNow,
    findByName,
    isValidShape,
    /** 仅供 RPC 的只读快照，不触发联网。 */
    peek() {
      const local = readLocal();
      if (local.state === 'ok') {
        return { bindings: local.bindings, source: 'local' };
      }
      return { bindings: null, source: local.state };
    },
    invalidate() {
      cache = null;
    },
    get recovered() {
      return cache?.recovered || null;
    },
  };
}
