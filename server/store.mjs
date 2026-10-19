/**
 * 指挥室持久化存储。
 *
 * 单一 JSON 文件 + 内存缓存：数据量很小（几个房间、几百条消息），不需要数据库。
 * 写入用"临时文件 + 原子改名"，避免进程被杀时留下半个文件。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "./config.mjs";
import { agents } from "./agents.mjs";
import { applyRoomRetention, pruneOrphanTemps, roomFootprint, rotateLog } from "./retention.mjs";

const STORE_PATH = resolve(config.dataDir, "store.json");
const STORE_VERSION = 1;

/** 默认房间：一个全员群聊 + 每位成员一个私人频道。 */
function defaultStore() {
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
  return { version: STORE_VERSION, rooms, order: rooms.map((room) => room.id) };
}

let state = null;
let flushTimer = null;
let dirty = false;

function load() {
  if (!existsSync(STORE_PATH)) {
    state = defaultStore();
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    state = migrate(parsed);
  } catch (error) {
    // 存档损坏时不静默丢弃：改名保留现场，然后从默认状态重新开始。
    const broken = `${STORE_PATH}.broken-${Date.now()}`;
    try {
      renameSync(STORE_PATH, broken);
      console.error(`[store] store.json 解析失败，已备份到 ${broken}：${error.message}`);
    } catch {
      console.error(`[store] store.json 解析失败且备份失败：${error.message}`);
    }
    state = defaultStore();
  }
}

/** 补齐缺失的房间与成员，使旧存档能跟上名册变化。 */
function migrate(parsed) {
  const base = defaultStore();
  const rooms = Array.isArray(parsed?.rooms) ? parsed.rooms : [];
  const byId = new Map(rooms.map((room) => [room.id, room]));

  const merged = base.rooms.map((fresh) => {
    const old = byId.get(fresh.id);
    if (!old) return fresh;
    byId.delete(fresh.id);
    return {
      ...fresh,
      ...old,
      // 名册是成员列表的唯一来源，旧存档不能擅自增删成员。
      members: fresh.members,
      messages: Array.isArray(old.messages) ? old.messages : [],
      sessions: old.sessions && typeof old.sessions === "object" ? old.sessions : {},
    };
  });

  // 保留用户自建的自定义房间。
  for (const leftover of byId.values()) {
    if (Array.isArray(leftover?.members) && leftover.members.length > 0) merged.push(leftover);
  }

  const order = Array.isArray(parsed?.order) ? parsed.order.filter((id) => merged.some((r) => r.id === id)) : [];
  for (const room of merged) if (!order.includes(room.id)) order.push(room.id);

  return { version: STORE_VERSION, rooms: merged, order };
}

