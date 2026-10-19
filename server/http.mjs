/**
 * 指挥室的 HTTP 服务。
 *
 * 零依赖：只用 node:http，直接对外提供静态前端与 JSON API。
 * 实时推送用 SSE（Server-Sent Events）——单向、基于原生 EventSource，
 * 非常适合"成员正在干什么"这种持续播报的场景。
 *
 * 路由：
 *   GET  /api/state                 名册 + 房间列表 + 指定房间的消息
 *   GET  /api/rooms/:id/events      SSE：该房间的实时事件流
 *   POST /api/rooms/:id/messages    指挥官下达指令（立即返回，结果走 SSE）
 *   POST /api/rooms/:id/abort       中止该房间正在跑的所有成员
 *   POST /api/rooms                 新建频道
 *   DEL  /api/rooms/:id             删除自建频道
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import { config, startupWarnings } from "./config.mjs";
import { agents, CAPABILITY_LABELS } from "./agents.mjs";
import { BACKEND_KINDS, createMember, deleteMember, updateMember } from "./members.mjs";
import { hasApiKey } from "./api-backend.mjs";
import { backendNameFor } from "./backends.mjs";
import { publicCapabilities } from "./capabilities.mjs";
import { backendAvailability, BACKEND_LABELS } from "./dispatcher.mjs";
import { createRoom, deleteRoom, ensureMemberRooms, flushNow, getRoom, getState, listRooms, removeMemberFromRooms, resetAgentSessions, storageInfo, touch } from "./store.mjs";
import { pageBefore, recentWindow, roomFootprint, compactMessage } from "./retention.mjs";
import { handleCommanderMessage } from "./orchestrator.mjs";
import { persistApiKey, removeApiKey } from "./secrets-store.mjs";
import { cookieFor, extractToken, isAuthorized, shouldBootstrapCookie, tokenizedUrl } from "./auth.mjs";
import { logEvent, statsSnapshot } from "./metrics.mjs";
import { turnQueue } from "./queue.mjs";
import { searchMessages } from "./search.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ── 事件总线 ────────────────────────────────────────────────────────────────
/** roomId -> Set<订阅者>；每个订阅者是一个 (event, id) => void。 */
const listeners = new Map();

/**
 * 每个房间的最近事件环形缓冲，用于断线重连时补发。
 *
 * SSE 自带 Last-Event-ID 机制：断线重连时浏览器会把最后收到的事件 id 带回来，
 * 我们把 id 更大的事件重放一遍。没有这一步，断网期间的过程事件（思考、工具
 * 调用）会永久丢失，只剩最终正文。
 */
const EVENT_BUFFER_SIZE = 400;
const eventBuffers = new Map(); // roomId -> { nextId, items: [{ id, event }] }

function bufferFor(roomId) {
  let buffer = eventBuffers.get(roomId);
  if (!buffer) {
    buffer = { nextId: 1, items: [] };
    eventBuffers.set(roomId, buffer);
  }
  return buffer;
}

function subscribe(roomId, listener) {
  if (!listeners.has(roomId)) listeners.set(roomId, new Set());
  listeners.get(roomId).add(listener);
  return () => {
    listeners.get(roomId)?.delete(listener);
    if (listeners.get(roomId)?.size === 0) listeners.delete(roomId);
  };
}

/** 返回分配的 event id，方便 SSE 用 `id:` 行标注。 */
function publish(roomId, event) {
  const buffer = bufferFor(roomId);
  const id = buffer.nextId;
  buffer.nextId += 1;
  buffer.items.push({ id, event });
  if (buffer.items.length > EVENT_BUFFER_SIZE) {
    buffer.items.splice(0, buffer.items.length - EVENT_BUFFER_SIZE);
  }
  const set = listeners.get(roomId);
  if (!set) return id;
  for (const listener of set) {
    try {
      listener(event, id);
    } catch {
      /* 单个订阅者出错不应影响其他订阅者 */
    }
  }
  return id;
}

/** 重连补发：返回 id 之后的事件。 */
function eventsAfter(roomId, lastEventId) {
  if (!lastEventId) return [];
  const buffer = bufferFor(roomId);
  return buffer.items.filter((item) => item.id > lastEventId);
}

// ── 正在运行的回合 ──────────────────────────────────────────────────────────
/** roomId -> AbortController，用于中止该房间正在跑的成员。 */
const running = new Map();

