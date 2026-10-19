/**
 * 子进程的通用拉起方式：**输出走文件，不走管道**。
 *
 * 这是本项目最重要的环境适配，实测得来：
 *   当前沙箱禁止子进程使用管道 stdio（连 spawn node 自身都 EPERM），
 *   但允许文件描述符重定向。因此所有后端统一采用
 *   「子进程把 stdout/stderr 写进日志文件，父进程增量读该文件」。
 *
 * 成员的输出都是"只追加"的事件流（NDJSON / JSONL），天然适合这种读法。
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config } from "./config.mjs";

/** 为一次派活准备日志文件；返回的 fd 交给子进程，路径留给父进程轮询。 */
export function openLogFiles(tag) {
  const dir = resolve(config.dataDir, "runs");
  mkdirSync(dir, { recursive: true });
  const token = randomUUID().slice(0, 8);
  const safeTag = String(tag).replace(/[^\w.-]/g, "_");
  const outPath = resolve(dir, `${safeTag}-${token}.out.log`);
  const errPath = resolve(dir, `${safeTag}-${token}.err.log`);
  const outFd = openSync(outPath, "a");
  const errFd = openSync(errPath, "a");

  return {
    outPath,
    errPath,
    outFd,
    errFd,
    close() {
      for (const fd of [outFd, errFd]) {
        try {
          closeSync(fd);
        } catch {
          /* 已关闭 */
        }
      }
    },
    cleanup() {
      for (const path of [outPath, errPath]) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* 删不掉不影响主流程 */
        }
      }
    },
  };
}

/**
 * 拉起一个子进程，把它的输出按行流式交给 onLine，直到结束。
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {Record<string,string>} [options.env]
 * @param {string} options.tag           日志文件名标签
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {(line: string) => void} options.onLine  每读到一整行调用一次
 * @param {(text: string) => void} [options.onStderr]
 * @param {RegExp[]} [options.abortOnStderr]  命中即立刻终止（用于"未登录"这类无需重试的失败）
 * @returns {Promise<{exitCode: number|null, aborted: boolean, timedOut: boolean, stderr: string, spawnError: string|null, earlyAbort: string|null}>}
 */
export function streamProcess({
  command,
  args,
  cwd = config.workspace,
  env = {},
  tag,
  timeoutMs = config.turnTimeoutMs,
  signal,
  onLine,
  onStderr,
  abortOnStderr = [],
}) {
  return new Promise((resolvePromise) => {
    const logs = openLogFiles(tag);
    let child;

    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", logs.outFd, logs.errFd],
        env: { ...process.env, ...env },
      });
    } catch (error) {
      logs.close();
      logs.cleanup();
      resolvePromise({
        exitCode: null,
        aborted: false,
        timedOut: false,
        stderr: "",
        spawnError: `spawn ${error.code ?? ""} ${error.message}`.trim(),
      });
      return;
    }
    // fd 已交给子进程，父进程这侧的副本可以立刻关掉。
    logs.close();

    let cursor = 0;
    let pending = "";
    let stderrTail = "";
    let exitCode = null;
    let aborted = false;
    let timedOut = false;
    let earlyAbort = null;
    let settled = false;

    const drain = () => {
      let text;
      try {
        text = readFileSync(logs.outPath, "utf8");
      } catch {
        return;
      }
      if (text.length <= cursor) {
        // 输出没有新增，但 stderr 可能出现了致命信息，仍要检查。
      } else {
        pending += text.slice(cursor);
        cursor = text.length;

        let index;
        while ((index = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (line.trim()) {
            try {
              onLine(line);
            } catch {
              /* 单个事件解析失败不应中断整轮 */
            }
          }
        }
      }

      let err = "";
      try {
        err = readFileSync(logs.errPath, "utf8");
        if (err.trim()) stderrTail = err.slice(-8000);
      } catch {
        /* 还没写 stderr */
      }

      // 快速失败：像"未登录"这种重试也没用的错误，立刻终止，
      // 不让子进程把时间耗在无意义的重连上（实测 codex 未登录会空转 120 秒）。
      if (!settled && err && abortOnStderr.length > 0) {
        for (const pattern of abortOnStderr) {
          if (pattern.test(err)) {
            earlyAbort = pattern.source;
            try {
              child.kill();
            } catch {
              /* 已退出 */
            }
            finish({ keepLogs: true });
            return;
          }
        }
      }
    };

    // 轮询而非监听：文件重定向没有事件通知，200ms 对"实时感"足够。
    const poller = setInterval(drain, 200);

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      drain();
      if (pending.trim()) {
        try {
          onLine(pending);
        } catch {
          /* 尾部噪声 */
        }
        pending = "";
      }
      onStderr?.(stderrTail);
      resolvePromise({
        exitCode,
        aborted,
        timedOut,
        stderr: stderrTail,
        spawnError: extra.spawnError ?? null,
        earlyAbort,
      });
      if (!extra.keepLogs) {
        setTimeout(() => logs.cleanup(), 1000).unref?.();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ keepLogs: true });
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish();
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      finish({ spawnError: `${error.code ?? ""} ${error.message}`.trim(), keepLogs: true });
    });
    child.on("close", (code) => {
      exitCode = code;
      finish();
    });
  });
}

/** 子进程是否还在写这个日志文件（备用诊断）。 */
export function logExists(path) {
  return existsSync(path);
}
