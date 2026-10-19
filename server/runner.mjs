/**
 * 成员执行器：把一位成员的一次工作真实派发出去。
 *
 * 做法是拉起一个 `dsh <profile> --json -- <任务>` 子进程。该子进程是完整的
 * DeepSeek Harness 智能体：能读写文件、执行命令、联网检索，并把它每一步的真实
 * 动作以 newline-delimited JSON 输出到 stdout。这里把那些事件翻译成指挥室前端
 * 能渲染的归一化事件。
 *
 * 实测的原始事件类型：session / status / thinking / text / tool_call /
 * tool_result / final（另有 error）。
 *
 * 会话续接：每位成员在每个房间里保存自己的 sessionId，第二轮起用
 * `--session-id` 恢复历史，从而"记住"之前的对话。
 */
import { spawn } from "node:child_process";
import { readFileSync, openSync, closeSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config } from "./config.mjs";
import { profileNameFor } from "./agents.mjs";
import { resolveLauncher } from "./launcher.mjs";
import { proxyEnv } from "./backends.mjs";

/** 工具的展示名与关键参数提取，让前端一眼看出成员在动什么。 */
const TOOL_PRESENTATION = {
  read: { label: "读取文件", detail: (input) => input?.file_path ?? input?.path },
  write: { label: "写入文件", detail: (input) => input?.file_path ?? input?.path },
  edit: { label: "修改文件", detail: (input) => input?.file_path ?? input?.path },
  str_replace: { label: "修改文件", detail: (input) => input?.file_path ?? input?.path },
  glob: { label: "查找文件", detail: (input) => input?.pattern },
  grep: { label: "搜索内容", detail: (input) => input?.pattern },
  pwsh: { label: "执行命令", detail: (input) => input?.command },
  bash: { label: "执行命令", detail: (input) => input?.command },
  web_search: { label: "联网检索", detail: (input) => input?.query ?? input?.queries?.join(" / ") },
  web_fetch: { label: "抓取网页", detail: (input) => input?.url },
  todo_write: { label: "更新任务清单", detail: () => null },
  present: { label: "交付文件", detail: (input) => input?.files?.map?.((f) => f.path ?? f)?.join(", ") },
};

function describeTool(name, input) {
  const spec = TOOL_PRESENTATION[name];
  let detail = null;
  try {
    detail = spec?.detail?.(input) ?? null;
  } catch {
    detail = null;
  }
  if (typeof detail === "string" && detail.length > 220) detail = `…${detail.slice(-220)}`;
  return {
    tool: name,
    label: spec?.label ?? name,
    detail: typeof detail === "string" ? detail : null,
  };
}

function truncate(text, limit = 6000) {
  if (typeof text !== "string") return "";
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text;
}

/**
 * 为一次派活准备日志文件。
 *
 * 之所以用文件而不是管道，见 launcher.mjs 的说明：当前沙箱禁止管道 stdio。
 * 返回的文件描述符交给子进程，父进程通过 outPath/errPath 增量读取。
 */
function openLogFiles(agentId) {
  const dir = resolve(config.dataDir, "runs");
  mkdirSync(dir, { recursive: true });
  const token = randomUUID().slice(0, 8);
  const outPath = resolve(dir, `${agentId}-${token}.out.log`);
  const errPath = resolve(dir, `${agentId}-${token}.err.log`);
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
          /* 删除失败不影响主流程 */
        }
      }
    },
  };
}

/**
 * 派发一次任务。
 *
 * @param {object} options
 * @param {string} options.agentId   成员 id
 * @param {string} options.prompt    指挥官下达的任务
 * @param {string|null} options.sessionId 续接的历史会话 id
 * @param {AbortSignal} [options.signal] 中止信号
 * @param {(event: object) => void} options.onEvent 归一化事件回调
 * @returns {Promise<{sessionId: string|null, finalText: string, exitCode: number|null, aborted: boolean, error: string|null}>}
 */