// ── 工具函数 ────────────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 成员公开信息（不含人格正文，避免把提示词发到浏览器）。 */
function publicAgents() {
  return agents().map((agent) => {
    const backend = backendNameFor(agent);
    const impl = BACKEND_LABELS[backend] ?? { label: backend };
    const availability = backendAvailability(agent);
    const kind = BACKEND_KINDS[backend];
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      accent: agent.accent,
      avatar: agent.avatar,
      capabilities: agent.capabilities.map((key) => ({ key, label: CAPABILITY_LABELS[key] ?? key })),
      // 把"由谁提供智力"如实交给界面显示，避免牌子与实质不符。
      backend,
      backendLabel: impl.label,
      backendAvailable: availability.available,
      backendReason: availability.reason,
      // 界面据此决定是否显示"能动手"的徽标
      toolCapable: Boolean(kind?.toolCapable),
      seed: Boolean(agent.seed),
      // API 成员的连接摘要（不含密钥）
      api: agent.api ? { baseUrl: agent.api.baseUrl, model: agent.api.model } : null,
      hasApiKey: agent.api ? hasApiKey(agent) : null,
    };
  });
}

function roomSummary(room) {
  const last = room.messages[room.messages.length - 1];
  return {
    id: room.id,
    kind: room.kind,
    title: room.title,
    members: room.members,
    createdAt: room.createdAt,
    messageCount: room.messages.length,
    lastAt: last?.at ?? null,
    lastText: last ? (last.text ?? "").replace(/\s+/g, " ").slice(0, 80) : "",
    running: running.has(room.id),
  };
}

// ── 静态文件 ────────────────────────────────────────────────────────────────
async function serveStatic(req, res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : normalize(urlPath).replace(/^([/\\])+/, "");
  const target = resolve(join(config.publicDir, relative));
  // 目录穿越防护：解析后的路径必须仍在 public 目录内。
  if (!target.startsWith(resolve(config.publicDir))) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 未找到");
  }
}

