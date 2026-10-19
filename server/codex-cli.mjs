/**
 * Codex CLI 后端。
 *
 * 用真实的 `codex` 命令作为一位成员。与 Claude 适配器同构：Codex 自带工具循环
 * （读写文件、执行命令），我们只负责把它的 JSONL 事件翻译成指挥室的事件契约。
 *
 * 关键参数（实测确认存在）：
 *   codex exec [PROMPT]          一次性执行
 *   --json                       以 JSONL 打印事件
 *   --cd <DIR>                   工作目录
 *   --skip-git-repo-check        允许在非 git 仓库里运行
 *   --dangerously-bypass-approvals-and-sandbox
 *                                跳过确认与沙箱（指挥室已在自己的沙箱约束下运行）
 *   -s, --sandbox <MODE>         指定沙箱模式（与上面的 bypass 互斥）
 *   codex exec resume <ID>       续接一个已存在的会话
 *
 * 事件形态（JSONL，形如 {"type":..., "message":...}）：
 *   {"type":"thread.started","thread_id":...}    会话 id
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{...}}       回复/工具动作的完成项
 *   {"type":"error","message":"..."}             错误（含重连提示）
 *   {"type":"turn.completed","usage":{...}}      用量
 */
import { readdirSync, statSync, existsSync } from "node:fs";

import { config } from "./config.mjs";
import { describeTool, truncate, whichAny, npmGlobalDirs, backendConfig, proxyEnv, backendEnv } from "./backends.mjs";
import { streamProcess } from "./proc.mjs";

export const name = "codex-cli";
export const label = "Codex CLI";

