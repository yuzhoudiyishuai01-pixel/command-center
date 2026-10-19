/**
 * 分房间持久化（snapshot + WAL）。
 *
 * 老版本把整个 store 写进一个 JSON：每来一条消息就要把全部房间重新序列化一遍，
 * 数据越多写得越慢，进程被杀还可能丢掉最后几次改动。这里换成两层：
 *
 *   data/meta.json                    房间目录（顺序、标题、成员、会话签名）
 *   data/rooms/<id>.snapshot.json     该房间的完整快照（定期/维护时写）
 *   data/rooms/<id>.journal.jsonl     追加写日志：每条消息/每次改动一行
 *
 * 读：snapshot 之后重放 journal。写：只 append 一行（O(改动量)），不再全量重写。
 * 重放是幂等的：同一条消息重复出现按 id 覆盖，patch 重复应用结果相同，所以
 * "快照写完但 journal 还没来得及清空就被杀"也不会丢数据。
 *
 * 首次启动如果发现旧的 data/store.json，会自动迁移并改名留档。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const STORE_VERSION = 2;
/** journal 超过这个大小就在下一次维护时压成 snapshot。 */
const JOURNAL_COMPACT_BYTES = 512 * 1024;

/**
 * @param {string} dataDir
 */
export function createStorage(dataDir) {
  const metaPath = resolve(dataDir, "meta.json");
  const roomsDir = resolve(dataDir, "rooms");
  const legacyPath = resolve(dataDir, "store.json");

  function ensureDirs() {
    mkdirSync(roomsDir, { recursive: true });
  }

  function roomPaths(roomId) {
    return {
      snapshot: resolve(roomsDir, `${roomId}.snapshot.json`),
      journal: resolve(roomsDir, `${roomId}.journal.jsonl`),
    };
  }

  function atomicWrite(path, content) {
    ensureDirs();
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  /** 重放一行 journal 到 room（幂等）。 */
  function applyOp(room, op) {
    switch (op.op) {
      case "msg": {
        if (!op.message?.id) return;
        const index = room.messages.findIndex((message) => message.id === op.message.id);
        if (index >= 0) room.messages[index] = op.message;
        else room.messages.push(op.message);
        break;
      }
      case "patch": {
        const message = room.messages.find((item) => item.id === op.id);
        if (message) Object.assign(message, op.patch ?? {});
        break;
      }
      case "messages": {
        // 维护（归档/降级）后的整组消息替换
        if (Array.isArray(op.messages)) room.messages = op.messages;
        break;
      }
      case "session": {
        room.sessions ??= {};
        if (op.sessionId) room.sessions[op.agentId] = op.sessionId;
        else delete room.sessions[op.agentId];
        break;
      }
      default:
        break;
    }
  }

  function readRoom(meta) {
    const paths = roomPaths(meta.id);
    const room = { ...meta, messages: [], sessions: {} };
    if (existsSync(paths.snapshot)) {
      try {
        const parsed = JSON.parse(readFileSync(paths.snapshot, "utf8"));
        room.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        room.sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
      } catch (error) {
        // 快照坏了但 journal 可能还在：备份后从 journal 重建。
        const broken = `${paths.snapshot}.broken-${Date.now()}`;
        try {
          renameSync(paths.snapshot, broken);
          console.error(`[storage] ${meta.id} 快照损坏，已备份到 ${broken}：${error.message}`);
        } catch {
          console.error(`[storage] ${meta.id} 快照损坏：${error.message}`);
        }
      }
    }
    if (existsSync(paths.journal)) {
      const text = readFileSync(paths.journal, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          applyOp(room, JSON.parse(line));
        } catch {
          /* 半行（进程被杀时最后一行可能不完整）：跳过即可 */
        }
      }
    }
    return room;
  }

  /** 把房间列表写成 meta.json（只含元信息，不含消息）。 */
  function writeMetaObject({ order, rooms, profileSignatures }) {
    const meta = {
      version: STORE_VERSION,
      order,
      rooms: {},
      profileSignatures: profileSignatures ?? {},
    };
    for (const room of rooms) {
      meta.rooms[room.id] = {
        id: room.id,
        kind: room.kind,
        title: room.title,
        members: room.members,
        createdAt: room.createdAt,
      };
    }
    atomicWrite(metaPath, JSON.stringify(meta, null, 2));
  }

  /**
   * 加载全部房间。全新安装时把默认布局落盘；有旧版 store.json 时先迁移。
   *
   * @returns {{version:number, order:string[], rooms:object[], profileSignatures:object, migratedFrom:string|null}}
   */
  function load(defaults) {
    ensureDirs();

    if (!existsSync(metaPath) && !existsSync(legacyPath)) {
      // 全新安装：立即把默认布局落盘，否则下一次重启读不到房间归属
      // （journal 已经在写，但没有 meta 就不知道它属于哪个房间）。
      writeMetaObject(defaults);
      return defaults;
    }

    if (!existsSync(metaPath) && existsSync(legacyPath)) {
      return migrateLegacy(defaults);
    }
    if (!existsSync(metaPath) && existsSync(legacyPath)) {
      return migrateLegacy(defaults);
    }

    let meta = { version: STORE_VERSION, order: [], rooms: {}, profileSignatures: {} };
    if (existsSync(metaPath)) {
      try {
        meta = { ...meta, ...JSON.parse(readFileSync(metaPath, "utf8")) };
      } catch (error) {
        const broken = `${metaPath}.broken-${Date.now()}`;
        try {
          renameSync(metaPath, broken);
        } catch {
          /* ignore */
        }
        console.error(`[storage] meta.json 损坏，已备份：${error.message}`);
      }
    }

    const rooms = [];
    for (const roomId of meta.order ?? []) {
      const roomMeta = meta.rooms?.[roomId];
      if (!roomMeta) continue;
      rooms.push(readRoom({ ...roomMeta, id: roomId }));
    }
    return {
      version: STORE_VERSION,
      order: meta.order ?? [],
      rooms,
      profileSignatures: meta.profileSignatures ?? {},
      migratedFrom: null,
    };
  }

  /** 旧版单文件 store.json → 新布局。保留原文件为 .migrated-<时间戳>。 */
  function migrateLegacy(defaults) {
    console.log("  ▸ 存储迁移  发现旧版 data/store.json，正在迁移到分房间存储…");
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
    const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
    const order = Array.isArray(parsed.order) && parsed.order.length > 0 ? parsed.order : rooms.map((r) => r.id);

    const meta = {
      version: STORE_VERSION,
      order,
      rooms: {},
      profileSignatures: parsed.profileSignatures ?? {},
    };
    for (const room of rooms) {
      meta.rooms[room.id] = {
        id: room.id,
        kind: room.kind,
        title: room.title,
        members: room.members,
        createdAt: room.createdAt,
      };
      writeSnapshot(room);
    }
    atomicWrite(metaPath, JSON.stringify(meta, null, 2));

    const backup = resolve(resolve(legacyPath, ".."), `store.json.migrated-${Date.now()}`);
    try {
      renameSync(legacyPath, backup);
      console.log(`  ▸ 存储迁移  完成，旧档保留为 ${backup}`);
    } catch (error) {
      console.error(`  ▸ 存储迁移  旧档改名失败（不影响使用）：${error.message}`);
    }

    if (rooms.length === 0) return { ...defaults, version: STORE_VERSION, migratedFrom: null };
    return {
      version: STORE_VERSION,
      order,
      rooms: order.map((id) => readRoom({ ...meta.rooms[id] })),
      profileSignatures: meta.profileSignatures,
      migratedFrom: backup,
    };
  }

  // ── 写 ────────────────────────────────────────────────────────────────────

  function appendOp(roomId, op) {
    ensureDirs();
    const { journal } = roomPaths(roomId);
    appendFileSync(journal, `${JSON.stringify(op)}\n`, "utf8");
  }

  function writeSnapshot(room) {
    const { snapshot } = roomPaths(room.id);
    atomicWrite(snapshot, JSON.stringify({ version: STORE_VERSION, id: room.id, messages: room.messages, sessions: room.sessions ?? {} }));
  }

  function truncateJournal(roomId) {
    const { journal } = roomPaths(roomId);
    try {
      writeFileSync(journal, "", "utf8");
    } catch {
      /* 截断失败不算致命：下次压缩会重写快照，重复的 op 是幂等的 */
    }
  }

  return {
    metaPath,
    roomsDir,
    paths: roomPaths,

    load,

    /** 保存房间目录（标题/成员/顺序有变化时调用）。 */
    saveMeta(meta) {
      atomicWrite(metaPath, JSON.stringify(meta, null, 2));
    },

    appendMessage(roomId, message) {
      appendOp(roomId, { op: "msg", message });
    },

    patchMessage(roomId, id, patch) {
      appendOp(roomId, { op: "patch", id, patch });
    },

    setSession(roomId, agentId, sessionId) {
      appendOp(roomId, { op: "session", agentId, sessionId: sessionId ?? null });
    },

    /** 维护后整组替换消息（归档降级），同时立刻落快照并清空 journal。 */
    rewriteRoom(room) {
      writeSnapshot(room);
      truncateJournal(room.id);
    },

    /** journal 太大就压成快照。返回是否压缩过。 */
    compactIfNeeded(room) {
      const { journal } = roomPaths(room.id);
      try {
        if (!existsSync(journal)) return false;
        if (statSync(journal).size < JOURNAL_COMPACT_BYTES) return false;
        writeSnapshot(room);
        truncateJournal(room.id);
        return true;
      } catch {
        return false;
      }
    },

    /** 退出前把所有房间压成快照，留下干净状态。 */
    flushAll(rooms) {
      for (const room of rooms) {
        try {
          writeSnapshot(room);
          truncateJournal(room.id);
        } catch (error) {
          console.error(`[storage] 退出前保存 ${room.id} 失败：${error.message}`);
        }
      }
    },

    /** 房间被删除时清掉它的两个文件。 */
    removeRoom(roomId) {
      const paths = roomPaths(roomId);
      rmSync(paths.snapshot, { force: true });
      rmSync(paths.journal, { force: true });
    },

    /** 列出磁盘上已有的房间文件（迁移/排障用）。 */
    listRoomIds() {
      try {
        return readdirSync(roomsDir)
          .filter((name) => name.endsWith(".snapshot.json"))
          .map((name) => name.replace(/\.snapshot\.json$/, ""));
      } catch {
        return [];
      }
    },

    journalSize(roomId) {
      try {
        return statSync(roomPaths(roomId).journal).size;
      } catch {
        return 0;
      }
    },
  };
}
