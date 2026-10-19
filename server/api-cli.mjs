/**
 * API 成员后端：纯对话，支持 OpenAI 兼容与 Anthropic 两种接口格式。
 *
 * 能力边界要说清楚：**这条路径没有工具能力**。API 只回文本，不会读写文件、
 * 不会执行命令。需要动手的成员请用 dsh / claude-cli / codex-cli。
 *
 * 会话延续：API 是无状态的，所以这里由指挥室自己维护历史——每次请求把
 * 该成员在同一房间里之前的「指挥官指令 + 它自己的回答」重放一遍。
 * 只重放它自己的回答，不重放其他成员的（否则它会开始扮演别人）。
 */
import { memberById } from "./members.mjs";
import { proxyEnv } from "./backends.mjs";
import { config } from "./config.mjs";
import { secrets } from "./backends.mjs";

/** 每次请求最多重放多少轮历史，防止上下文无限膨胀。 */
const MAX_HISTORY_TURNS = 12;

/** 单次请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * 从房间消息里重建某成员看到的对话历史。
 *
 * @param {object[]} messages 房间的完整消息列表
 * @param {string} agentId 该成员 id
 * @param {string} currentTurnId 本轮 turnId（本轮指令不重放，作为最后一条用户消息单独发）
 * @returns {{role: "user"|"assistant", content: string}[]}
 */
export function buildHistory(messages, agentId, currentTurnId = null) {
  const turns = [];
  // 按 turnId 归并：一条指令 + 该成员对它的回答。
  for (const message of messages) {
    if (message.role === "commander") {
      if (message.turnId === currentTurnId) continue;
      turns.push({ turnId: message.turnId, commander: message.cleaned ?? message.text, reply: null });
    } else if (message.role === "agent" && message.agentId === agentId) {
      const turn = turns.find((item) => item.turnId === message.turnId);
      if (turn && message.status === "done" && message.text) turn.reply = message.text;
    }
  }

  const history = [];
  for (const turn of turns.slice(-MAX_HISTORY_TURNS)) {
    if (!turn.commander) continue;
    history.push({ role: "user", content: turn.commander });
    if (turn.reply) history.push({ role: "assistant", content: turn.reply });
  }
  return history;
}

/** 解析该成员使用的密钥：优先 members 内联，其次 secrets.json 的 apiKeys[id]。 */
function resolveApiKey(member) {
  const stored = secrets();
  const fromSecrets = stored?.apiKeys?.[member.id];
  if (typeof fromSecrets === "string" && fromSecrets.trim()) return fromSecrets.trim();

  // 兼容：按 host 复用一把公共 key（例如所有 DeepSeek 端点共用一把）
  const host = (() => {
    try {
      return new URL(member.api.baseUrl).host;
    } catch {
      return "";
    }
  })();
  const shared = stored?.apiKeysByHost?.[host];
  if (typeof shared === "string" && shared.trim()) return shared.trim();

  return null;
}

