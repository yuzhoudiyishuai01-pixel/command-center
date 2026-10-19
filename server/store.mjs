/**
 * 指挥室持久化存储（内存状态 + 分房间落盘）。
 *
 * 内存里保持完整状态（几个房间、几千条消息，完全放得下），落盘交给
 * storage.mjs：按房间 journal 追加写，维护时压成 snapshot。老版本的单文件
 * store.json 会在首次启动时自动迁移。
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "./config.mjs";
import { agents } from "./agents.mjs";
import { applyRoomRetention, pruneOrphanTemps, roomFootprint, rotateLog } from "./retention.mjs";
import { createStorage } from "./storage.mjs";

const STORE_PATH = resolve(config.dataDir, "store.json"); // 仅用于兼容旧脚本的提示
const storage = createStorage(config.dataDir);

/** 默认房间：一个全员群聊 + 每位成员一个私人频道。 */
function defaultRooms() {
  const now = new Date().toISOString();
  const rooms = [
    {
      id: "group",
      kind: "group",
      title: "指挥部",
      members: agents().map((agent) => agent.id),
      createdAt: now,
      messages: [],
      sessions: {},
    },
    ...agents().map((agent) => ({
      id: `dm-${agent.id}`,
      kind: "private",
      title: agent.name,
      members: [agent.id],
      createdAt: now,
      messages: [],
      sessions: {},
    })),
  ];
  return { rooms, order: rooms.map((room) => room.id) };
}

let state = null;
let metaTimer = null;
let metaDirty = false;

function load() {
  const base = defaultRooms();
  const loaded = storage.load({
    version: 2,
    order: base.order,
    rooms: base.rooms,
    profileSignatures: {},
    migratedFrom: null,
  });
  state = migrate(loaded, base);
}

/**
 * 补齐缺失的房间与成员，使旧存档/名册变化后仍能启动。
 * 名册是成员列表的唯一来源：旧存档不能擅自增删成员。
 */
function migrate(loaded, base) {
  const byId = new Map((loaded.rooms ?? []).map((room) => [room.id, room]));
  const merged = [];

  for (const fresh of base.rooms) {
    const old = byId.get(fresh.id);
    if (!old) {
      merged.push(fresh);
      continue;
    }
    byId.delete(fresh.id);
    merged.push({
      ...fresh,
      ...old,
      members: fresh.members,
      messages: Array.isArray(old.messages) ? old.messages : [],
      sessions: old.sessions && typeof old.sessions === "object" ? old.sessions : {},
    });
  }

  // 保留用户自建/自定义房间（成员非空的）。
  for (const leftover of byId.values()) {
    if (Array.isArray(leftover?.members) && leftover.members.length > 0) merged.push(leftover);
  }

  const order = (loaded.order ?? []).filter((id) => merged.some((room) => room.id === id));
  for (const room of merged) if (!order.includes(room.id)) order.push(room.id);

  return {
    version: 2,
    rooms: merged,
    order,
    profileSignatures: loaded.profileSignatures ?? {},
  };
}

/** 房间目录（meta.json）落盘：只含房间元信息，不含消息。 */
function saveMeta() {
  if (!state) return;
  const meta = {
    version: 2,
    order: state.order,
    rooms: {},
    profileSignatures: state.profileSignatures ?? {},
  };
  for (const room of state.rooms) {
    meta.rooms[room.id] = {
      id: room.id,
      kind: room.kind,
      title: room.title,
      members: room.members,
      createdAt: room.createdAt,
    };
  }
  storage.saveMeta(meta);
}

/** 标记房间元信息有改动，稍后合并落盘（消息本身走 journal，不受影响）。 */
export function touch() {
  metaDirty = true;
  if (metaTimer) return;
  metaTimer = setTimeout(() => {
    metaTimer = null;
    if (!metaDirty) return;
    metaDirty = false;
    try {
      saveMeta();
    } catch (error) {
      console.error(`[store] 保存房间目录失败：${error.message}`);
    }
  }, 250);
  metaTimer.unref?.();
}

export function getState() {
  if (!state) load();
  return state;
}

// ══ 体量维护 ═══════════════════════════════════════════════════════════════
//
// 1. 清掉原子写入崩溃留下的 *.tmp
// 2. 轮转日志
// 3. 把超期轮次「先归档、再降级成摘要」，然后重写该房间快照
// 4. 把过大的 journal 压成 snapshot

