/**
 * 指挥室服务自身的日志。
 *
 * 为什么需要它：默认启动路径（`启动指挥室.cmd` → `service.ps1` 的 WScript.Shell 隐藏启动）
 * **会丢弃服务进程的 stdout/stderr**，控制台输出没有人接管。于是 `data/server.log`
 * 只可能在有人手工重定向时才有内容——实测中它是上一次手工启动留下的陈旧文件，
 * 而当前实例的启动横幅、崩溃原因、退出码全都无处可查。
 * 后果是真实的：2026-10-14 20:44:42 服务重启，三位成员的作业被中断，
 * 却因为没有任何服务日志而无法定性原因。
 *
 * 做法：把 `process.stdout.write` / `process.stderr.write` 做成三通（tee）——
 * 一行既写 console（保持 `--console` 排错方式不变），又追加进 `data/server.log`。
 * 用同步追加：崩溃/退出时异步缓冲会丢，而取证恰恰发生在崩溃时。
 *
 * 纪律：**日志装不上绝不能影响服务本身**——全部写入包在 try/catch 里，
 * 失败就静默降级为「没有日志」，绝不抛出。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

let installed = false;

export function installServiceLog(dataDir) {
  if (installed) return { logPath: null, alreadyInstalled: true };
  installed = true;

  let logPath = null;
  try {
    mkdirSync(dataDir, { recursive: true });
    logPath = resolve(dataDir, "server.log");
  } catch {
    logPath = null;
  }

  function append(tag, text) {
    if (!logPath) return;
    try {
      const stamp = new Date().toISOString();
      const body = String(text)
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => `${stamp} [${tag}] ${line}`)
        .join("\n");
      if (body) appendFileSync(logPath, `${body}\n`, "utf8");
    } catch {
      /* 静默：日志失败不得影响服务 */
    }
  }

  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  const tee = (original, tag) =>
    function write(chunk, encoding, callback) {
      append(tag, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return original(chunk, encoding, callback);
    };

  process.stdout.write = tee(originalOut, "out");
  process.stderr.write = tee(originalErr, "err");

  append("boot", `=== 指挥室进程启动 pid=${process.pid} node=${process.version} ===`);
  append("boot", `argv=${process.argv.slice(1).join(" ")}`);
  if (!logPath) append("boot", "（未能确定日志路径）");

  // 记录退出码与崩溃原因。保持 Node 的默认语义：未捕获异常/未处理拒绝仍然终止进程，
  // 只是这次会留下原因，而不是像此前那样无声消失。
  process.on("exit", (code) => append("exit", `=== 指挥室进程退出 code=${code} ===`));
  process.on("uncaughtException", (error) => {
    append("fatal", `未捕获异常：${error?.stack ?? error}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    append("fatal", `未处理的 Promise 拒绝：${reason?.stack ?? reason}`);
    process.exit(1);
  });

  return { logPath, alreadyInstalled: false };
}
