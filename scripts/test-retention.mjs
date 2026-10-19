#!/usr/bin/env node
/**
 * 体量控制回归测试。
 *
 * 这些策略的作用是"删掉用户看不见的冗余"，一旦写错就会变成"删掉用户的数据"，
 * 所以必须用可复现的合成数据把每个不变量钉死：
 *
 *   1. 超期轮次先归档、再降级——归档文件里必须能读回**完整原始消息**
 *   2. 归档失败时不得降级（宁可变大，不能丢数据）
 *   3. 降级后消息数量不变（界面历史不能断层）
 *   4. 最近轮次保持完整过程，超期轮次只留正文
 *   5. /api/state 窗口传输量必须显著小于全量
 *   6. API 后端历史按字符预算截断
 *   7. 孤儿 tmp 会被清理，但新文件不碰
 *
 * 运行：node scripts/test-retention.mjs
 */
import { mkdtempSync, existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  RETENTION,
  applyRoomRetention,
  archiveMessages,
  pageBefore,
  planRoomRetention,
  pruneOrphanTemps,
  recentWindow,
  roomFootprint,
  stubMessage,
} from "../server/retention.mjs";
import { buildHistory } from "../server/api-backend.mjs";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 造一条消息：正文 + 若干大块，模拟真实成员回话。 */
function makeMessage(id, role, turnId, { textChars = 3000, blockCount = 8, blockChars = 4000 } = {}) {
  return {
    id,
    role,
    agentId: role === "agent" ? "deepseek" : null,
    turnId,
    at: "2026-01-01T00:00:00.000Z",
    status: "done",
    text: "正".repeat(textChars),
    blocks: Array.from({ length: blockCount }, (_, index) => ({
      kind: "tool",
      callId: `c${index}`,
      tool: "pwsh",
      label: "执行命令",
      detail: "命".repeat(blockChars),
      status: "done",
      result: "果".repeat(blockChars),
    })),
  };
}

/** 造一个房间：turnCount 轮，每轮 1 条指令 + 2 条回复。 */
function makeRoom(turnCount) {
  const messages = [];
  for (let turn = 0; turn < turnCount; turn += 1) {
    const turnId = `turn-${turn}`;
    messages.push({
      id: `cmd-${turn}`,
      role: "commander",
      turnId,
      at: "2026-01-01T00:00:00.000Z",
      text: "指令".repeat(50),
      cleaned: "指令".repeat(50),
      blocks: [],
    });
    messages.push(makeMessage(`a-${turn}-1`, "agent", turnId));
    messages.push(makeMessage(`a-${turn}-2`, "agent", turnId));
  }
  return { id: "test-room", kind: "group", title: "测试", members: ["deepseek"], messages };
}

/** 直连读 gzip jsonl，验证归档内容完整。 */
async function readArchive(path) {
  const lines = [];
  const reader = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of reader) if (line.trim()) lines.push(JSON.parse(line));
  return lines;
}

