// Remove test turns that were created by automated UI probes (measure-flicker /
// screenshot --eval) from a room, so the operator's chat doesn't fill up with junk.
//
// The store is a single JSON file written by the server, so this must run while
// the server is STOPPED — otherwise the next save overwrites the cleanup.
//
// Usage:
//   node scripts/prune-test-turns.mjs --dry            # show what would go
//   node scripts/prune-test-turns.mjs --apply          # rewrite store.json
//   node scripts/prune-test-turns.mjs --dry --room room-xxxx --match "关键词"
const fs = await import("node:fs");
const path = await import("node:path");
const url = await import("node:url");

const here = path.dirname(url.fileURLToPath(import.meta.url));
const storePath = path.join(here, "..", "data", "store.json");

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

// 自动化探针用过的固定话术。用**整句精确匹配**，不做子串匹配——
// 用户自己也发过「只回复两个字：在吗」这类真实指令，子串匹配会误删。
const PROBE_TEXTS = [
  "@DeepSeek 只回复两个字：收到。不要调用任何工具。",
  "@DeepSeek 用一句话解释什么是 TCP 三次握手，不要调用任何工具。",
  "@DeepSeek 用一句话解释什么是 TCP 三次握手，不要调用工具。",
];
const MATCHERS = PROBE_TEXTS;

const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
const onlyRoom = flag("room", "");

let removedTurns = 0;
let removedMessages = 0;
const report = [];

for (const room of store.rooms ?? []) {
  if (onlyRoom && room.id !== onlyRoom) continue;
  const before = room.messages?.length ?? 0;
  let dropped = 0;
  room.messages = (room.messages ?? []).filter((message) => {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const isProbe = MATCHERS.includes(text);
    if (isProbe) dropped += 1;
    return !isProbe;
  });
  if (dropped > 0) {
    removedTurns += dropped;
    removedMessages += dropped;
    report.push({ room: room.id, name: room.name, removed: dropped, left: room.messages.length, before });
  }
}

console.table(report);
console.log(
  JSON.stringify({ store: storePath, removedTurns, matchers: MATCHERS, applied: has("apply") }),
);

if (has("apply")) {
  if (removedTurns === 0) {
    console.log("nothing to do");
  } else {
    const backup = `${storePath}.bak-${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}`;
    fs.copyFileSync(storePath, backup);
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, storePath);
    console.log(`backup: ${backup}`);
    console.log(`rewrote ${storePath} (${fs.statSync(storePath).size} bytes)`);
  }
} else {
  console.log("dry run — pass --apply to rewrite");
}