function flush() {
  if (!dirty || !state) return;
  dirty = false;
  mkdirSync(config.dataDir, { recursive: true });
  const temp = `${STORE_PATH}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
  renameSync(temp, STORE_PATH);
}

/** 标记有改动，稍后落盘（合并短时间内的多次写入）。 */
export function touch() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 250);
  // 落盘计时器不应让进程无法退出。
  flushTimer.unref?.();
}

export function getState() {
  if (!state) load();
  return state;
}

// ══ 体量维护 ═══════════════════════════════════════════════════════════════
//
// 长期使用后 store.json 会不断变大（实测 194 条消息 → 2.5 MB，因为工具输出
// 被完整存进 blocks）。这里定期做三件事：
//   1. 清掉原子写入崩溃留下的 *.tmp（实测积累过 3.3 MB）
//   2. 轮转过大的日志
//   3. 把超期轮次「先归档、再降级成摘要」

let lastHousekeepingAt = 0;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 执行一次体量维护。
 *
 * @param {{force?: boolean}} [options] force=true 时忽略节流（启动时用）
 * @returns {Promise<object|null>} 报告；节流跳过时返回 null
 */
export async function runHousekeeping({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastHousekeepingAt < HOUSEKEEPING_INTERVAL_MS) return null;
  lastHousekeepingAt = now;

  const report = { prunedTemps: [], rotated: false, rooms: [], error: null };

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
      // 只有真的变小才算"维护过"——否则每次启动都会报一堆"已压缩 1 KB"的噪音。
      const after = roomFootprint(room.messages).chars;
      if (result.changed && (after < before || result.stubbed > 0)) {
        changed = true;
        report.rooms.push({
          roomId: room.id,
          stubbed: result.stubbed,
          charsBefore: before,
          charsAfter: after,
          archivePath: result.archivePath,
        });
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
 *
 * 为什么需要：成员回话先落库（状态 working），等 agent_end 事件到达才改成 done。
 * 如果服务进程在成员作业中途被杀（开发期最常见：排查时 Stop-Process），
 * 那个事件永远发不出来，于是消息状态永久冻结在 working——界面会一直显示
 * "作业中"，看起来像半个指挥室死了。重启时做一次清扫即可自愈。
 *
 * @returns {number} 被清扫的消息条数
 */
export function sweepInterruptedTurns() {
  const snapshot = getState();
  const now = new Date().toISOString();
  let swept = 0;

  for (const room of snapshot.rooms) {
    for (const message of room.messages) {
      if (message.role !== "agent" || message.status !== "working") continue;
      message.status = "interrupted";
      message.error = message.error ?? "服务在成员作业中途重启，本次作业未能完成。";
      message.durationMs = message.durationMs ?? null;
      message.finishedAt = now;
      swept += 1;
    }
    // 会话 id 保留：成员的历史仍然有效，下一轮可以续接。
  }

  if (swept > 0) touch();
  return swept;
}

export function getRoom(roomId) {
  return getState().rooms.find((room) => room.id === roomId) ?? null;
}

export function listRooms() {
  const snapshot = getState();
  return snapshot.order
    .map((id) => snapshot.rooms.find((room) => room.id === id))
    .filter(Boolean);
}

export function appendMessage(roomId, message) {
  const room = getRoom(roomId);
  if (!room) throw new Error(`房间不存在：${roomId}`);
  room.messages.push(message);
  touch();
  return message;
}

export function patchMessage(roomId, messageId, patch) {
  const room = getRoom(roomId);
  if (!room) return null;
  const message = room.messages.find((item) => item.id === messageId);
  if (!message) return null;
  Object.assign(message, patch);
  touch();
  return message;
}

/** 取某成员在某房间的 DSH 会话 id，用于多轮续接。 */
export function getSession(roomId, agentId) {
  return getRoom(roomId)?.sessions?.[agentId] ?? null;
}

export function setSession(roomId, agentId, sessionId) {
  const room = getRoom(roomId);
  if (!room) return;
  room.sessions ??= {};
  room.sessions[agentId] = sessionId;
  touch();
}

/**
 * 判断某成员的 profile 配置是否变化过；变化了就让它在所有房间里重新开始会话。
 *
 * 为什么需要：成员的 system prompt 在会话首次创建时就固化进历史了。之后我们
 * 改了人格或"运行环境事实"（比如权限模式），**已存在的会话不会自动更新**——
 * 它会带着旧提示继续回答，于是出现"配置改了它却仍按旧前提说话"这种怪象。
 *
 * @param {string} agentId
 * @param {string} signature 当前 profile 内容的指纹
 * @returns {boolean} 是否发生了变更（true 表示已清空该成员的会话）
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
      cleared += 1;
    }
  }
  snapshot.profileSignatures[agentId] = signature;
  touch();
  return cleared > 0 || previous === undefined ? cleared > 0 : true;
}

/**
 * 清空某成员在**所有房间**里的会话，让它下次开工时从零开始。
 *
 * 为什么需要：DSH 成员是靠 session 续接多轮的，历史越滚越长，每轮都要把旧上下文
 * 重新送进模型 —— 这是"用久了 token 消耗变大"的另一半原因（另一半是存储体量，
 * 由 retention.mjs 处理）。清掉会话等价于让它重新读一遍当前人格与运行环境。
 *
 * 代价：它不记得之前聊过什么。所以这是个手动动作，不做成自动触发。
 *
 * @param {string} agentId
 * @returns {number} 被清掉的会话数
 */
export function resetAgentSessions(agentId) {
  const snapshot = getState();
  let cleared = 0;
  for (const room of snapshot.rooms) {
    if (room.sessions && Object.hasOwn(room.sessions, agentId)) {
      delete room.sessions[agentId];
      cleared += 1;
    }
  }
  if (cleared > 0) touch();
  return cleared;
}

export function createRoom({ title, members, kind = "group" }) {
  const snapshot = getState();
  const room = {
    id: `room-${randomUUID().slice(0, 8)}`,
    kind,
    title: title?.trim() || "新频道",
    members: members.filter((id) => agents().some((agent) => agent.id === id)),
    createdAt: new Date().toISOString(),
    messages: [],
    sessions: {},
  };
  if (room.members.length === 0) room.members = [agents()[0].id];
  snapshot.rooms.push(room);
  snapshot.order.push(room.id);
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
  touch();
  return true;
}

/** 进程退出前强制落盘。 */
export function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

export { STORE_PATH };
