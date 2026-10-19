/**
 * 跨房间消息搜索。
 *
 * 历史消息在内存里是完整可查的（体量维护只是把很久以前的轮次降级成摘要，
 * 摘要文本仍然可搜）。这里提供一个朴素的扫描实现：几千条消息的量级，
 * 全表扫描远比引入索引简单，而且结果更准。
 *
 * 真正的长期方案是给归档（data/archive/*.jsonl.gz）也建索引，但那需要
 * 引入依赖；当前版本先把"能搜"这件事做出来，归档搜索列为 TODO。
 */
import { agentById } from "./agents.mjs";
import { getState } from "./store.mjs";

/** 把消息里可搜的文本拼起来（正文 + 工具输出摘要 + 思考）。 */
function searchableText(message) {
  const parts = [message.text ?? ""];
  if (message.cleaned && message.cleaned !== message.text) parts.push(message.cleaned);
  for (const block of message.blocks ?? []) {
    if (block.kind === "thinking" || block.kind === "text") parts.push(block.text ?? "");
    else if (block.kind === "tool") {
      parts.push(block.label ?? "", block.detail ?? "", block.result ?? "");
    }
  }
  if (message.error) parts.push(message.error);
  return parts.filter(Boolean).join("\n");
}

/** 截取命中位置附近的一小段，给界面做高亮用。 */
function snippetAround(text, query, radius = 60) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * @param {string} query
 * @param {{roomId?: string|null, limit?: number}} [options]
 */
export function searchMessages(query, { roomId = null, limit = 30 } = {}) {
  const needle = String(query ?? "").trim();
  if (needle.length === 0) return { query: needle, total: 0, results: [] };

  const state = getState();
  const rooms = roomId ? state.rooms.filter((room) => room.id === roomId) : state.rooms;
  const results = [];
  let total = 0;

  for (const room of rooms) {
    // 从新到旧扫，越新的越可能是用户要找的。
    for (let index = room.messages.length - 1; index >= 0; index -= 1) {
      const message = room.messages[index];
      const haystack = searchableText(message);
      if (!haystack) continue;
      if (!haystack.toLowerCase().includes(needle.toLowerCase())) continue;
      total += 1;
      if (results.length < limit) {
        const agent = message.agentId ? agentById(message.agentId) : null;
        results.push({
          roomId: room.id,
          roomTitle: room.title,
          messageId: message.id,
          role: message.role,
          at: message.at,
          status: message.status ?? null,
          agentId: message.agentId ?? null,
          agentName: agent?.name ?? null,
          snippet: snippetAround(haystack, needle),
          // 降级过的历史只留了摘要，界面要提示"原文在归档里"
          stubbed: Boolean(message.stubbed),
        });
      }
    }
  }

  return { query: needle, total, results };
}