let lastHousekeepingAt = 0;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @param {{force?: boolean}} [options] force=true 时忽略节流（启动时用）
 */
export async function runHousekeeping({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastHousekeepingAt < HOUSEKEEPING_INTERVAL_MS) return null;
  lastHousekeepingAt = now;

  const report = { prunedTemps: [], rotated: false, rooms: [], compacted: [], error: null };

  try {
    report.prunedTemps = pruneOrphanTemps(config.dataDir);
    report.rotated = rotateLog(resolve(config.dataDir, "server.log"));
  } catch (error) {
    report.error = error.message;
  }

  const snapshot = getState();
  let changed = false;
  for (const room of snapshot.rooms) {
    try {
      const before = roomFootprint(room.messages).chars;
      const result = await applyRoomRetention(room);
      const after = roomFootprint(room.messages).chars;
      if (result.changed && (after < before || result.stubbed > 0)) {
        storage.rewriteRoom(room);
        changed = true;
        report.rooms.push({
          roomId: room.id,
          stubbed: result.stubbed,
          charsBefore: before,
          charsAfter: after,
          archivePath: result.archivePath,
        });
      } else if (storage.compactIfNeeded(room)) {
        report.compacted.push(room.id);
      }
    } catch (error) {
      report.error = report.error ?? error.message;
    }
  }

  if (changed) touch();
  return report;
}

/**
 * 清扫"僵尸任务"：把仍标记为 working 的成员回话改成 interrupted。
 * 进程被强杀时 agent_end 永远不会到达，界面会一直显示"作业中"。
 */
export function sweepInterruptedTurns() {
  const snapshot = getState();
  const now = new Date().toISOString();
  let swept = 0;

  for (const room of snapshot.rooms) {
    let roomChanged = false;
    for (const message of room.messages) {
      if (message.role !== "agent" || message.status !== "working") continue;
      message.status = "interrupted";
      message.error = message.error ?? "服务在成员作业中途重启，本次作业未能完成。";
      message.durationMs = message.durationMs ?? null;
      message.finishedAt = now;
      storage.patchMessage(room.id, message.id, {
        status: message.status,
        error: message.error,
        durationMs: message.durationMs,
        finishedAt: now,
      });
      roomChanged = true;
      swept += 1;
    }
    if (roomChanged) storage.rewriteRoom(room);
  }

  return swept;
}

export function getRoom(roomId) {
  return getState().rooms.find((room) => room.id === roomId) ?? null;
}

export function listRooms() {
  const snapshot = getState();
  return snapshot.order.map((id) => snapshot.rooms.find((room) => room.id === id)).filter(Boolean);
}

export function appendMessage(roomId, message) {
  const room = getRoom(roomId);
  if (!room) throw new Error(`房间不存在：${roomId}`);
  room.messages.push(message);
  storage.appendMessage(roomId, message);
  return message;
}

export function patchMessage(roomId, messageId, patch) {
  const room = getRoom(roomId);
  if (!room) return null;
  const message = room.messages.find((item) => item.id === messageId);
  if (!message) return null;
  Object.assign(message, patch);
  storage.patchMessage(roomId, messageId, patch);
  return message;
}

/** 取某成员在某房间的会话 id，用于多轮续接。 */
export function getSession(roomId, agentId) {
  return getRoom(roomId)?.sessions?.[agentId] ?? null;
}

export function setSession(roomId, agentId, sessionId) {
  const room = getRoom(roomId);
  if (!room) return;
  room.sessions ??= {};
  room.sessions[agentId] = sessionId;
  storage.setSession(roomId, agentId, sessionId);
}

/**
 * 判断某成员的 profile 配置是否变化过；变化了就让它在所有房间里重新开始会话。
 * 原因：system prompt 在会话首次创建时就固化进历史，改人格不会自动生效。
 */
export function resetSessionsIfProfileChanged(agentId, signature) {
  const snapshot = getState();
  snapshot.profileSignatures ??= {};
  const previous = snapshot.profileSignatures[agentId];

  if (previous === signature) return false;

  let cleared = 0;
  for (const room of snapshot.rooms) {
    if (room.sessions && Object.hasOwn(room.sessions, agentId)) {
      delete room.sessions[agentId];
      storage.setSession(room.id, agentId, null);
      cleared += 1;
    }
  }
  snapshot.profileSignatures[agentId] = signature;
  touch();
  return cleared > 0 || previous === undefined ? cleared > 0 : true;
}

