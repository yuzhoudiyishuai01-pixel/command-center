/**
 * API 成员后端：纯对话，支持 OpenAI 兼容与 Anthropic 两种接口格式。
 *
 * 能力边界要说清楚：**这条路径没有工具能力**。API 只回文本，不会读写文件、
 * 不会执行命令。需要动手的成员请用 dsh / claude-cli / codex-cli。
 *
 * 会话延续：API 是无状态的，所以这里由指挥室自己维护历史——每次请求把
 * 该成员在同一房间里之前的「指挥官指令 + 它自己的回答」重放一遍。
 * 只重放它自己的回答，不重放其他成员的（否则它会开始扮演别人）。
 *
 * 代理：Node 内置 fetch **不读** HTTP(S)_PROXY 环境变量，必须显式传入
 * undici 的 ProxyAgent，否则需要代理的 API 域名会直接连不上。
 */
import { memberById } from "./members.mjs";
import { secrets, backendConfig } from "./backends.mjs";

/** 每次请求最多重放多少轮历史，防止上下文无限膨胀。 */
const MAX_HISTORY_TURNS = 12;

/**
 * 历史总字符预算。
 *
 * 光按轮数限不住：一轮指令 + 回复可能是几万字（成员回答很啰嗦），
 * 12 轮就能把上下文顶爆，也会让每次请求都变慢变贵。所以再按字符数
 * 从**最近**往回装，装不下就停。
 */
const HISTORY_CHAR_BUDGET = 24_000;

/** 单次请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 180_000;

let proxyDispatcherCache = null;

/**
 * 按配置创建代理 dispatcher。没有配置代理时返回 undefined。
 * undici 的 ProxyAgent 在 Node 24 里是内置的，不需要额外安装。
 */
async function proxyDispatcher() {
  const proxy = backendConfig().proxy;
  if (!proxy || typeof proxy !== "string" || !proxy.trim()) return undefined;

  if (proxyDispatcherCache && proxyDispatcherCache.proxy === proxy) return proxyDispatcherCache.agent;

  try {
    const { ProxyAgent } = await import("undici");
    const agent = new ProxyAgent(proxy.trim());
    proxyDispatcherCache = { proxy, agent };
    return agent;
  } catch {
    // 拿不到 ProxyAgent 时退回直连，并让上层的报错提示代理可能是原因。
    return undefined;
  }
}

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
  for (const message of messages) {
    if (message.role === "commander") {
      if (message.turnId === currentTurnId) continue;
      turns.push({ turnId: message.turnId, commander: message.cleaned ?? message.text, reply: null });
    } else if (message.role === "agent" && message.agentId === agentId) {
      const turn = turns.find((item) => item.turnId === message.turnId);
      if (turn && message.status === "done" && message.text) turn.reply = message.text;
    }
  }

  // 从最近往回装，超过字符预算就停——保证近处上下文完整，远处自然淡出。
  const history = [];
  let used = 0;
  for (const turn of turns.slice(-MAX_HISTORY_TURNS).reverse()) {
    if (!turn.commander) continue;
    const pairs = [{ role: "user", content: turn.commander }];
    if (turn.reply) pairs.push({ role: "assistant", content: turn.reply });

    const cost = pairs.reduce((sum, item) => sum + item.content.length, 0);
    // 最近一轮无条件保留，否则可能一条都装不下导致成员完全失忆。
    if (history.length > 0 && used + cost > HISTORY_CHAR_BUDGET) break;

    used += cost;
    history.unshift(...pairs);
  }
  return history;
}

/** 解析该成员使用的密钥：优先按成员 id，其次按域名复用。 */
export function resolveApiKey(member) {
  const stored = secrets();
  const byId = stored?.apiKeys?.[member.id];
  if (typeof byId === "string" && byId.trim()) return byId.trim();

  const host = (() => {
    try {
      return new URL(member.api.baseUrl).host;
    } catch {
      return "";
    }
  })();
  const byHost = stored?.apiKeysByHost?.[host];
  if (typeof byHost === "string" && byHost.trim()) return byHost.trim();

  return null;
}

/** 统一超时：AbortController + 定时器，并与调用方的 signal 合并。 */
function withTimeout(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
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
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    parse: (json) => {
      const choice = json?.choices?.[0];
      const content = choice?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => part?.text ?? "").join("")
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
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
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
 * @param {object} options
 * @param {object} options.agent 成员定义
 * @param {string} options.prompt 指挥官的任务
 * @param {string} options.systemPrompt 人格 + 环境事实
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} options.onEvent
 * @param {object[]} [options.messages] 该房间的完整消息列表（用于重建历史）
 * @param {string|null} [options.turnId] 本轮 turnId
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
  const dispatcher = await proxyDispatcher();

  let result;
  try {
    const response = await fetch(request.url, {
      ...request.init,
      signal: timeout.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const hint =
        response.status === 401 || response.status === 403
          ? "（密钥无效或无权限）"
          : response.status === 404
            ? "（接口地址或模型名可能不对）"
            : "";
      const message = `API 返回 HTTP ${response.status}${hint}：${body.slice(0, 300)}`;
      onEvent({ type: "error", message });
      return { sessionId: null, finalText: "", exitCode: null, aborted: false, error: message, stderr: null };
    }

    result = request.parse(await response.json());
  } catch (error) {
    const aborted = timeout.signal.aborted;
    const message = aborted
      ? "请求超时或被中止。"
      : `请求失败：${error?.message ?? String(error)}。若该域名在国内需要代理，请检查 cc.config.json 的 backends.proxy。`;
    onEvent({ type: "error", message });
    return { sessionId: null, finalText: "", exitCode: null, aborted, error: message, stderr: null };
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
