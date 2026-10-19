/**
 * Claude Code CLI 后端。
 *
 * 把真实的 `claude` 命令当作一位成员来用——它自带读写文件、执行命令、联网检索，
 * 所以我们不需要自己实现工具循环，只需要把它的输出流翻译成指挥室的事件契约。
 *
 * 关键参数（均为实测确认存在的）：
 *   --print -p                 一次性执行，回答完就退出
 *   --output-format stream-json 实时 JSONL 事件流（我们读的就是它）
 *   --verbose                   配合 stream-json 输出完整过程
 *   --session-id <uuid>        指定会话 id，从而支持多轮续接
 *   --resume <id>              续接一个已存在的会话
 *   --append-system-prompt      注入该成员的人格
 *   --permission-mode           工具权限模式；bypassPermissions 让它无需逐次确认
 *   --model                     指定模型
 *
 * 输出事件形态（按类型分流，不假设固定顺序）：
 *   {"type":"system","subtype":"init","session_id":...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":...},
 *                                             {"type":"tool_use","id":...,"name":...,"input":{}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...,"content":...}]}}
 *   {"type":"result","subtype":"success","result":"...","is_error":bool,...}
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { config } from "./config.mjs";
import { describeTool, truncate, whichAny, npmGlobalDirs, backendConfig, proxyEnv, backendEnv } from "./backends.mjs";
import { streamProcess } from "./proc.mjs";

export const name = "claude-cli";
export const label = "Claude Code CLI";

/**
 * 定位 claude 可执行文件。
 *
 * 重要：不能直接 spawn `claude.cmd`——Node 从 v20 起拒绝对 .cmd/.bat 做 spawn
 * （报 EINVAL），而 shell:true 会把参数拼成字符串、破坏含空格与换行的提示词。
 * 好在 npm 安装的 claude.cmd 内部指向的是一个**原生二进制**：
 *   %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
 * 直接执行它既避开 .cmd，参数也能原样传递。优先找它。
 */