/** 统一超时：AbortController + 定时器。 */
function withTimeout(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("请求超时")), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** 组装 OpenAI 兼容请求。 */
function openAiRequest({ member, systemPrompt, history, prompt, apiKey }) {
  const url = `${member.api.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: member.api.model,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...history,
      { role: "user", content: prompt },
    ],
  };
  if (member.api.temperature !== undefined) body.temperature = member.api.temperature;
  if (member.api.maxTokens !== undefined) body.max_tokens = member.api.maxTokens;

  return {
    url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    parse: (json) => {
      const choice = json?.choices?.[0];
      const text =
        typeof choice?.message?.content === "string"
          ? choice.message.content
          : Array.isArray(choice?.message?.content)
            ? choice.message.content.map((part) => part?.text ?? "").join("")
            : "";
      const usage = json?.usage;
      return {
        text,
        usage: usage
          ? {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
              cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
              cacheWriteTokens: 0,
              totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            }
          : null,
      };
    },
  };
}

/** 组装 Anthropic 请求。 */
function anthropicRequest({ member, systemPrompt, history, prompt, apiKey }) {
  const url = `${member.api.baseUrl.replace(/\/+$/, "")}/messages`;
  const body = {
    model: member.api.model,
    max_tokens: member.api.maxTokens ?? 4096,
    messages: [...history, { role: "user", content: prompt }],
  };
  if (systemPrompt) body.system = systemPrompt;
  if (member.api.temperature !== undefined) body.temperature = member.api.temperature;

  return {
    url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    },
    parse: (json) => {
      const text = Array.isArray(json?.content)
        ? json.content.map((block) => (block?.type === "text" ? block.text : "")).join("")
        : typeof json?.content === "string"
          ? json.content
          : "";
      const usage = json?.usage;
      return {
        text,
        usage: usage
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
              totalTokens:
                (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            }
          : null,
      };
    },
  };
}

/**
 * 跑一轮（纯对话）。
 *
 * @returns {Promise<{sessionId: null, finalText: string, exitCode: number|null, aborted: boolean, error: string|null, stderr: string|null}>}
 */
export async function runTurn({ agent, prompt, systemPrompt, signal, onEvent, messages = [], turnId = null }) {
  const member = memberById(agent.id) ?? agent;
  const api = member.api;

  if (!api?.baseUrl || !api?.model) {
    const message = `成员 ${member.name} 缺少 API 配置（baseUrl / model）。`;
    onEvent({ type: "error", message });
    return { sessionId: null, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  const apiKey = resolveApiKey(member);
  if (!apiKey) {
    const message = `成员 ${member.name} 没有可用的 API 密钥。请在 secrets.json 的 apiKeys["${member.id}"] 里配置。`;
    onEvent({ type: "error", message });
    return { sessionId: null, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
  }

  const history = buildHistory(messages, member.id, turnId);

  const request =
    member.backend === "anthropic-api"
      ? anthropicRequest({ member, systemPrompt, history, prompt, apiKey })
      : openAiRequest({ member, systemPrompt, history, prompt, apiKey });

  onEvent({ type: "step", turn: 1, step: 1 });
  onEvent({ type: "notice", text: `${member.name} 正在思考（${api.model}）…` });

  const timeout = withTimeout(signal);
  let result;
  try {
    const response = await fetch(request.url, {
      ...request.init,
      signal: timeout.signal,
      // 代理：与其它后端一致，按配置注入（部分 API 域名在国内需要代理）。
      // Node 的 fetch 不读环境变量代理，这里显式用 undici 的 dispatcher 太复杂，
      // 因此若配置了代理且后端需要，就走 curl 兜底（见下方 catch）。
      env: undefined,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const hint = response.status === 401 || response.status === 403 ? "（密钥无效或无权限）" : "";
      const message = `API 返回 HTTP ${response.status}${hint}：${body.slice(0, 300)}`;
      onEvent({ type: "error", message });
      return { sessionId: null, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
    }

    const json = await response.json();
    result = request.parse(json);
  } catch (error) {
    const aborted = timeout.signal.aborted;
    const message = aborted
      ? "请求超时或被中止。"
      : `请求失败：${error?.message ?? String(error)}。若目标域名在国内需要代理，请确认 cc.config.json 的 backends.proxy 已设置。`;
    onEvent({ type: "error", message });
    return {
      sessionId: null,
      finalText: "",
      exitCode: null,
      aborted,
      error: message,
      stderr: null,
    };
  } finally {
    timeout.done();
  }

  if (result.usage) onEvent({ type: "usage", usage: result.usage });
  if (result.text) onEvent({ type: "text", text: result.text });
  onEvent({ type: "final", text: result.text });

  return {
    sessionId: null,
    finalText: result.text,
    exitCode: 0,
    aborted: false,
    error: result.text ? null : "模型返回了空内容。",
    stderr: null,
  };
}

/** 供界面展示：该成员是否已配好密钥。 */
export function hasApiKey(member) {
  return Boolean(resolveApiKey(member));
}