/**
 * 清空某成员在**所有房间**里的会话，让它下次开工时从零开始。
 * 这是手动动作：清完它就不记得之前聊过什么。
 */
export function resetAgentSessions(agentId) {
  const snapshot = getState();
  let cleared = 0;
  for (const room of snapshot.rooms) {
    if (room.sessions && Object.hasOwn(room.sessions, agentId)) {
      delete room.sessions[agentId];
      storage.setSession(room.id, agentId, null);
      cleared += 1;
    }
  }
  return cleared;
}

export function createRoom({ title, members, kind = "group" }) {
  const snapshot = getState();
  const validMembers = members.filter((id) => agents().some((agent) => agent.id === id));
  const room = {
    id: `room-${randomUUID().slice(0, 8)}`,
    kind,
    title: title?.trim() || "新频道",
    members: validMembers.length > 0 ? validMembers : agents().slice(0, 1).map((agent) => agent.id),
    createdAt: new Date().toISOString(),
    messages: [],
    sessions: {},
  };
  snapshot.rooms.push(room);
  snapshot.order.push(room.id);
  storage.rewriteRoom(room);
  touch();
  return room;
}

export function deleteRoom(roomId) {
  const snapshot = getState();
  const room = getRoom(roomId);
  // 默认房间不允许删除，否则界面会失去入口。
  if (!room || (room.kind === "private" && room.id.startsWith("dm-")) || room.id === "group") return false;
  snapshot.rooms = snapshot.rooms.filter((item) => item.id !== roomId);
  snapshot.order = snapshot.order.filter((id) => id !== roomId);
  storage.removeRoom(roomId);
  touch();
  return true;
}

/** 进程退出前强制落盘：压快照 + 清 journal + 存 meta。 */
export function flushNow() {
  if (metaTimer) {
    clearTimeout(metaTimer);
    metaTimer = null;
  }
  if (!state) return;
  try {
    storage.flushAll(state.rooms);
    saveMeta();
  } catch (error) {
    console.error(`[store] 退出前保存失败：${error.message}`);
  }
}

/** 存储层句柄（测试/统计用）。 */
export function storageInfo() {
  if (!state) return { rooms: 0, journalBytes: 0 };
  const journalBytes = state.rooms.reduce((sum, room) => sum + storage.journalSize(room.id), 0);
  return { rooms: state.rooms.length, journalBytes };
}

export { STORE_PATH };

/**
 * 成员被删除后的房间清理：把它从所有房间移除，并删掉因此变空的房间。
 *
 * 为什么需要：每位成员创建时都会有一个私人频道（dm-<id>）。成员删了但频道
 * 留着，侧栏就会出现一堆指向已删成员的"暂无对话"死房间。
 *
 * @param {string} agentId
 * @returns {{removedRooms: string[], touchedRooms: string[]}}
 */
export function removeMemberFromRooms(agentId) {
  const snapshot = getState();
  const removedRooms = [];
  const touchedRooms = [];

  for (const room of [...snapshot.rooms]) {
    if (!room.members?.includes(agentId) && room.id !== `dm-${agentId}`) continue;
    room.members = (room.members ?? []).filter((id) => id !== agentId);
    if (room.sessions && Object.hasOwn(room.sessions, agentId)) {
      delete room.sessions[agentId];
      storage.setSession(room.id, agentId, null);
    }
    // 私人频道随成员一起消失；其它房间只有在空掉时才删（群聊永不删）。
    const isDm = room.id === `dm-${agentId}`;
    if (isDm || (room.members.length === 0 && room.id !== "group")) {
      removedRooms.push(room.id);
      continue;
    }
    touchedRooms.push(room.id);
    storage.rewriteRoom(room);
  }

  if (removedRooms.length > 0) {
    snapshot.rooms = snapshot.rooms.filter((room) => !removedRooms.includes(room.id));
    snapshot.order = snapshot.order.filter((id) => !removedRooms.includes(id));
    for (const roomId of removedRooms) storage.removeRoom(roomId);
  }
  touch();
  return { removedRooms, touchedRooms };
}
