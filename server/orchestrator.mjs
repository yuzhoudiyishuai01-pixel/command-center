/**
 * 指令解析与任务编排。
 *
 * 群聊里一条指令要决定"谁去做"：
 *   - 写了 @名字 就只派给被点名的人（可以点多个）
 *   - 写 @全体 或不点名，就派给房间里所有成员，并行开工
 * 私人频道里只有一位成员，永远只派给他。
 *
 * 每位成员的回话是一条独立消息，流式追加内容块（思考 / 工具动作 / 正文），
 * 这样界面上能实时看到每个人正在干什么。
 */
import { randomUUID } from "node:crypto";

import { agents, agentById } from "./agents.mjs";
import { CAPABILITIES, capabilityById } from "./capabilities.mjs";
import { runTurn } from "./dispatcher.mjs";
import { appendMessage, getRoom, getSession, patchMessage, setSession, touch } from "./store.mjs";

/** 从正文里剥掉 @能力名，返回命中的能力 id。 */
function extractCapabilities(text) {
  const hit = [];
  let rest = text;

  for (const capability of CAPABILITIES) {
    // 能力名有中文（如"维基"），此时 \b 在中文边界上不可靠，所以结尾用
    // 前瞻断言「后面不能再跟字母数字」来定界。
    const names = [capability.label, ...(capability.aliases ?? [])];
    let matched = false;
    for (const name of names) {
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`@\\s*${escaped}(?![A-Za-z0-9])`, "gi");
      if (re.test(rest)) {
        matched = true;
        rest = rest.replace(re, " ");
      }
    }
    if (matched) hit.push(capability.id);
  }

  return { capabilities: hit, rest };
}