/** 临时目录里的独立测试。 */
async function testArchiveRoundtrip() {
  console.log("\n[1] 归档 → 降级 → 可完整读回");
  const dir = mkdtempSync(join(tmpdir(), "cc-retention-"));
  try {
    const messages = [
      makeMessage("m1", "agent", "t1", { textChars: 500, blockChars: 100 }),
      makeMessage("m2", "agent", "t2", { textChars: 700, blockChars: 200 }),
    ];
    const path = await archiveMessages("room-x", messages, dir);
    check("归档文件已生成", Boolean(path) && existsSync(path));
    const restored = await readArchive(path);
    check("归档行数与消息数一致", restored.length === messages.length, `${restored.length} vs ${messages.length}`);
    check(
      "归档内容与原始逐字节一致",
      JSON.stringify(restored) === JSON.stringify(messages),
      "归档必须是无损快照，否则降级就是在丢数据",
    );
    check("gzip 确实压缩了", statSync(path).size < JSON.stringify(messages).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testPlanBoundaries() {
  console.log("\n[2] 轮次边界");
  const under = makeRoom(RETENTION.keepRecentTurns);
  const underPlan = planRoomRetention(under);
  check("轮次未超限时不降级", underPlan.stub.length === 0, `stub=${underPlan.stub.length}`);

  const over = makeRoom(RETENTION.keepRecentTurns + 5);
  const overPlan = planRoomRetention(over);
  const expectedStub = 5 * 3; // 每轮 1 指令 + 2 回复
  check("超限轮次被降级", overPlan.stub.length === expectedStub, `${overPlan.stub.length} vs ${expectedStub}`);
  check("保留 + 降级 = 全量", overPlan.keep.length + overPlan.stub.length === over.messages.length);
  check("降级的是最早的轮次", overPlan.stub[0].turnId === "turn-0");
  check(
    "保留的是最新的轮次",
    overPlan.keep[overPlan.keep.length - 1].turnId === `turn-${RETENTION.keepRecentTurns + 4}`,
  );
}

async function testApplyRetention() {
  console.log("\n[3] 执行保留策略");
  const dir = mkdtempSync(join(tmpdir(), "cc-retention-"));
  const room = makeRoom(RETENTION.keepRecentTurns + 4);
  const before = roomFootprint(room.messages);
  try {
    const result = await applyRoomRetention(room, { archiveDir: dir });
    const after = roomFootprint(room.messages);

    check("报告标记已变更", result.changed === true);
    check("真的写出了归档文件", readdirSync(dir).length === 1);
    check("消息条数不变（界面历史不断层）", after.messages === before.messages, `${after.messages} vs ${before.messages}`);
    check("内容体积显著下降", after.chars < before.chars * 0.75, `${before.chars} → ${after.chars}`);
    check(
      "超期消息只剩正文（无 blocks）",
      room.messages.find((m) => m.id === "a-0-1").blocks === undefined,
    );
    check(
      "超期消息正文被截到 stubHeadChars 附近",
      room.messages.find((m) => m.id === "a-0-1").text.length <= RETENTION.stubHeadChars + 80,
    );
    check("超期消息带 stubbed 标记", room.messages.find((m) => m.id === "a-0-1").stubbed === true);

    const recent = room.messages.find((m) => m.id === `a-${RETENTION.keepRecentTurns + 3}-1`);
    check("最近轮次仍有 blocks", Array.isArray(recent.blocks) && recent.blocks.length > 0);
    check(
      "最近轮次的块已被截断到上限",
      recent.blocks.every((b) => (b.detail ?? "").length <= RETENTION.maxBlockChars + 80),
    );

    // 归档里必须能读回被降级的那些消息的完整原文
    const archived = await readArchive(join(dir, readdirSync(dir)[0]));
    const archivedFirst = archived.find((m) => m.id === "a-0-1");
    check("归档保留了完整正文", archivedFirst.text.length === 3000, `${archivedFirst.text.length}`);
    check("归档保留了完整 blocks", archivedFirst.blocks.length === 8);
    check("归档保留了完整块内容", (archivedFirst.blocks[0].result ?? "").length === 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testWindowAndPaging() {
  console.log("\n[4] 传输窗口与分页");
  const room = makeRoom(RETENTION.keepRecentTurns + 10);
  const full = JSON.stringify(room.messages).length;

  const window = recentWindow(room.messages);
  const windowSize = JSON.stringify(window.messages).length;
  check("窗口有更多历史标记", window.hasMore === true);
  check("窗口条数不超过上限", window.messages.length === RETENTION.windowMessages);
  check("窗口显著小于全量", windowSize < full * 0.5, `${windowSize} vs ${full}`);
  check(
    "窗口最早几条已丢 blocks（只留正文）",
    window.messages.slice(0, window.messages.length - RETENTION.detailMessages).every((m) => m.blocks === undefined),
  );
  check(
    "窗口最近几条保留 blocks",
    window.messages.slice(-RETENTION.detailMessages).every((m) => Array.isArray(m.blocks)),
  );

  const firstId = window.messages[0].id;
  const page = pageBefore(room.messages, firstId, 10);
  check("分页返回条数正确", page.messages.length === 10, `${page.messages.length}`);
  check("分页结果在游标之前", page.messages[page.messages.length - 1].id !== firstId);
  check("分页报告还有更早", page.hasMore === true);
  check("分页不带 blocks", page.messages.every((m) => m.blocks === undefined));

  const oldest = pageBefore(room.messages, room.messages[0].id, 10);
  check("游标在最早消息时返回空页", oldest.messages.length === 0);
  check("最早消息时 hasMore=false", oldest.hasMore === false);
}

function testHistoryBudget() {
  console.log("\n[5] API 成员历史字符预算");
  const messages = [];
  for (let turn = 0; turn < 12; turn += 1) {
    messages.push({
      id: `c${turn}`,
      role: "commander",
      turnId: `t${turn}`,
      at: "2026-01-01T00:00:00.000Z",
      text: `问${turn}-` + "述".repeat(3000),
      cleaned: `问${turn}-` + "述".repeat(3000),
    });
    messages.push(makeMessage(`r${turn}`, "agent", `t${turn}`, { textChars: 3000, blockCount: 0 }));
  }

  const history = buildHistory(messages, "deepseek", null);
  const chars = history.reduce((sum, item) => sum + item.content.length, 0);
  check("历史字符数受预算约束", chars <= RETENTION.historyCharBudget + 3200, `${chars} chars`);
  check("历史至少保留最近一轮", history.length >= 2, `${history.length} 条`);
  check("最早的内容先被丢掉", !history.some((item) => item.content.includes("问0-")));
  check("最近一轮在历史里", history.some((item) => item.content.includes("问11-")));

  // 当前轮作为独立用户消息发送，不能在重放历史里重复出现
  const withCurrent = buildHistory(messages, "deepseek", "t11");
  check("当前轮不被重放", !withCurrent.some((item) => item.content.includes("问11-")));
  check("当前轮之前的历史仍在", withCurrent.some((item) => item.content.includes("问10-")));

  // 别人的回答不得进入历史（否则会开始扮演他人）
  messages.push({
    id: "other",
    role: "agent",
    agentId: "claude",
    turnId: "t10",
    at: "2026-01-01T00:00:00.000Z",
    status: "done",
    text: "这是 Claude 的回答".repeat(10),
    blocks: [],
  });
  const withOthers = buildHistory(messages, "deepseek", null);
  check("不重放其他成员的回答", !withOthers.some((item) => item.content.includes("这是 Claude 的回答")));
}

function testStubShape() {
  console.log("\n[6] 降级存根保留会话骨架");
  const message = makeMessage("x", "agent", "t");
  const stub = stubMessage(message);
  for (const key of ["id", "role", "agentId", "turnId", "status", "at", "text"]) {
    check(`存根保留 ${key}`, stub[key] !== undefined || key === "at");
  }
  check("存根不带 blocks", stub.blocks === undefined);
  check("存根标记 stubbed", stub.stubbed === true);
}

function testPruneTemps() {
  console.log("\n[7] 孤儿 tmp 清理");
  const dir = mkdtempSync(join(tmpdir(), "cc-temp-"));
  try {
    const old = join(dir, "store.json.aaa.tmp");
    const fresh = join(dir, "store.json.bbb.tmp");
    const keep = join(dir, "store.json");
    writeFileSync(old, "old");
    writeFileSync(fresh, "fresh");
    writeFileSync(keep, "{}");

    // 把 old 的 mtime 拨回 10 分钟前，模拟崩溃残留
    const past = Date.now() / 1000 - 600;
    utimesSync(old, past, past);

    const removed = pruneOrphanTemps(dir, 60_000);
    const left = readdirSync(dir);
    check("清理了过期 tmp", removed.includes("store.json.aaa.tmp"), removed.join(","));
    check("不动新鲜 tmp（可能正在写）", left.includes("store.json.bbb.tmp"));
    check("不动正式存档", left.includes("store.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testArchiveFailureSafety() {
  console.log("\n[8] 归档失败时不降级（宁可变大，不能丢数据）");
  const blocker = mkdtempSync(join(tmpdir(), "cc-block-"));
  // 用一个「文件」当归档目录，mkdir 必然失败，模拟磁盘/权限故障
  const notADir = join(blocker, "archive");
  writeFileSync(notADir, "not a directory");

  const room = makeRoom(RETENTION.keepRecentTurns + 3);
  const before = JSON.stringify(room.messages);
  try {
    const result = await applyRoomRetention(room, { archiveDir: notADir });
    const after = JSON.stringify(room.messages);
    check("归档失败时不报告 changed", result.changed === false, JSON.stringify(result));
    check("归档失败时不留降级标记", room.messages.every((m) => m.stubbed !== true));
    check("归档失败时消息内容完全未动", after === before);
    check("归档失败时给出错误原因", Boolean(result.error), result.error ?? "");
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
}

async function main() {
  console.log("指挥室 · 体量控制回归测试");
  console.log(
    `参数：保留 ${RETENTION.keepRecentTurns} 轮 / 窗口 ${RETENTION.windowMessages} 条 / 明细 ${RETENTION.detailMessages} 条 / 预算 ${RETENTION.historyCharBudget} 字`,
  );

  await testArchiveRoundtrip();
  testPlanBoundaries();
  await testApplyRetention();
  testWindowAndPaging();
  testHistoryBudget();
  testStubShape();
  testPruneTemps();
  await testArchiveFailureSafety();

  console.log(`\n${failures.length === 0 ? "全部通过" : "有失败项"}：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    for (const item of failures) console.log(`  · ${item}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("测试崩溃：", error);
  process.exit(1);
});