// ── API ─────────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const segments = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // GET /api/state?room=<id>
  if (req.method === "GET" && segments[1] === "state") {
    const rooms = listRooms();
    const requested = url.searchParams.get("room");
    const active = rooms.find((room) => room.id === requested) ?? rooms[0] ?? null;

    // 只传最近窗口，不传整间房的历史。
    //
    // 实测：整库 2.5 MB 消息时，单单打开一次「指挥部」就要传这么多，
    // 页面渲染也随之变卡。历史改为按页拉取（GET /api/rooms/:id/messages）。
    const window = active ? recentWindow(active.messages) : { messages: [], hasMore: false };
    const footprint = active ? roomFootprint(active.messages) : null;

    sendJson(res, 200, {
      agents: publicAgents(),
      // 能力开关：与成员正交，可组合（@Claude @GitHub …）。
      capabilities: publicCapabilities(),
      // 可选接入方式（新建成员用）
      backendKinds: Object.entries(BACKEND_KINDS).map(([id, meta]) => ({
        id,
        label: meta.label,
        kind: meta.kind,
        toolCapable: meta.toolCapable,
      })),
      rooms: rooms.map(roomSummary),
      activeRoom: active
        ? {
            id: active.id,
            kind: active.kind,
            title: active.title,
            members: active.members,
            messages: window.messages,
            hasMoreHistory: window.hasMore,
            // 体量摘要：让"臃肿"可被看见，而不是只靠感觉
            footprint,
          }
        : null,
      workspace: config.workspace,
      permissionMode: config.permissionMode,
      // 运行态摘要：界面底部/统计面板用，也给脚本做健康检查。
      queue: turnQueue().snapshot(),
      storage: storageInfo(),
      // 让界面知道"哪些能力此刻不可用"（例如没装 dsh CLI）。
      warnings: startupWarnings(),
    });
    return true;
  }

  // GET /api/stats —— 观测数据（作业数、失败率、耗时、token 用量、队列）
  if (req.method === "GET" && segments[1] === "stats" && segments.length === 2) {
    sendJson(
      res,
      200,
      statsSnapshot({
        queue: turnQueue().snapshot(),
        runningRooms: [...running.keys()],
        storage: storageInfo(),
      }),
    );
    return true;
  }

  // GET /api/search?q=<关键词>&room=<id>&limit=30 —— 跨房间检索历史
  if (req.method === "GET" && segments[1] === "search" && segments.length === 2) {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length === 0) {
      sendJson(res, 400, { error: "缺少查询词 q" });
      return true;
    }
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
    const roomId = url.searchParams.get("room") || null;
    sendJson(res, 200, searchMessages(query, { roomId, limit }));
    return true;
  }

  // GET /api/rooms/:id/messages?before=<messageId>&limit=40 —— 历史分页
  if (req.method === "GET" && segments[1] === "rooms" && segments[3] === "messages") {
    const roomId = decodeURIComponent(segments[2]);
    const room = getRoom(roomId);
    if (!room) {
      sendJson(res, 404, { error: "房间不存在" });
      return true;
    }
    const before = url.searchParams.get("before");
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 40));
    const page = pageBefore(room.messages, before, limit);
    sendJson(res, 200, { messages: page.messages, hasMore: page.hasMore });
    return true;
  }

  // GET /api/rooms/:id/events  (SSE)
  if (req.method === "GET" && segments[1] === "rooms" && segments[3] === "events") {
    const roomId = decodeURIComponent(segments[2]);
    if (!getRoom(roomId)) {
      sendJson(res, 404, { error: "房间不存在" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify({ type: "hello", roomId })}\n\n`);

    // 断线重连：浏览器把最后收到的事件 id 放在 Last-Event-ID 里（也支持 query
    // 参数，方便非浏览器客户端）。
    const headerId = Number(req.headers["last-event-id"]);
    const queryId = Number(url.searchParams.get("lastEventId"));
    const lastEventId = Number.isFinite(headerId) && headerId > 0 ? headerId : Number.isFinite(queryId) && queryId > 0 ? queryId : 0;
    if (lastEventId > 0) {
      for (const item of eventsAfter(roomId, lastEventId)) {
        res.write(`id: ${item.id}\ndata: ${JSON.stringify(item.event)}\n\n`);
      }
    }

    const unsubscribe = subscribe(roomId, (event, id) => {
      res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // 心跳：防止中间层因空闲而断开长连接。
    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 20_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    return true;
  }

  // POST /api/rooms/:id/messages
  if (req.method === "POST" && segments[1] === "rooms" && segments[3] === "messages") {
    const roomId = decodeURIComponent(segments[2]);
    const room = getRoom(roomId);
    if (!room) {
      sendJson(res, 404, { error: "房间不存在" });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: `请求体无法解析：${error.message}` });
      return true;
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "指令内容为空" });
      return true;
    }

    // 界面点选的能力开关；与正文里手打的 @GitHub/@维基 等价，两者会合并。
    const selectedCapabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter((id) => typeof id === "string")
      : [];

    const controller = new AbortController();
    running.set(roomId, controller);
    publish(roomId, { type: "busy", roomId, busy: true });

    // 立即返回，让界面靠 SSE 追踪进度；成员在后台持续工作。
    sendJson(res, 202, { accepted: true, roomId });

    handleCommanderMessage({
      roomId,
      text,
      selectedCapabilities,
      signal: controller.signal,
      onEvent: (event) => publish(roomId, event),
    })
      .catch((error) => {
        publish(roomId, { type: "fatal", message: error.message });
      })
      .finally(() => {
        if (running.get(roomId) === controller) running.delete(roomId);
        publish(roomId, { type: "busy", roomId, busy: running.has(roomId) });
      });
    return true;
  }

  // POST /api/rooms/:id/abort
  if (req.method === "POST" && segments[1] === "rooms" && segments[3] === "abort") {
    const roomId = decodeURIComponent(segments[2]);
    const controller = running.get(roomId);
    controller?.abort();
    sendJson(res, 200, { aborted: Boolean(controller) });
    return true;
  }

  // POST /api/rooms
  if (req.method === "POST" && segments[1] === "rooms" && segments.length === 2) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return true;
    }
    const members = Array.isArray(body.members) ? body.members : [];
    if (members.length === 0) {
      sendJson(res, 400, { error: "至少选择一位成员" });
      return true;
    }
    const room = createRoom({
      title: body.title,
      members,
      kind: members.length === 1 ? "private" : "group",
    });
    sendJson(res, 201, { room: roomSummary(room) });
    return true;
  }

  // DELETE /api/rooms/:id
  if (req.method === "DELETE" && segments[1] === "rooms" && segments.length === 3) {
    const roomId = decodeURIComponent(segments[2]);
    const removed = deleteRoom(roomId);
    sendJson(res, removed ? 200 : 400, { removed });
    return true;
  }

  // ── 成员管理 ───────────────────────────────────────────────────────────────

  // GET /api/members —— 全部成员 + 可选的后端类型清单（供新建对话框用）
  if (req.method === "GET" && segments[1] === "members" && segments.length === 2) {
    sendJson(res, 200, {
      members: publicAgents(),
      backendKinds: Object.entries(BACKEND_KINDS).map(([id, meta]) => ({
        id,
        label: meta.label,
        kind: meta.kind,
        toolCapable: meta.toolCapable,
      })),
    });
    return true;
  }

  // POST /api/members —— 新建成员
  if (req.method === "POST" && segments[1] === "members" && segments.length === 2) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: `请求体无法解析：${error.message}` });
      return true;
    }

    const result = createMember(body);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return true;
    }

    // 密钥已由 createMember 原子地写进 secrets.json（失败则整体回滚），
    // 这里不再重复处理。

    // 安置新成员：进全员频道 + 建私人频道。空名册的第一位成员靠这一步
    // 才能真正“可用”，否则界面有成员但频道里没人，派活会静默失败。
    const placement = ensureMemberRooms(result.member);
    for (const roomId of ["group", placement.dmRoomId].filter(Boolean)) {
      const room = getRoom(roomId);
      if (!room) continue;
      publish(roomId, { type: "room_updated", room: roomSummary(room) });
    }

    sendJson(res, 201, {
      member: publicAgents().find((item) => item.id === result.member.id),
      rooms: { group: placement.group, dm: placement.dmRoomId },
    });
    return true;
  }

  // GET /api/members/:id/persona —— 编辑成员时按需取人格正文
  //
  // 为什么不放进 /api/state：人格是提示词，不该在每次页面加载时全量下发浏览器。
  // 只在用户点"编辑"时取一次。
  if (req.method === "GET" && segments[1] === "members" && segments[3] === "persona") {
    const id = decodeURIComponent(segments[2]);
    const member = agents().find((item) => item.id === id);
    if (!member) {
      sendJson(res, 404, { error: "成员不存在" });
      return true;
    }
    sendJson(res, 200, { id, persona: member.persona ?? "" });
    return true;
  }

  // PATCH /api/members/:id —— 修改成员（任何成员都可改，包括种子成员）
  if (req.method === "PATCH" && segments[1] === "members" && segments.length === 3) {
    const id = decodeURIComponent(segments[2]);
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: `请求体无法解析：${error.message}` });
      return true;
    }
    const result = updateMember(id, body);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    if (typeof body?.apiKey === "string" && body.apiKey.trim()) persistApiKey(id, body.apiKey.trim());
    sendJson(res, 200, { member: publicAgents().find((item) => item.id === id) });
    return true;
  }

  // DELETE /api/members/:id —— 删除成员（任何成员都可删）
  if (req.method === "DELETE" && segments[1] === "members" && segments.length === 3) {
    const id = decodeURIComponent(segments[2]);
    const result = deleteMember(id);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    // 一并清掉该成员的密钥，避免留下孤儿
    try {
      removeApiKey(id);
    } catch {
      /* 密钥清理失败不该阻止删除成员，但要留痕 */
      console.error(`[members] 删除 ${id} 的密钥失败`);
    }
    // 从所有房间移除该成员；它自己的私人频道也一并删掉（否则侧栏留死房间）。
    const cleanup = removeMemberFromRooms(id);
    sendJson(res, 200, { removed: id });
    return true;
  }

  // ── 频道成员（拉人 / 移除）─────────────────────────────────────────────────

  // POST /api/rooms/:id/members —— 把成员拉进频道
  if (req.method === "POST" && segments[1] === "rooms" && segments[3] === "members") {
    const roomId = decodeURIComponent(segments[2]);
    const room = getRoom(roomId);
    if (!room) {
      sendJson(res, 404, { error: "频道不存在" });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: `请求体无法解析：${error.message}` });
      return true;
    }
    const known = new Set(agents().map((agent) => agent.id));
    const toAdd = (Array.isArray(body?.members) ? body.members : []).filter(
      (id) => typeof id === "string" && known.has(id) && !room.members.includes(id),
    );
    if (toAdd.length === 0) {
      sendJson(res, 400, { error: "没有可加入的成员（可能已在频道内，或成员不存在）。" });
      return true;
    }
    room.members.push(...toAdd);
    // 私人频道引入第二位成员后就变成群聊
    if (room.members.length > 1) room.kind = "group";
    touch();
    publish(roomId, { type: "room_updated", room: roomSummary(room) });
    sendJson(res, 200, { room: roomSummary(room), added: toAdd });
    return true;
  }

  // DELETE /api/rooms/:id/members/:agentId —— 把成员移出频道
  if (req.method === "DELETE" && segments[1] === "rooms" && segments[3] === "members" && segments.length === 5) {
    const roomId = decodeURIComponent(segments[2]);
    const agentId = decodeURIComponent(segments[4]);
    const room = getRoom(roomId);
    if (!room) {
      sendJson(res, 404, { error: "频道不存在" });
      return true;
    }
    if (!room.members.includes(agentId)) {
      sendJson(res, 400, { error: "该成员不在这个频道里。" });
      return true;
    }
    if (room.members.length === 1) {
      sendJson(res, 400, { error: "频道至少要保留一位成员。" });
      return true;
    }
    room.members = room.members.filter((id) => id !== agentId);
    if (room.sessions && Object.hasOwn(room.sessions, agentId)) delete room.sessions[agentId];
    // 只剩一位时降级为私人频道
    if (room.members.length === 1 && room.id.startsWith("room-")) room.kind = "private";
    touch();
    publish(roomId, { type: "room_updated", room: roomSummary(room) });
    sendJson(res, 200, { room: roomSummary(room), removed: agentId });
    return true;
  }

  // POST /api/agents/:id/session/reset —— 清空某成员在所有房间的会话
  if (
    req.method === "POST" &&
    segments[1] === "agents" &&
    segments[3] === "session" &&
    segments[4] === "reset"
  ) {
    const agentId = decodeURIComponent(segments[2]);
    const agent = agents().find((item) => item.id === agentId);
    if (!agent) {
      sendJson(res, 404, { error: "成员不存在" });
      return true;
    }
    const cleared = resetAgentSessions(agent.id);
    sendJson(res, 200, { reset: agent.id, cleared });
    return true;
  }

  return false;
}

// ── 服务启动 ────────────────────────────────────────────────────────────────
export function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // 1) 带 ?token= 的首次访问：种 cookie，然后把明文 token 从地址栏去掉。
    if (shouldBootstrapCookie(req, url)) {
      const token = extractToken(req, url);
      url.searchParams.delete("token");
      const location = `${url.pathname}${url.search}`;
      res.writeHead(302, { "set-cookie": cookieFor(token), location });
      res.end();
      return;
    }

    // 2) 其余请求都要过鉴权（静态资源也拦，避免未授权时界面被打开）。
    if (!isAuthorized(req, url)) {
      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 401, {
          error: "未授权：需要访问 token",
          hint: "打开启动横幅里打印的带 ?token= 的网址，或设置 Authorization: Bearer <token>。",
        });
      } else {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(
          [
            "<!doctype html><meta charset='utf-8'><title>需要访问 token</title>",
            "<body style='background:#0b0417;color:#e8defa;font:16px/1.7 system-ui;padding:12vh 8vw'>",
            "<h1 style='color:#ff2ea6'>需要访问 token</h1>",
            "<p>指挥室默认启用共享 token 鉴权。请使用启动横幅里打印的网址（带 <code>?token=...</code>）。</p>",
            "<p>token 保存在 <code>data/.token</code>，也可以用环境变量 <code>CC_TOKEN</code> 指定。</p>",
            "</body>",
          ].join("\n"),
        );
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url)
        .then((handled) => {
          if (!handled) sendJson(res, 404, { error: `未知接口：${url.pathname}` });
        })
        .catch((error) => {
          console.error("[server] API 处理失败：", error);
          logEvent("api_error", { path: url.pathname, error: error.message });
          if (!res.headersSent) sendJson(res, 500, { error: error.message });
          else res.end();
        });
      return;
    }
    serveStatic(req, res, url.pathname).catch((error) => {
      console.error("[server] 静态资源失败：", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("500 服务器内部错误");
      }
    });
  });

  server.on("clientError", (error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  const shutdown = () => {
    for (const controller of running.values()) controller.abort();
    flushNow();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.on("exit", flushNow);

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolvePromise(server));
  });
}
