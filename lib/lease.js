// 通用租约层（lease guard）。
//
// 这一层只依赖 storage adapter 暴露的 4 个锁原语，不含任何后端细节：
//   lockTryCreate / lockInspect / lockRenew / lockRelease
//
// 从原 lib/lock.js 抽出来的原因：排队重试、心跳续期、陈锁判定、nonce 校验
// 这些逻辑与「锁存在哪个后端」无关，换 adapter 时不应该重写一遍。
// 而它们每一条都有实测血泪：
//   · 抢锁成功与否的唯一判据是「回读到的 nonce」，不是 API 返回值
//   · 释放前必须确认 nonce 还是自己的，否则会删掉别人正在生效的锁
//   · 陈锁判定必须用**服务器时间**，不能用本地时钟（两台机器可能差几分钟）
//   · 空锁文件夹要等满一个心跳周期才清，否则会误抢「刚创建还没写锁信」的活锁
//
// 与 adapter 的分工：
//   adapter —— 原子性与时间戳（它才知道服务器怎么记时间）
//   lease   —— 重试节奏、租期语义、状态机

import { DEFAULTS } from './paths.js';
import { randomNonce } from './util.js';

/** 构造带 code 的错误，便于上层按机器码分支。 */
function leaseError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail || null;
  return err;
}

export class LeaseGuard {
  /**
   * @param adapter storage adapter（见 lib/storage/adapter.js）
   * @param options { logger, machineId, hostname, ttlMs, heartbeatMs, graceMs,
   *                  retryIntervalMs, retryMax, onLost }
   */
  constructor(adapter, options = {}) {
    if (!adapter) throw new Error('LeaseGuard 需要一个 storage adapter');
    this.adapter = adapter;
    this.logger = options.logger;

    this.ttlMs = options.ttlMs || DEFAULTS.lockTtlMs;
    this.heartbeatMs = options.heartbeatMs || DEFAULTS.lockHeartbeatMs;
    this.graceMs = options.graceMs ?? DEFAULTS.lockGraceMs;
    this.retryIntervalMs = options.retryIntervalMs || DEFAULTS.lockRetryIntervalMs;
    this.retryMax = options.retryMax || DEFAULTS.lockRetryMax;

    this.machineId = options.machineId || 'MC-UNKNOWN';
    this.hostname = options.hostname || '';

    this.lease = null;
    this.heartbeatTimer = null;
    this.onLost = options.onLost || null;
    // 空锁的首次发现时刻（跨多次重试记忆，用来等满一个心跳周期）
    this.emptySeenAt = null;
  }

