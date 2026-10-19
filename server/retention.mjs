/**
 * 体量控制：让指挥室长期使用后不会越来越臃肿。
 *
 * 问题从哪来（实测数据，非猜测）：
 *   - 194 条消息占了 254 万字，store.json 3.5 MB
 *   - 1860 个内容块，最大单条消息 152.8 KB
 *   - 根因：**每条工具调用的完整输出都被存进 message.blocks**，且永不清理
 *   - /api/state 每次返回整个房间的全部消息 → 打开一次频道传 2.5 MB
 *
 * 分层策略（从轻到重）：
 *   1. 写入时截断：单个 block 的正文与单条消息的 blocks 数量设上限
 *   2. 滚动保留：每房间只保留最近 N 轮"完整详情"，更早的降级为摘要
 *   3. 归档：降级前先把原始消息 gzip 进 data/archive/，需要时可回查
 *   4. 传输分页：/api/state 只带最近窗口，历史按需拉
 *
 * 关键原则：**先归档，再压缩**。任何被丢弃的细节都必须能在 archive 里找回，
 * 否则就是在替用户删数据。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";

import { config } from "./config.mjs";

/** 可调参数集中在这里，便于按实测数据调整。 */
export const RETENTION = {
  /** 每房间保留多少轮"完整详情"（一轮 = 一条指令 + 各成员回复）。 */
  keepRecentTurns: 30,
  /** 单条消息最多保留多少个内容块。 */
  maxBlocksPerMessage: 40,
  /** 单个内容块里 detail/text 的最大字符数。 */
  maxBlockChars: 600,
  /** 消息正文最大字符数（成员回复可能是几千上万字）。 */
  maxTextChars: 8000,
  /** /api/state 返回的最近消息条数。 */
  windowMessages: 40,
  /** 窗口里最近多少条保留完整过程明细，更早的只留正文。 */
  detailMessages: 10,
  /** API 后端重建历史时的字符预算（按字符而非轮数——一轮可能有几万字）。 */
  historyCharBudget: 24_000,
  /** 降级为摘要时，保留正文开头多少字符。 */
  stubHeadChars: 400,
};

/** 归档目录。 */
export function archiveDir() {
  return resolve(config.dataDir, "archive");
}

