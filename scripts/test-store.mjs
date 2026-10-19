#!/usr/bin/env node
/**
 * 存储层测试（snapshot + journal）。
 *
 * 这些断言是"长期使用不丢数据"的底线：追加写、幂等重放、压缩、旧档迁移、
 * 删除清理。任何一条挂了都别发布。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorage } from "../server/storage.mjs";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ""}`);
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "cc-store-"));
}

const defaults = {
  version: 2,
  order: ["group"],
  rooms: [
    { id: "group", kind: "group", title: "指挥部", members: ["a"], createdAt: "2026-01-01T00:00:00.000Z", messages: [], sessions: {} },
  ],
  profileSignatures: {},
};

console.log("[1] 追加写 + 重新加载");
{
  const dir = tempDir();
  const store = createStorage(dir);
  const loaded = store.load(defaults);
  check("空目录返回默认房间", loaded.rooms.length === 1 && loaded.rooms[0].id === "group");

  const message = { id: "msg-1", role: "commander", text: "你好", at: "2026-01-01T00:00:01.000Z" };
  store.appendMessage("group", message);
  check("journal 被创建", existsSync(store.paths("group").journal));

  const again = createStorage(dir).load(defaults);
  check("重放后消息在", again.rooms[0].messages.length === 1 && again.rooms[0].messages[0].text === "你好");
  rmSync(dir, { recursive: true, force: true });
}

console.log("[2] patch / session 重放");
{
  const dir = tempDir();
  const store = createStorage(dir);
  store.load(defaults);
  store.appendMessage("group", { id: "msg-2", role: "agent", text: "", status: "working" });
  store.patchMessage("group", "msg-2", { status: "done", text: "完成" });
  store.setSession("group", "claude", "sess-1");
  store.setSession("group", "claude", null);

  const reloaded = createStorage(dir).load(defaults);
  const message = reloaded.rooms[0].messages.find((item) => item.id === "msg-2");
  check("patch 生效", message?.status === "done" && message?.text === "完成");
  check("session 写入后删除生效", reloaded.rooms[0].sessions.claude === undefined);
  rmSync(dir, { recursive: true, force: true });
}

console.log("[3] 幂等重放（同一条消息写两次）");
{
  const dir = tempDir();
  const store = createStorage(dir);
  store.load(defaults);
  const message = { id: "msg-dup", role: "commander", text: "只出现一次" };
  store.appendMessage("group", message);
  store.appendMessage("group", message);
  const reloaded = createStorage(dir).load(defaults);
  const hits = reloaded.rooms[0].messages.filter((item) => item.id === "msg-dup");
  check("重复追加不会产生重复消息", hits.length === 1, `实际 ${hits.length} 条`);
  rmSync(dir, { recursive: true, force: true });
}

console.log("[4] 快照压缩后 journal 清空、数据不变");
{
  const dir = tempDir();
  const store = createStorage(dir);
  const loaded = store.load(defaults);
  const room = loaded.rooms[0];
  for (let index = 0; index < 5; index += 1) {
    const message = { id: `msg-${index}`, role: "commander", text: `第 ${index} 条` };
    room.messages.push(message);
    store.appendMessage("group", message);
  }
  store.rewriteRoom(room);
  check("快照文件存在", existsSync(store.paths("group").snapshot));
  check("journal 已清空", statSync(store.paths("group").journal).size === 0);

  const reloaded = createStorage(dir).load(defaults);
  check("压缩后消息仍然完整", reloaded.rooms[0].messages.length === 5);
  rmSync(dir, { recursive: true, force: true });
}

console.log("[5] 损坏的 journal 半行不影响启动");
{
  const dir = tempDir();
  const store = createStorage(dir);
  store.load(defaults);
  store.appendMessage("group", { id: "msg-ok", role: "commander", text: "完整行" });
  writeFileSync(store.paths("group").journal, `${readFileSync(store.paths("group").journal, "utf8")}{"op":"msg","messa`, "utf8");
  const reloaded = createStorage(dir).load(defaults);
  check("完整行仍然被读取", reloaded.rooms[0].messages.length === 1);
  rmSync(dir, { recursive: true, force: true });
}

console.log("[6] 旧版 store.json 自动迁移");
{
  const dir = tempDir();
  const legacy = {
    version: 1,
    order: ["group", "room-custom"],
    rooms: [
      {
        id: "group",
        kind: "group",
        title: "指挥部",
        members: ["a"],
        createdAt: "2026-01-01T00:00:00.000Z",
        messages: [{ id: "old-1", role: "commander", text: "旧消息" }],
        sessions: { a: "sess-old" },
      },
      {
        id: "room-custom",
        kind: "group",
        title: "自建频道",
        members: ["a"],
        createdAt: "2026-01-02T00:00:00.000Z",
        messages: [],
        sessions: {},
      },
    ],
    profileSignatures: { a: "sig" },
  };
  writeFileSync(join(dir, "store.json"), JSON.stringify(legacy), "utf8");
  const store = createStorage(dir);
  const loaded = store.load(defaults);

  check("迁移后房间数正确", loaded.rooms.length === 2, `实际 ${loaded.rooms.length}`);
  check("旧消息保留", loaded.rooms[0].messages[0]?.text === "旧消息");
  check("会话保留", loaded.rooms[0].sessions.a === "sess-old");
  check("profile 签名保留", loaded.profileSignatures.a === "sig");
  check("旧文件被改名留档", !existsSync(join(dir, "store.json")));
  check("生成了 meta.json", existsSync(join(dir, "meta.json")));
  rmSync(dir, { recursive: true, force: true });
}

console.log("[7] 删除房间清理文件");
{
  const dir = tempDir();
  const store = createStorage(dir);
  const loaded = store.load(defaults);
  store.rewriteRoom({ id: "room-x", messages: [], sessions: {} });
  loaded.rooms.push({ id: "room-x", messages: [], sessions: {}, members: ["a"] });
  check("文件已生成", existsSync(store.paths("room-x").snapshot));
  store.removeRoom("room-x");
  check("快照被删除", !existsSync(store.paths("room-x").snapshot));
  check("journal 被删除", !existsSync(store.paths("room-x").journal));
  rmSync(dir, { recursive: true, force: true });
}

console.log("[8] 写放大：新增一条消息只追加，不改写快照");
{
  const dir = tempDir();
  const store = createStorage(dir);
  const loaded = store.load(defaults);
  const room = loaded.rooms[0];
  for (let index = 0; index < 50; index += 1) {
    const message = { id: `bulk-${index}`, role: "commander", text: "x".repeat(200) };
    room.messages.push(message);
    store.appendMessage("group", message);
  }
  store.rewriteRoom(room);
  const snapshotBefore = statSync(store.paths("group").snapshot).size;
  store.appendMessage("group", { id: "one-more", role: "commander", text: "y" });
  const snapshotAfter = statSync(store.paths("group").snapshot).size;
  const journalAfter = statSync(store.paths("group").journal).size;
  check("快照未被重写", snapshotBefore === snapshotAfter, `${snapshotBefore} → ${snapshotAfter}`);
  check("只追加了一行 journal", journalAfter > 0 && journalAfter < 400, `${journalAfter} bytes`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