  /**
   * 判定陈锁。
   *
   * ⚠️ 时间基准必须来自服务器（lockInspect 返回的 serverTimeMs）。
   * 拿不到服务器时间时**不敢判陈**——宁可当作活跃、让调用方排队，
   * 也不能误抢别人正在生效的锁。
   *
   * @param holder { owner, nonce, op, ttlMs, startedAt }
   * @param serverTimeMs 服务器记录的持锁起始时间；null 表示拿不到
   */
  #isStale(holder, serverTimeMs) {
    if (!holder) return true;
    if (!Number.isFinite(serverTimeMs)) {
      this.logger?.debug('拿不到服务器时间，无法判定陈锁，按活跃处理');
      return false;
    }
    const ttl = holder.ttlMs || this.ttlMs;
    return serverTimeMs + ttl + this.graceMs < Date.now();
  }

  /**
   * 抢一次锁（不重试）。
   * @param op 操作描述（纯 ASCII，写进锁信息，只给人看）
   */
  async acquire(op) {
    const nonce = randomNonce();
    const opText = String(op || '');
    this.lease = { nonce, op: opText, acquiredAt: Date.now(), ttlMs: this.ttlMs };

    // ① 交给 adapter 做原子创建
    const tried = await this.adapter.lockTryCreate({
      owner: this.machineId,
      nonce,
      ttlMs: this.ttlMs,
      op: opText,
    });

    if (tried?.acquired) {
      this.emptySeenAt = null;
      this.#startHeartbeat();
      this.logger?.info('已取得远端锁', { owner: this.machineId, op: opText });
      return this.lease;
    }

    // ② 没拿到：看是陈锁、自己的残留，还是别人真的在干活
    const state = await this.adapter.lockInspect();
    const holder = state?.holder || null;
    const serverTimeMs = Number.isFinite(state?.serverTimeMs) ? state.serverTimeMs : null;

    if (!holder) {
      // 空锁 = 崩溃残留（创建成功、写锁信息前进程死了）
      // §10.8.5.1：必须等满一个心跳周期才清——对方可能正处在
      // 「刚创建成功、还没写进锁信息」这个几秒的窗口里。
      const now = Date.now();
      if (this.emptySeenAt === null) {
        this.emptySeenAt = now;
        this.logger?.warn('发现空锁，疑似崩溃残留，等待一个心跳周期后再清理', {
          waitMs: this.heartbeatMs,
        });
      }
      const waited = now - this.emptySeenAt;
      if (waited < this.heartbeatMs) {
        throw leaseError(
          'LOCK_EMPTY_WAIT',
          `发现上次异常退出留下的空锁，确认中（已等 ${Math.round(waited / 1000)} 秒 / ${Math.round(
            this.heartbeatMs / 1000,
          )} 秒）`,
          { waitedMs: waited, remainingMs: this.heartbeatMs - waited },
        );
      }
      this.logger?.warn('空锁确认超时，判定为崩溃残留并清理', { waitedMs: waited });
      this.emptySeenAt = null;
      await this.adapter.lockRelease({ nonce: null, force: true });
      throw leaseError('LOCK_EMPTY_RESIDUE', '发现上次异常退出留下的空锁，已清理，请重试');
    }
    // 看到真实持有者，就不再有「空锁待确认」状态
    this.emptySeenAt = null;

    if (holder.owner === this.machineId) {
      // 自己的残留锁（上次崩溃）→ 直接清掉
      this.logger?.warn('发现本机残留锁，清理后重试', { nonce: holder.nonce });
      await this.adapter.lockRelease({ nonce: holder.nonce, force: true });
      throw leaseError('LOCK_OWN_RESIDUE', '已清理本机上次遗留的锁，请重试');
    }

    if (this.#isStale(holder, serverTimeMs)) {
      this.logger?.warn('锁已超租期，判定为陈锁并清理', {
        owner: holder.owner,
        serverTimeMs,
      });
      await this.adapter.lockRelease({ nonce: holder.nonce, force: true });
      throw leaseError('LOCK_STALE_CLEARED', `已清理 ${holder.owner} 的超期锁，请重试`);
    }

    const heldMs = serverTimeMs ? Date.now() - serverTimeMs : 0;
    throw leaseError('LOCK_BUSY', `${holder.owner} 正在${holder.op || '操作'}`, {
      owner: holder.owner,
      op: holder.op,
      heldMs,
      remainingMs: Math.max(0, (holder.ttlMs || this.ttlMs) - heldMs),
    });
  }

  /** 排队抢锁：按固定间隔重试，直到拿到或次数耗尽。 */
  async acquireWithRetry(op, { onWait } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retryMax; attempt += 1) {
      try {
        return await this.acquire(attempt ? `${op} (retry ${attempt})` : op);
      } catch (err) {
        lastErr = err;
        // 被别人占着、或空锁还在确认中 → 按正常间隔继续等
        const retriable = err.code === 'LOCK_BUSY' || err.code === 'LOCK_EMPTY_WAIT';
        // 陈锁/残留刚被清理 → 立刻重试，不必等
        const immediate = [
          'LOCK_STALE_CLEARED',
          'LOCK_OWN_RESIDUE',
          'LOCK_EMPTY_RESIDUE',
          'LOCK_WRITE_FAILED',
        ].includes(err.code);
        if (!retriable && !immediate) throw err;
        if (attempt === this.retryMax) break;
        if (retriable) {
          onWait?.({ attempt: attempt + 1, err, remainingMs: this.retryIntervalMs });
          await new Promise((r) => setTimeout(r, this.retryIntervalMs));
        }
      }
    }
    throw lastErr || leaseError('LOCK_FAILED', '无法取得远端锁');
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.renew().catch((err) => {
        this.logger?.warn('锁心跳失败，可能已失去锁', { message: err?.message || String(err) });
        this.#stopHeartbeat();
        try {
          this.onLost?.(err);
        } catch {
          /* ignore */
        }
      });
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 续期：交给 adapter 刷新锁的时间戳，并确认 nonce 仍是我的。 */
  async renew() {
    if (!this.lease) throw leaseError('NO_LEASE', '当前没有持锁');
    const result = await this.adapter.lockRenew({ nonce: this.lease.nonce });
    if (!result?.ok) {
      throw leaseError('LOCK_LOST', result?.reason || '续期失败，锁可能已被抢走');
    }
    return true;
  }

  /**
   * 释放锁。
   * ⚠️ 由 adapter 保证「nonce 不是自己的绝不删」——这是整套锁协议的安全根基。
   */
  async release() {
    this.#stopHeartbeat();
    const lease = this.lease;
    this.lease = null;
    this.emptySeenAt = null;
    if (!lease) return { released: false, reason: 'NO_LEASE' };

    try {
      const res = await this.adapter.lockRelease({ nonce: lease.nonce });
      if (res?.released) {
        this.logger?.info('已释放远端锁', { owner: this.machineId });
      } else if (res?.reason === 'LOCK_TAKEN_OVER') {
        // 关键安全路径：锁已易主，我们什么都没删
        this.logger?.warn('释放锁时发现锁已易主，不做任何删除', { owner: res.owner });
      }
      return res || { released: false, reason: 'UNKNOWN' };
    } catch (err) {
      this.logger?.warn('释放锁失败（租期到期会自动失效）', { message: err?.message || String(err) });
      return { released: false, reason: 'ERROR', message: err?.message };
    }
  }

  /** 只读查询锁状态（界面顶部状态条用，不持锁、不影响别人）。 */
  async status() {
    const state = await this.adapter.lockInspect();
    const holder = state?.holder || null;
    const serverTimeMs = Number.isFinite(state?.serverTimeMs) ? state.serverTimeMs : null;

    if (!holder) return { free: true, holder: null };

    const isMine = holder.owner === this.machineId;
    const heldMs = serverTimeMs ? Date.now() - serverTimeMs : 0;
    const ttl = holder.ttlMs || this.ttlMs;
    const stale = this.#isStale(holder, serverTimeMs);
    return {
      free: stale,
      holder,
      isMine,
      heldMs,
      remainingMs: Math.max(0, ttl - heldMs),
      stale,
    };
  }
}

/** 便捷工厂。 */
export function createLease(adapter, options) {
  return new LeaseGuard(adapter, options);
}
