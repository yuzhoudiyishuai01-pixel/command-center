/**
 * 成员作业队列。
 *
 * 早期版本是"来一条指令就同时 spawn N 个进程"：全员开工时 CPU、内存、磁盘
 * 一起抢，机器直接卡住；某个成员卡死也没有超时回收。开源版本对外发布，
 * 必须有一个可控的排队层：
 *
 *   - 同一个成员默认串行（它自己也不希望两轮上下文互相踩）
 *   - 全局并发上限（默认 4，可配置）
 *   - 单轮硬超时（默认 30 分钟）
 *   - 排队期间可被中止（房间中止 → 排队中的任务直接出队）
 *
 * 队列只在进程内有效：指挥室是单用户单进程，没有跨进程协调的需求。
 */
import { config } from "./config.mjs";

/** 一个可被中止的排队错误，调用方据此区分"被取消"和"真的失败"。 */
export class AbortedError extends Error {
  constructor(message = "任务已中止") {
    super(message);
    this.name = "AbortedError";
    this.aborted = true;
  }
}

export class TimeoutError extends Error {
  constructor(message = "任务超时") {
    super(message);
    this.name = "TimeoutError";
    this.timeout = true;
  }
}

/** 把 signal 的 reason 归一成 TimeoutError / AbortedError。 */
function toAbortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof TimeoutError) return reason;
  if (reason instanceof AbortedError) return reason;
  return new AbortedError();
}
export class TurnQueue {
  /**
   * @param {{maxConcurrent?: number, perMemberSerial?: boolean, onEvent?: (event: object) => void}} [options]
   */
  constructor({ maxConcurrent = 4, perMemberSerial = true, onEvent = () => {} } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.perMemberSerial = perMemberSerial !== false;
    this.onEvent = onEvent;

    /** 正在运行的任务数（全局）。 */
    this.active = 0;
    /** 每个 key 上挂着的串行链尾（Promise）。 */
    this.chains = new Map();
    /** 等待空位的任务，FIFO。 */
    this.waiters = [];
    /** 简单统计，供 /api/stats 使用。 */
    this.stats = { queuedTotal: 0, startedTotal: 0, rejectedTotal: 0, maxWaitMs: 0 };
  }

  get pending() {
    return this.waiters.length;
  }

  /**
   * 排队执行一个任务。
   *
   * @template T
   * @param {{
   *   key: string,
   *   timeoutMs?: number,
   *   signal?: AbortSignal,
   *   meta?: object,
   *   task: (signal: AbortSignal) => Promise<T>
   * }} options
   * @returns {Promise<T>}
   */
  async schedule({ key, timeoutMs, signal, meta = {}, task }) {
    if (signal?.aborted) throw new AbortedError();

    this.stats.queuedTotal += 1;
    const queuedAt = Date.now();

    if (!this.perMemberSerial) {
      return this.#runNow({ key, timeoutMs, signal, meta, task, queuedAt });
    }

    // 同一个成员串行：先等上一轮结束（上一轮失败也不阻塞下一轮）。
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.#runNow({ key, timeoutMs, signal, meta, task, queuedAt }));
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      // 只有当自己仍是链尾时才清理，避免误删后来者的链。
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  async #runNow({ key, timeoutMs, signal, meta, task, queuedAt }) {
    await this.#acquire(signal);
    const waitMs = Date.now() - queuedAt;
    this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, waitMs);
    this.stats.startedTotal += 1;

    const controller = new AbortController();
    const onAbort = () => controller.abort(new AbortedError());
    signal?.addEventListener("abort", onAbort, { once: true });

    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs);
      timer.unref?.();
    }

    this.onEvent({ type: "queue_start", ...meta, key, waitMs });

    try {
      const value = await task(controller.signal);
      // 任务自己吞掉了 abort（例如把中止当成正常返回）时，队列仍要如实
      // 报超时/取消——否则调用方会把一次被强杀的作业当成成功。
      if (controller.signal.aborted) throw toAbortReason(controller.signal);
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw toAbortReason(controller.signal);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#release();
    }
  }

  #acquire(signal) {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { resolve: resolvePromise, reject: rejectPromise, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          this.stats.rejectedTotal += 1;
          rejectPromise(new AbortedError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.onEvent({ type: "queue_wait", pending: this.waiters.length });
    });
  }

  #release() {
    this.active -= 1;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    this.active += 1;
    waiter.resolve();
  }

  snapshot() {
    return {
      maxConcurrent: this.maxConcurrent,
      perMemberSerial: this.perMemberSerial,
      active: this.active,
      pending: this.waiters.length,
      ...this.stats,
    };
  }
}

/* 全局单例：并发上限与串行策略来自配置。 */
let singleton = null;
export function turnQueue() {
  if (!singleton) {
    singleton = new TurnQueue({
      maxConcurrent: config.maxConcurrentTurns,
      perMemberSerial: config.perMemberQueue,
    });
  }
  return singleton;
}