/** Codex 不在 PATH 里，通常在 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe。 */
export function locate() {
  const cfg = backendConfig();
  if (cfg.codexCliPath) return cfg.codexCliPath;

  const fromPath = whichAny(["codex"], npmGlobalDirs());
  if (fromPath) return fromPath;

  // 兜底：扫描 Codex 自己的安装目录（版本哈希目录名是随机的）。
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const base = localAppData ? `${localAppData}\\OpenAI\\Codex\\bin` : null;
  if (!base) return null;
  try {
    for (const entry of readdirSync(base)) {
      const candidate = `${base}\\${entry}\\codex.exe`;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  } catch {
    /* 目录不存在等情况 */
  }
  return null;
}

export function isAvailable() {
  return Boolean(locate());
}

export function describeAvailability() {
  const path = locate();
  if (!path) return { available: false, reason: "未找到 codex 可执行文件。" };
  return { available: true, reason: `将使用 ${path}` };
}

function buildArgs({ prompt, systemPrompt, sessionId }) {
  const cfg = backendConfig();
  const args = ["exec"];

  // 续接旧会话：codex exec resume <ID> <PROMPT>
  if (sessionId) args.push("resume", sessionId);

  args.push("--json", "--skip-git-repo-check", "--cd", config.workspace);

  // 权限：指挥室已在自己的沙箱内运行，这里让 Codex 不再逐次确认。
  if (cfg.codexBypassSandbox !== false) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (cfg.codexSandbox) {
    args.push("--sandbox", cfg.codexSandbox);
  }

  const model = cfg.codexModel;
  if (model) args.push("--model", model);

  // Codex 没有"追回系统提示"的开关，人格与上文直接拼进提示词。
  const full = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
  args.push("--", full);
  return args;
}

/**
 * 跑一轮。
 *
 * @returns {Promise<{sessionId, finalText, exitCode, aborted, error, stderr}>}
 */
export async function runTurn({ agent, prompt, systemPrompt, sessionId, signal, onEvent }) {
  const command = locate();
  if (!command) {
    const message = "无法启动 Codex：未找到 codex 可执行文件。";
    onEvent({ type: "error", message });
    return { sessionId, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  let resolvedSessionId = sessionId ?? null;
  let finalText = "";
  let lastError = null;

  /** 从 item 里提取文本内容，兼容多种字段名。 */
  const itemText = (item) => {
    if (!item) return "";
    if (typeof item.text === "string") return item.text;
    if (Array.isArray(item.content)) {
      return item.content
        .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
        .filter(Boolean)
        .join("\n");
    }
    if (typeof item.command === "string") return item.command;
    if (typeof item.message === "string") return item.message;
    return "";
  };

  const handle = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      onEvent({ type: "notice", text: truncate(line, 2000) });
      return;
    }

    switch (event.type) {
      case "thread.started": {
        if (typeof event.thread_id === "string") {
          resolvedSessionId = event.thread_id;
          onEvent({ type: "session", sessionId: resolvedSessionId });
        }
        break;
      }

      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item ?? {};
        const kind = item.item_type ?? item.type ?? "";

        // 推理过程
        if (kind === "reasoning" || kind === "thinking") {
          const text = itemText(item);
          if (text) onEvent({ type: "thinking", text });
          break;
        }

        // 命令执行 / 工具调用
        if (kind === "command_execution" || kind === "shell" || kind === "tool_call" || kind === "function_call") {
          const toolName = item.name ?? item.tool_name ?? "shell";
          const input = item.arguments ?? item.args ?? { command: item.command };
          if (event.type === "item.started") {
            onEvent({
              type: "tool_call",
              callId: item.id ?? item.call_id ?? `${toolName}-${Date.now()}`,
              input,
              ...describeTool(toolName, input),
            });
          } else if (event.type === "item.completed") {
            onEvent({
              type: "tool_result",
              callId: item.id ?? item.call_id,
              status: item.exit_code != null && item.exit_code !== 0 ? "error" : "completed",
              result: truncate(item.aggregated_output ?? item.output ?? itemText(item)),
            });
          }
          break;
        }

        // 助手回复
        if (kind === "assistant_message" || kind === "message" || kind === "agent_message" || kind === "text") {
          const text = itemText(item);
          if (text && event.type === "item.completed") {
            finalText = finalText ? `${finalText}\n\n${text}` : text;
            onEvent({ type: "text", text });
          }
          break;
        }
        break;
      }

      case "turn.completed": {
        if (event.usage) {
          onEvent({
            type: "usage",
            usage: {
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
              cacheReadTokens: event.usage.cached_input_tokens ?? 0,
              cacheWriteTokens: 0,
              totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
            },
          });
        }
        break;
      }

      case "error": {
        const message = event.message ?? "Codex 报告错误。";
        // 重连提示是过程性的，不当作致命错误；只在最终仍失败时才升级。
        if (/reconnecting/i.test(message)) {
          onEvent({ type: "notice", text: message });
        } else {
          lastError = message;
          onEvent({ type: "error", message: truncate(message, 1000) });
        }
        break;
      }

      default:
        break;
    }
  };

  onEvent({ type: "step", turn: 1, step: 1 });

  const outcome = await streamProcess({
    command,
    args: buildArgs({ prompt, systemPrompt, sessionId }),
    cwd: config.workspace,
    // 代理按后端区分；额外的供应商环境变量从配置读取。
    env: { ...proxyEnv("codex"), ...backendEnv("codex") },
    tag: `codex-${agent.id}`,
    timeoutMs: config.turnTimeoutMs,
    signal,
    onLine: handle,
    // 未登录时 Codex 会反复 "Reconnecting..." 空转（实测耗了 120 秒）。
    // 命中这些模式就立刻终止，把秒级的明确失败还给指挥官。
    abortOnStderr: [
      /not logged in/i,
      /please run .?codex login/i,
      /unauthorized/i,
      /401 Unauthorized/i,
      /Request not allowed/i,
    ],
  });

  let error = outcome.spawnError;
  if (!error && outcome.earlyAbort) {
    error = /login|unauthorized|401/i.test(outcome.earlyAbort)
      ? "Codex CLI 尚未登录。请在终端先设代理再运行 `codex login` 完成授权。"
      : `Codex 被拒绝：${outcome.earlyAbort}`;
    onEvent({ type: "error", message: error });
  }
  if (!error && outcome.timedOut) error = `超过 ${Math.round(config.turnTimeoutMs / 60000)} 分钟未完成，已强制终止。`;
  if (!error && outcome.aborted) error = "aborted";
  if (!error && outcome.exitCode !== 0 && !finalText) {
    const hint =
      /not logged in|login|unauthorized|401/i.test(outcome.stderr) || /reconnecting/i.test(outcome.stderr)
        ? "Codex CLI 尚未登录，或登录态已失效。请在终端先设代理再运行 `codex login` 完成授权后重试。"
        : outcome.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    error = hint || `Codex 进程以退出码 ${outcome.exitCode} 结束。`;
    if (hint) onEvent({ type: "error", message: truncate(hint, 600) });
  }
  if (!error && lastError && !finalText) error = String(lastError);

  if (finalText) onEvent({ type: "final", text: finalText });

  return {
    sessionId: resolvedSessionId,
    finalText,
    exitCode: outcome.exitCode,
    aborted: outcome.aborted,
    error: error ?? null,
    stderr: outcome.stderr || null,
  };
}