export function locate() {
  const cfg = backendConfig();
  // 用户配置成 .cmd 时也跳过：Windows 上 spawn .cmd 会 EINVAL，继续找原生 exe。
  if (cfg.claudeCliPath && !/\.(cmd|bat)$/i.test(cfg.claudeCliPath)) return cfg.claudeCliPath;

  // 1) npm 全局安装下的原生二进制（首选）
  const appData = process.env.APPDATA ?? "";
  if (appData) {
    const native = `${appData}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    if (existsSync(native)) return native;
  }

  // 2) PATH 里的原生可执行文件（非 .cmd）
  const fromPath = whichAny(["claude"], npmGlobalDirs());
  if (fromPath && !/\.(cmd|bat)$/i.test(fromPath)) return fromPath;

  // 3) 只能拿到 .cmd 时返回它，但调用方必须知道这行不通——
  //    这里返回 null 更诚实，由 describeAvailability 给出可操作的提示。
  return null;
}

/** 找出 .cmd 外壳（仅用于诊断提示）。 */
function locateShellWrapper() {
  const fromPath = whichAny(["claude"], npmGlobalDirs());
  return fromPath && /\.(cmd|bat)$/i.test(fromPath) ? fromPath : null;
}

/** 后端是否可用（只检查可执行文件存在，不检查登录态）。 */
export function isAvailable() {
  return Boolean(locate());
}

/** 给界面用的状态说明。 */
export function describeAvailability() {
  const path = locate();
  if (path) return { available: true, reason: `将使用 ${path}` };

  const wrapper = locateShellWrapper();
  if (wrapper) {
    return {
      available: false,
      reason: `只找到批处理外壳 ${wrapper}，它无法被直接执行；且未找到原生 claude.exe。请重新安装 Claude Code（npm i -g @anthropic-ai/claude-code）。`,
    };
  }
  return { available: false, reason: "未找到 claude 命令（Claude Code CLI 未安装或不在 PATH）。" };
}

function buildArgs({ agent, prompt, systemPrompt, sessionId }) {
  const cfg = backendConfig();
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  // 人格通过追加系统提示注入，不动 Claude Code 自带的系统提示。
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  // 会话续接：有 id 就续接，没有就新开一个并记住它。
  if (sessionId) args.push("--resume", sessionId);
  else args.push("--session-id", randomUUID());

  // 权限模式：指挥室已在自己的沙箱约束下运行，这里让 Claude 不再逐次询问。
  const mode = cfg.claudePermissionMode ?? "bypassPermissions";
  if (mode) args.push("--permission-mode", mode);

  const model = cfg.claudeModel;
  if (model) args.push("--model", model);

  // 允许它读写工作区之外的路径时，显式把工作区加进去。
  if (config.workspace) args.push("--add-dir", config.workspace);

  // `--` 之后是提示词本体，避免以 - 开头的内容被当成选项。
  args.push("--", prompt);
  return args;
}

/**
 * 跑一轮。
 *
 * @returns {Promise<{sessionId, finalText, exitCode, aborted, error, stderr}>}
 */
export async function runTurn({ agent, prompt, systemPrompt, sessionId, signal, onEvent, runtimeFacts = {} }) {
  const command = locate();
  if (!command) {
    const message = "无法启动 Claude：未找到 claude 命令。请确认 Claude Code CLI 已安装。";
    onEvent({ type: "error", message });
    return { sessionId, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  let resolvedSessionId = sessionId ?? null;
  let finalText = "";
  let resultError = null;
  const toolNames = new Map(); // tool_use id -> 工具名，用于补全缺失的结果归属

  const handle = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      onEvent({ type: "notice", text: truncate(line, 2000) });
      return;
    }

    switch (event.type) {
      case "system": {
        if (event.subtype === "init" && typeof event.session_id === "string") {
          resolvedSessionId = event.session_id;
          onEvent({ type: "session", sessionId: resolvedSessionId, model: event.model, cwd: event.cwd });
        }
        break;
      }

      case "assistant": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        if (event.message?.model) onEvent({ type: "model", model: event.message.model });
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            onEvent({ type: "text", text: block.text });
          } else if (block?.type === "thinking" && block.thinking) {
            onEvent({ type: "thinking", text: block.thinking });
          } else if (block?.type === "tool_use") {
            toolNames.set(block.id, block.name);
            onEvent({
              type: "tool_call",
              callId: block.id,
              input: block.input ?? null,
              ...describeTool(block.name, block.input),
            });
          }
        }
        break;
      }

      case "user": {
        // 工具执行结果由 CLI 以 user 消息回灌，取出来展示。
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          const raw = block.content;
          let text = "";
          if (typeof raw === "string") text = raw;
          else if (Array.isArray(raw)) {
            text = raw
              .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
              .filter(Boolean)
              .join("\n");
          } else if (raw != null) {
            text = JSON.stringify(raw);
          }
          onEvent({
            type: "tool_result",
            callId: block.tool_use_id,
            status: block.is_error ? "error" : "completed",
            result: truncate(text),
          });
        }
        break;
      }

      case "result": {
        if (typeof event.result === "string") finalText = event.result;
        if (event.is_error) {
          resultError = event.result || "Claude 报告本轮执行出错。";
          onEvent({ type: "error", message: truncate(String(resultError), 1000) });
        }
        if (event.usage) {
          onEvent({
            type: "usage",
            usage: {
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
              cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
              totalTokens:
                (event.usage.input_tokens ?? 0) +
                (event.usage.output_tokens ?? 0) +
                (event.usage.cache_read_input_tokens ?? 0),
            },
          });
        }
        if (finalText) onEvent({ type: "final", text: finalText });
        break;
      }

      default:
        // 其它事件（如 stream_event 增量帧）不影响判定，忽略即可。
        break;
    }
  };

  onEvent({ type: "step", turn: 1, step: 1 });

  const outcome = await streamProcess({
    command,
    args: buildArgs({ agent, prompt, systemPrompt, sessionId }),
    cwd: config.workspace,
    // 代理按后端区分：走官方 Anthropic 需要代理（否则 403）；
    // 走国内兼容端点（DeepSeek/GLM/Kimi 的 /anthropic）必须不走，否则绕远。
    // runtimeFacts 让成员能自查权限边界（系统提示里承诺了这一点）。
    env: { ...proxyEnv("claude"), ...backendEnv("claude"), ...runtimeFacts },
    tag: `claude-${agent.id}`,
    timeoutMs: config.turnTimeoutMs,
    signal,
    onLine: handle,
  });

  let error = outcome.spawnError;
  if (!error && outcome.timedOut) error = `超过 ${Math.round(config.turnTimeoutMs / 60000)} 分钟未完成，已强制终止。`;
  if (!error && outcome.aborted) error = "aborted";
  if (!error && outcome.exitCode !== 0 && !finalText) {
    const hint =
      /not logged in|login/i.test(outcome.stderr)
        ? "Claude Code CLI 尚未登录。请在终端运行 `claude`，输入 /login 完成授权后重试。"
        : outcome.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    error = hint || `Claude 进程以退出码 ${outcome.exitCode} 结束。`;
    if (hint) onEvent({ type: "error", message: truncate(hint, 600) });
  }
  if (!error && resultError) error = String(resultError);

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
