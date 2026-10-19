/**
 * 后端调度层：按成员的 backend 字段把一轮任务派给正确的实现。
 *
 * 为什么不把三套实现揉进一个文件：DSH 路径已经过大量实测（文件重定向取流、
 * 会话续接、事件解析都被验证过），不该为了"统一"去重写它。这里只做分发，
 * 三条路各自独立、互不影响——某条坏了不影响另外两条。
 *
 * 事件契约见 backends.mjs 的说明；三种后端都产出同一套归一化事件。
 */
import { runAgentTurn as runDshTurn } from "./runner.mjs";
import * as claudeCli from "./claude-cli.mjs";
import * as codexCli from "./codex-cli.mjs";
import * as apiBackend from "./api-backend.mjs";
import { backendNameFor } from "./backends.mjs";
import { BACKEND_KINDS, memberById } from "./members.mjs";
import { systemPromptFor } from "./agents.mjs";
import { ensureProfileFor } from "./profiles.mjs";
import { config, dshAvailable } from "./config.mjs";

/** 后端 id -> 展示文案。界面上要如实显示"由谁提供智力"。 */
export const BACKEND_LABELS = {
  dsh: { label: "DSH 内置", detail: "DeepSeek 账号路由，零配置" },
  "claude-cli": { label: "Claude Code", detail: "真实 Claude Code CLI" },
  "codex-cli": { label: "Codex", detail: "真实 Codex CLI" },
  "openai-api": { label: "OpenAI 兼容 API", detail: "纯对话，无工具能力" },
  "anthropic-api": { label: "Anthropic API", detail: "纯对话，无工具能力" },
};

const IMPLEMENTATIONS = {
  dsh: {
    label: "DeepSeek Harness",
    // DSH 是可选依赖：没装 dsh CLI 时 DSH 成员不可用，但 API 成员照常工作。
    isAvailable: () => dshAvailable(),
    describeAvailability: () =>
      dshAvailable()
        ? { available: true, reason: "内置路由，零配置。" }
        : {
            available: false,
            reason: "未检测到 dsh CLI。安装 DeepSeek Harness 或在 cc.config.json 里填写 dshCli；也可以改用 API 成员。",
          },
  },
  "claude-cli": claudeCli,
  "codex-cli": codexCli,
  "openai-api": {
    label: "OpenAI 兼容 API",
    // 可用性随成员而异（要看它自己配没配 baseUrl/model），所以这里只报"实现了"。
    describeAvailability: () => ({ available: true, reason: "纯对话后端；连接参数由成员自己声明。" }),
  },
  "anthropic-api": {
    label: "Anthropic API",
    describeAvailability: () => ({ available: true, reason: "纯对话后端；连接参数由成员自己声明。" }),
  },
};

/**
 * 某位成员的后端此刻是否可用。
 *
 * 只判断"可执行文件是否找得到"，**不判断登录态**——登录态只有真跑一次才知道；
 * 把它当不可用会让成员直接显示为离线，反而不如让它去跑、然后如实报错，
 * 这样"未登录"这类问题会以明确信息呈现给指挥官。
 */
export function backendAvailability(agent) {
  const backend = backendNameFor(agent);
  const impl = IMPLEMENTATIONS[backend];
  if (!impl) return { available: false, reason: `未知后端 "${backend}"。` };
  return impl.describeAvailability?.() ?? { available: true, reason: "" };
}

/** 列出所有后端及其可用性，用于启动自检。 */
export function backendInventory() {
  return Object.entries(IMPLEMENTATIONS).map(([id, impl]) => ({
    id,
    label: impl.label ?? id,
    ...(impl.describeAvailability?.() ?? { available: false, reason: "未实现可用性检查。" }),
  }));
}

/**
 * 跑一轮。
 *
 * @param {object} options
 * @param {object} options.agent               成员定义（含 backend）
 * @param {string} options.prompt              指挥官的任务
 * @param {string|null} options.sessionId      该成员在该房间的历史会话 id（仅 CLI 后端用）
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} options.onEvent
 * @param {object[]} [options.messages]        该房间完整消息列表（API 后端靠它重建历史）
 * @param {string|null} [options.turnId]       本轮 turnId
 */
export async function runTurn({ agent, prompt, sessionId = null, signal, onEvent, messages = [], turnId = null }) {
  const backend = backendNameFor(agent);
  const kind = BACKEND_KINDS[backend];

  // 成员可能刚被删除，但房间里还留着它的旧消息——用注册表里的最新定义。
  const live = memberById(agent.id) ?? agent;

  // 所有后端都要能自查权限边界：系统提示里明确写了"读 CC_PERMISSION_MODE 即可
  // 确认"，若后端不注入这两个变量，成员读到空值就会如实上报"与既定事实不符"。
  const runtimeFacts = {
    CC_PERMISSION_MODE: config.permissionMode,
    CC_WORKSPACE: config.workspace,
  };

  if (!kind) {
    const message = `成员 ${live.name} 声明的后端 "${backend}" 不存在。可用：${Object.keys(BACKEND_KINDS).join("、")}。`;
    onEvent({ type: "error", message });
    return { sessionId, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  // DSH 后端的人格是通过 profile 注入的，这里不需要再传系统提示。
  // 注意：新建的成员在启动时没有 profile，必须在这里补生成，否则会 exit 1。
  if (backend === "dsh") {
    if (!dshAvailable()) {
      const message = `${live.name} 的后端不可用：未检测到 dsh CLI。安装 DeepSeek Harness，或在 cc.config.json 里填写 dshCli；也可以给它换成 API 后端。`;
      onEvent({ type: "error", message });
      return { sessionId, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
    }
    ensureProfileFor(live);
    return runDshTurn({ agentId: live.id, prompt, sessionId, signal, onEvent });
  }

  const systemPrompt = systemPromptFor(live, {
    permissionMode: config.permissionMode,
    workspace: config.workspace,
  });

  // 纯对话 API 后端：无工具能力，靠自带的历史重建维持多轮语境。
  if (kind.kind === "api") {
    return apiBackend.runTurn({
      agent: live,
      prompt,
      systemPrompt,
      sessionId,
      signal,
      onEvent,
      messages,
      turnId,
      runtimeFacts,
    });
  }

  const impl = IMPLEMENTATIONS[backend];
  if (!impl) {
    const message = `后端 "${backend}" 没有可用的实现。`;
    onEvent({ type: "error", message });
    return { sessionId, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  const availability = impl.describeAvailability?.();
  if (availability && !availability.available) {
    const message = `${live.name} 的后端不可用：${availability.reason}`;
    onEvent({ type: "error", message });
    return { sessionId, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  return impl.runTurn({ agent: live, prompt, systemPrompt, sessionId, signal, onEvent, runtimeFacts });
}