/** 把一条指令解析成「派给谁」「用哪个能力」+「去掉 @ 之后的正文」。 */
export function resolveTargets(room, text) {
  const mentioned = [];
  let rest = text;

  // 先剥能力开关：`@GitHub`、`@维基` 之类。必须在成员名之前剥，
  // 否则 `@GitHub` 会被当成一次成员点名（匹配不到成员，但会污染正文）。
  const capResult = extractCapabilities(rest);
  const capabilities = capResult.capabilities;
  rest = capResult.rest;

  // 逐位成员匹配 @名字 / @id（大小写不敏感），命中即记录并把它从正文里去掉。
  for (const agent of agents()) {
    const patterns = [agent.name, agent.id];
    let hit = false;
    for (const pattern of patterns) {
      const re = new RegExp(`@\\s*${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      if (re.test(rest)) {
        hit = true;
        rest = rest.replace(re, " ");
      }
    }
    if (hit) mentioned.push(agent.id);
  }

  const wantsEveryone = /@\s*(全体|all|everyone|所有人)\b/i.test(rest);
  if (wantsEveryone) rest = rest.replace(/@\s*(全体|all|everyone|所有人)\b/gi, " ");

  const cleaned = rest.replace(/\s+/g, " ").trim();
  const inRoom = new Set(room.members);

  let targets;
  if (room.kind === "private") {
    targets = room.members.slice(0, 1);
  } else if (mentioned.length > 0) {
    targets = mentioned.filter((id) => inRoom.has(id));
  } else if (wantsEveryone) {
    targets = room.members.slice();
  } else {
    // 群聊里不点名 = 全员并行开工，符合"指挥室"的默认语义。
    targets = room.members.slice();
  }

  return {
    targets,
    cleaned: cleaned || text.trim(),
    mentioned,
    capabilities,
    broadcast: wantsEveryone || (mentioned.length === 0 && room.kind !== "private"),
  };
}

/**
 * 把选中的能力指令前置到任务正文。
 *
 * 为什么是"前置指令"而不是"过滤器"：这些能力不是外挂工具，而是要求成员
 * **换用另一条数据来源**。指令里带了实测可用的接口地址，成员用自己已有的
 * 联网/命令工具就能真正取到数据，而不是靠训练记忆猜。
 */
export function withCapabilityDirectives(prompt, capabilityIds = []) {
  if (capabilityIds.length === 0) return prompt;

  const directives = capabilityIds
    .map((id) => capabilityById(id))
    .filter(Boolean)
    .map((capability) => capability.instruction);

  if (directives.length === 0) return prompt;

  return `${directives.join("\n\n---\n\n")}\n\n---\n\n【指挥官的任务】\n${prompt}`;
}

/** 新建一条成员回话消息的骨架。 */
function newReplyMessage(agentId, turnId) {
  return {
    id: `msg-${randomUUID().slice(0, 12)}`,
    role: "agent",
    agentId,
    turnId,
    at: new Date().toISOString(),
    status: "working",
    blocks: [],
    text: "",
    usage: null,
    error: null,
    durationMs: null,
  };
}

/**
 * 让一位成员完成一次任务，边跑边把事件合并进他的回话消息。
 *
 * @returns {Promise<{ok: boolean, messageId: string, sessionId: string|null}>}
 */
export async function dispatchToAgent({ roomId, agent, prompt, turnId, signal, onEvent = () => {} }) {
  const started = Date.now();
  const reply = newReplyMessage(agent.id, turnId);
  appendMessage(roomId, reply);

  const emit = (event) => {
    mergeEventIntoMessage(roomId, reply.id, event);
    // 发布扁平结构并附带定位信息：前端要按 event.type 直接分派，
    // 若把事件塞进 event 字段再包一层，前端读到的 type 会是 undefined。
    onEvent({ ...event, agentId: agent.id, messageId: reply.id });
  };

  emit({ type: "agent_start", turnId });

  const room = getRoom(roomId);
  const result = await runTurn({
    agent,
    prompt,
    sessionId: getSession(roomId, agent.id),
    signal,
    onEvent: emit,
    // API 后端无状态：靠这两个把该成员的多轮语境重建出来。
    messages: room?.messages ?? [],
    turnId,
  });

  if (result.sessionId) setSession(roomId, agent.id, result.sessionId);

  const finalPatch = {
    status: result.aborted ? "aborted" : result.error ? "failed" : "done",
    durationMs: Date.now() - started,
    error: result.error && result.error !== "aborted" ? result.error : null,
  };
  patchMessage(roomId, reply.id, finalPatch);
  emit({ type: "agent_end", ...finalPatch, sessionId: result.sessionId });

  return { ok: !result.aborted && !result.error, messageId: reply.id, sessionId: result.sessionId };
}

/** 把 runner 的归一化事件合并进成员回话消息的内容块。 */
function mergeEventIntoMessage(roomId, messageId, event) {
  const room = getRoom(roomId);
  if (!room) return;
  const message = room.messages.find((item) => item.id === messageId);
  if (!message) return;
  message.blocks ??= [];

  // 写入时就截断大段输出。
  //
  // 为什么在写入时做而不是事后清理：实测单条消息能长到 152 KB、整库 2.5 MB，
  // 全是工具调用输出。等到落盘再压缩，内存里已经先胖了一圈；
  // 而且一条消息一旦写入就几乎不会再被读全，留着完整副本没有收益。
  const cap = (value) =>
    typeof value === "string" && value.length > 600
      ? `${value.slice(0, 600)}\n…（输出过长，已截断 ${value.length - 600} 字）`
      : value;

  switch (event.type) {
    case "thinking": {
      const last = message.blocks[message.blocks.length - 1];
      if (last?.kind === "thinking") last.text += event.text;
      else message.blocks.push({ kind: "thinking", text: event.text });
      break;
    }
    case "text": {
      const last = message.blocks[message.blocks.length - 1];
      if (last?.kind === "text") last.text += event.text;
      else message.blocks.push({ kind: "text", text: event.text });
      break;
    }
    case "tool_call": {
      message.blocks.push({
        kind: "tool",
        callId: event.callId,
        tool: event.tool,
        label: event.label,
        detail: cap(event.detail),
        status: "running",
        result: null,
      });
      break;
    }
    case "tool_result": {
      // 按 callId 配对；找不到就单独挂一条，保证信息不丢。
      const block = message.blocks.find((item) => item.kind === "tool" && item.callId === event.callId);
      if (block) {
        block.status = event.status;
        block.result = cap(event.result);
      } else {
        message.blocks.push({
          kind: "tool",
          callId: event.callId,
          tool: "unknown",
          label: "工具结果",
          detail: null,
          status: event.status,
          result: cap(event.result),
        });
      }
      break;
    }
    case "error": {
      message.error = event.message;
      break;
    }
    case "final": {
      message.text = event.text ?? message.text;
      break;
    }
    case "usage": {
      message.usage = event.usage;
      break;
    }
    default:
      break;
  }

  // 只有正文块才用于"最终答复"，思考与工具动作单独展示。
  const textBlocks = (message.blocks ?? []).filter((block) => block.kind === "text");
  if (textBlocks.length > 0) message.text = textBlocks.map((block) => block.text).join("\n\n");

  touch();
  return message;
}

/**
 * 处理一条指挥官指令：记录指令、解析目标、并行派发。
 *
 * @returns {Promise<{commanderMessage: object, targets: string[], results: object[]}>}
 */
export async function handleCommanderMessage({ roomId, text, selectedCapabilities = [], signal, onEvent = () => {} }) {
  const room = getRoom(roomId);
  if (!room) throw new Error(`房间不存在：${roomId}`);

  const resolved = resolveTargets(room, text);

  // 界面点选的开关与正文里手打的 @GitHub/@维基 合并，去重后保持稳定顺序。
  const capabilities = [...new Set([...selectedCapabilities, ...resolved.capabilities])].filter((id) =>
    CAPABILITIES.some((capability) => capability.id === id),
  );

  const { targets, cleaned, mentioned, broadcast } = resolved;
  const turnId = `turn-${randomUUID().slice(0, 8)}`;

  // 能力开关改变的是"这次优先查哪里"，所以指令要前置进任务正文。
  const prompt = withCapabilityDirectives(cleaned, capabilities);

  const commanderMessage = appendMessage(roomId, {
    id: `msg-${randomUUID().slice(0, 12)}`,
    role: "commander",
    turnId,
    at: new Date().toISOString(),
    text,
    cleaned,
    targets,
    mentioned,
    capabilities,
    broadcast,
  });

  onEvent({ type: "commander", message: commanderMessage });

  const dispatched = targets.map(agentById).filter(Boolean);

  // 并行派发：指挥室的价值就在于让成员同时开工。
  const settled = await Promise.allSettled(
    dispatched.map((agent) =>
      dispatchToAgent({ roomId, agent, prompt, turnId, signal, onEvent }).catch((error) => {
        onEvent({ type: "agent_error", agentId: agent.id, message: error.message });
        return { ok: false, agentId: agent.id, error: error.message };
      }),
    ),
  );

  return {
    commanderMessage,
    targets,
    results: settled.map((entry, index) => ({
      agentId: dispatched[index]?.id ?? null,
      status: entry.status,
      value: entry.status === "fulfilled" ? entry.value : String(entry.reason),
    })),
  };
}