/** 按字符截断，并标注被截断了多少。 */
export function truncateText(text, max) {
  const value = typeof text === "string" ? text : text == null ? "" : String(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（省略 ${value.length - max} 字，完整内容见归档）`;
}

/**
 * 压缩一个内容块：保留结构与标签，截断大段正文。
 *
 * 为什么保留标签：界面上"工具调用 / 输出 / 步骤"这些结构本身就是信息，
 * 砍掉会让历史变得难以理解；真正占地方的是 detail 里的长文本。
 */
export function compactBlock(block) {
  if (!block || typeof block !== "object") return block;
  const next = { ...block };
  for (const key of ["detail", "text", "output", "result", "message"]) {
    if (typeof next[key] === "string") next[key] = truncateText(next[key], RETENTION.maxBlockChars);
  }
  return next;
}

/** 压缩一整条消息：截断正文 + 限制块数量 + 压缩每块。 */
export function compactMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { ...message };

  if (typeof next.text === "string") {
    next.text = truncateText(next.text, RETENTION.maxTextChars);
  }

  if (Array.isArray(next.blocks)) {
    if (next.blocks.length > RETENTION.maxBlocksPerMessage) {
      const dropped = next.blocks.length - RETENTION.maxBlocksPerMessage;
      next.blocks = [
        // 明确标出被折叠的块数，避免历史看起来"凭空少了一段"
        { kind: "notice", text: `…（更早的 ${dropped} 条过程记录已折叠，完整内容见归档）` },
        ...next.blocks.slice(-RETENTION.maxBlocksPerMessage).map(compactBlock),
      ];
    } else {
      next.blocks = next.blocks.map(compactBlock);
    }
  }

  return next;
}

/**
 * 把一条消息降级成"摘要存根"：只保留会话骨架，丢掉过程细节。
 *
 * 保留 id / role / agentId / turnId / status / 时间 / 正文开头。
 * 丢掉 blocks（过程明细）。界面仍能画出完整历史（谁在何时回复了什么），
 * 但不必为几百轮之前的工具日志付出体积与渲染代价。
 */
export function stubMessage(message) {
  if (!message || typeof message !== "object") return message;
  return {
    id: message.id,
    role: message.role,
    agentId: message.agentId ?? null,
    turnId: message.turnId ?? null,
    status: message.status ?? null,
    createdAt: message.createdAt ?? null,
    finishedAt: message.finishedAt ?? null,
    durationMs: message.durationMs ?? null,
    error: message.error ?? null,
    text: truncateText(message.text ?? "", RETENTION.stubHeadChars),
    cleaned: message.cleaned ?? null,
    capabilities: message.capabilities ?? null,
    // 明确标记：详情已归档，界面上可提示"查看归档"
    stubbed: true,
  };
}

/**
 * 轻量化一条消息：保留正文与元信息，丢掉过程明细（blocks）。
 *
 * 与 stubMessage 的区别：stubMessage 是落盘时的永久降级（正文只留开头），
 * 这里只影响**传输**——历史正文仍然完整可读，只是不再附带工具调用日志。
 */
export function lightenMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { ...message };
  delete next.blocks;
  if (typeof next.text === "string") next.text = truncateText(next.text, RETENTION.maxTextChars);
  return next;
}

/** 把消息按 turnId 归组，用于"轮"级别的保留判断。 */
function groupByTurn(messages) {
  const groups = [];
  let current = null;
  for (const message of messages) {
    const turnId = message.turnId ?? "__none__";
    if (!current || current.turnId !== turnId) {
      current = { turnId, messages: [] };
      groups.push(current);
    }
    current.messages.push(message);
  }
  return groups;
}

/** 计算某房间该保留 / 该归档的部分。 */
export function planRoomRetention(room) {
  const messages = Array.isArray(room?.messages) ? room.messages : [];
  const groups = groupByTurn(messages);

  if (groups.length <= RETENTION.keepRecentTurns) {
    return { keep: messages, stub: [], turns: groups.length };
  }

  const cutoff = groups.length - RETENTION.keepRecentTurns;
  const stub = messages.slice(0, messages.length - recentCount(groups, cutoff));
  const keep = messages.slice(stub.length);
  return { keep, stub, turns: groups.length };
}

/** 后 cutoff 组里一共有多少条消息。 */
function recentCount(groups, cutoff) {
  return groups.slice(cutoff).reduce((sum, group) => sum + group.messages.length, 0);
}

/**
 * 把一批原始消息 gzip 归档到 data/archive/。
 *
 * 用「一批一个文件」而不是追加同一个文件：gzip 追加需要维护流状态，
 * 而按批落盘失败时只影响这一批，不会损坏已有归档。
 */
export async function archiveMessages(roomId, messages, dir = archiveDir()) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let path = join(dir, `${roomId}-${stamp}.jsonl.gz`);
  let suffix = 0;
  while (existsSync(path)) {
    suffix += 1;
    path = join(dir, `${roomId}-${stamp}-${suffix}.jsonl.gz`);
  }

  const body = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  await pipeline(Readable.from([body]), createGzip({ level: 9 }), createWriteStream(path));
  return path;
}

/**
 * 对一个房间执行保留策略：归档超期轮次，然后就地降级；最近轮次做轻量压缩。
 *
 * 注意：**只有归档成功才会降级**。归档失败时保守放弃本次降级——
 * 宁可继续占用空间，也不能悄悄丢掉用户的历史。
 *
 * 另一个容易漏掉的点：即使没有超期轮次，也要压缩最近轮次的大块内容。
 * 否则活跃房间永远只增长不收敛（实测 132 条消息就攒了 1657 个内容块）。
 */
export async function applyRoomRetention(room, options = {}) {
  const plan = planRoomRetention(room);
  const dir = options.archiveDir ?? archiveDir();
  let archivePath = null;

  if (plan.stub.length > 0) {
    try {
      archivePath = await archiveMessages(room.id, plan.stub, dir);
    } catch (error) {
      return { archived: 0, stubbed: 0, archivePath: null, changed: false, error: error.message };
    }
    if (!archivePath) {
      return { archived: 0, stubbed: 0, archivePath: null, changed: false };
    }
    const stubById = new Map(plan.stub.map((message) => [message.id, stubMessage(message)]));
    room.messages = room.messages.map((message) => stubById.get(message.id) ?? compactMessage(message));
    return {
      archived: plan.stub.length,
      stubbed: plan.stub.length,
      archivePath,
      changed: true,
    };
  }

  // 没有超期轮次：仍然压一遍，把工具输出的完整副本收掉。
  room.messages = room.messages.map(compactMessage);
  return { archived: 0, stubbed: 0, archivePath: null, changed: true };
}

/**
 * 清理原子的落盘残留（进程被杀时留下的 *.tmp）。
 *
 * 实测在 data/ 里发现过 3 个共 3.3 MB 的 .tmp——它们永远不会被用到，
 * 只会让目录越来越臃肿。
 */
export function pruneOrphanTemps(dir = config.dataDir, minAgeMs = 60_000) {
  const removed = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.tmp$/i.test(name)) continue;
      const path = join(dir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs < minAgeMs) continue;
        unlinkSync(path);
        removed.push(name);
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return removed;
}

/** 日志轮转：超过上限就滚成 .1，只保留一份旧的。 */
export function rotateLog(file, maxBytes = 2 * 1024 * 1024) {
  try {
    if (!existsSync(file) || statSync(file).size < maxBytes) return false;
    const backup = `${file}.1`;
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(file, backup);
    return true;
  } catch {
    return false;
  }
}

/** 取某个房间的最近 N 条消息（用于 /api/state 的窗口传输）。 */
export function recentWindow(messages, limit = RETENTION.windowMessages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= limit) return { messages: list.map(compactMessage), hasMore: false };

  const slice = list.slice(-limit);
  // 最近的几条保留完整过程（可能正在看刚发生了什么）；
  // 更早的丢掉 blocks 只留正文——历史仍然可读，但不必为旧的工具日志付费。
  const detailFrom = Math.max(0, slice.length - RETENTION.detailMessages);
  const window = slice.map((message, index) =>
    index >= detailFrom ? compactMessage(message) : lightenMessage(message),
  );
  return { messages: window, hasMore: true };
}

/** 取某条消息之前的一页历史（游标分页）。 */
export function pageBefore(messages, beforeId, limit = 40) {
  const list = Array.isArray(messages) ? messages : [];
  let end = list.length;
  if (beforeId) {
    const index = list.findIndex((message) => message.id === beforeId);
    if (index >= 0) end = index;
  }
  const start = Math.max(0, end - limit);
  // 历史页只带正文：过程明细已在 archive 里，翻旧账时不需要占带宽。
  return { messages: list.slice(start, end).map(lightenMessage), hasMore: start > 0 };
}

/** 统计用：房间体量摘要（供界面/自检显示）。 */
export function roomFootprint(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let chars = 0;
  let blocks = 0;
  for (const message of list) {
    chars += (message.text ?? "").length;
    if (Array.isArray(message.blocks)) {
      blocks += message.blocks.length;
      for (const block of message.blocks) chars += JSON.stringify(block).length;
    }
  }
  return { messages: list.length, blocks, chars };
}