export function runAgentTurn({ agentId, prompt, sessionId = null, signal, onEvent }) {
  return new Promise((resolve) => {
    const profile = profileNameFor(agentId);
    const args = [profile, "--json"];
    if (sessionId) args.push("--session-id", sessionId);
    // `--` 终结选项解析：即使任务文本以 - 或 -- 开头也当作纯文本。
    args.push("--", prompt);

    const launcher = resolveLauncher();

    // 关键：输出走文件而不是管道。
    // 当前环境的沙箱禁止子进程使用管道（连 spawn node 自身都 EPERM），但允许
    // 文件描述符重定向。于是我们让子进程把 stdout/stderr 写进日志文件，父进程
    // 增量读取该文件——成员的 JSON 事件流本来就是"只追加"的，非常适合这种读法。
    const logs = openLogFiles(agentId);
    let child;
    try {
      child = spawn(launcher.command, [...launcher.prefixArgs, ...args], {
        cwd: config.workspace,
        windowsHide: true,
        stdio: ["ignore", logs.outFd, logs.errFd],
        env: {
          ...process.env,
          ...launcher.env,
          // 代理：维基百科等站点国内直连不通（实测 000，经代理 200），
          // 成员的联网工具必须走代理才取得到。实测注入后成员成功抓到维基条目。
          ...proxyEnv(),
          DSH_HOME: config.dshHome,
          DSH_PERMISSION_MODE: config.permissionMode,
          // DSH 会剥掉 DSH_* 前缀的变量再交给成员启动的 shell，所以成员读不到
          // DSH_PERMISSION_MODE。用不带该前缀的副本，让成员能真正自查权限边界。
          CC_PERMISSION_MODE: config.permissionMode,
          CC_WORKSPACE: config.workspace,
          // 指挥室自己的遥测关掉，避免每次派活都产生额外外发请求。
          DSH_TELEMETRY_DISABLED: "1",
        },
      });
    } catch (error) {
      logs.close();
      logs.cleanup();
      onEvent({ type: "error", message: `无法启动成员进程：${error.code ?? ""} ${error.message}` });
      resolve({
        sessionId,
        finalText: "",
        exitCode: null,
        aborted: false,
        error: `spawn ${error.code ?? ""} ${error.message}`.trim(),
        stderr: null,
      });
      return;
    }
    // 文件描述符已交给子进程，父进程这侧可以立刻关掉自己的副本。
    logs.close();

    let resolvedSessionId = sessionId;
    let finalText = "";
    let stderrTail = "";
    let exitCode = null;
    let aborted = false;
    let settled = false;
    let stdoutBuffer = "";

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        sessionId: resolvedSessionId,
        finalText,
        exitCode,
        aborted,
        error: extra.error ?? null,
        stderr: stderrTail.trim() || null,
      });
      // 保留失败的日志便于排查，成功的删掉避免堆积。
      if (!extra.error) {
        setTimeout(() => logs.cleanup(), 1000).unref?.();
      }
    };

    const handleEvent = (raw) => {
      switch (raw.type) {
        case "session": {
          if (typeof raw.sessionId === "string") resolvedSessionId = raw.sessionId;
          onEvent({ type: "session", sessionId: resolvedSessionId, cwd: raw.cwd });
          break;
        }
        case "status": {
          if (raw.phase === "step_start") onEvent({ type: "step", turn: raw.turn, step: raw.step });
          else if (raw.phase === "step_end" && raw.usage) {
            onEvent({ type: "usage", turn: raw.turn, step: raw.step, usage: raw.usage });
          } else if (raw.phase === "turn_end") {
            onEvent({ type: "turn_end", reason: raw.reason ?? null });
          }
          break;
        }
        case "thinking":
          if (raw.text) onEvent({ type: "thinking", text: raw.text });
          break;
        case "text":
          if (raw.text) onEvent({ type: "text", text: raw.text });
          break;
        case "tool_call":
          onEvent({
            type: "tool_call",
            callId: raw.callId,
            input: raw.input ?? null,
            ...describeTool(raw.tool, raw.input),
          });
          break;
        case "tool_result":
          onEvent({
            type: "tool_result",
            callId: raw.callId,
            status: raw.status ?? "unknown",
            result: truncate(typeof raw.result === "string" ? raw.result : JSON.stringify(raw.result ?? "")),
          });
          break;
        case "final":
          finalText = raw.text ?? "";
          onEvent({ type: "final", text: finalText });
          break;
        case "error":
          onEvent({ type: "error", message: raw.message ?? "未知错误" });
          break;
        default:
          break;
      }
    };

    const consumeStdout = (chunk) => {
      stdoutBuffer += chunk;
      // NDJSON：按行切分，最后一段不完整的行留在缓冲里等下一次读取。
      let index;
      while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // 不是 JSON 就当作诊断信息，不中断整个回合。
          onEvent({ type: "notice", text: truncate(line, 2000) });
        }
      }
    };

    /** 从头到尾读一次日志文件，把新增的完整行交给事件处理器。 */
    let readCursor = 0;
    const drainLog = () => {
      let text;
      try {
        text = readFileSync(logs.outPath, "utf8");
      } catch {
        return;
      }
      if (text.length <= readCursor) return;
      const fresh = text.slice(readCursor);
      readCursor = text.length;
      consumeStdout(fresh);

      try {
        const err = readFileSync(logs.errPath, "utf8");
        if (err.trim()) stderrTail = err.slice(-8000);
      } catch {
        /* 还没写 stderr */
      }
    };

    // 轮询而不是监听：文件重定向没有事件通知，200ms 粒度对"实时感"足够，
    // 且实现简单、不会因平台差异失效。
    const poller = setInterval(drainLog, 200);

    const timer = setTimeout(() => {
      onEvent({ type: "error", message: `超过 ${Math.round(config.turnTimeoutMs / 60000)} 分钟未完成，已强制终止。` });
      aborted = true;
      child.kill();
      finish({ error: "timeout" });
    }, config.turnTimeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      child.kill();
      finish({ error: "aborted" });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      onEvent({ type: "error", message: `无法启动成员进程：${error.message}` });
      finish({ error: error.message });
    });

    child.on("close", (code) => {
      exitCode = code;
      drainLog(); // 收尾：把最后一次写入的内容读干净
      // 补齐最后一行没有换行符的 JSON。
      if (stdoutBuffer.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuffer.trim()));
        } catch {
          /* 忽略尾部噪声 */
        }
        stdoutBuffer = "";
      }
      if (!settled) {
        if (code !== 0 && !finalText) {
          const hint = stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" ");
          onEvent({ type: "error", message: hint || `成员进程以退出码 ${code} 结束。` });
          finish({ error: `exit ${code}` });
        } else {
          finish();
        }
      }
    });
  });
}
