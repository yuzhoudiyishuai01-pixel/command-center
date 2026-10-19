/**
 * 成员全流程端到端测试。
 *
 * 覆盖：新建 API 成员 → 出现在成员列表 → 拉进群聊 → 派活（预期因假密钥而明确失败，
 * 但必须**走通链路的每一环**并给出可读报错）→ 移出频道 → 删除成员 → 清理干净。
 *
 * 为什么用假密钥：这条测试验证的是"链路通不通、失败是否可读"，不是真的调用模型。
 * 真调用会花钱且依赖外部网络，不适合做成每次都能跑的回归测试。
 *
 * 用法：node scripts/test-member-flow.mjs
 */
const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";
// 服务默认启用共享 token 鉴权；测试可传 CC_TOKEN（或从 data/.token 读）。
import { readFileSync as readTokenFile } from "node:fs";
const TOKEN =
  process.env.CC_TOKEN ??
  (() => {
    try {
      return readTokenFile(new URL("../data/.token", import.meta.url), "utf8").trim();
    } catch {
      return "";
    }
  })();
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

const log = (icon, text) => console.log(`  ${icon} ${text}`);
const fail = (message) => {
  console.error(`\n✗ 失败：${message}\n`);
  process.exit(1);
};

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json", ...AUTH },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

console.log(`\n成员全流程测试 · ${BASE}\n`);

// ── -1. 先清理上次失败留下的测试成员 ───────────────────────────────────────
// 测试中途失败时走不到末尾的清理步骤，残留会污染下一次的"成员数"断言。
{
  const state = await api("/api/state");
  const leftovers = (state.body.agents ?? []).filter(
    (agent) => agent.name?.startsWith("测试员"),
  );
  for (const leftover of leftovers) {
    await api(`/api/members/${encodeURIComponent(leftover.id)}`, { method: "DELETE" });
    log("·", `已清理上次残留：${leftover.name}`);
  }
}

// ── 0. 前置检查 ─────────────────────────────────────────────────────────────
const initial = await api("/api/state");
if (!initial.ok) fail(`服务不可达：HTTP ${initial.status}`);
log("✓", `服务可达：${initial.body.agents.length} 位成员，${initial.body.backendKinds.length} 种接入方式`);

const beforeMembers = initial.body.agents.length;

// ── 1. 新建一个 API 成员 ────────────────────────────────────────────────────
const stamp = Date.now().toString(36).slice(-5);
const created = await api("/api/members", {
  method: "POST",
  body: JSON.stringify({
    name: `测试员${stamp}`,
    role: "端到端测试",
    backend: "openai-api",
    baseUrl: "http://127.0.0.1:9/v1", // 故意不可达，用来验证失败路径
    model: "test-model",
    apiKey: "sk-fake-for-test",
    persona: "你是端到端测试成员，只回一句话。",
  }),
});

if (!created.ok) fail(`创建成员失败：${created.body.error}`);
const memberId = created.body.member.id;
log("✓", `成员已创建：${created.body.member.name}（id=${memberId}）`);

// 校验：成员数 +1
const afterCreate = await api("/api/state");
if (afterCreate.body.agents.length !== beforeMembers + 1) {
  fail(`成员数不对：期望 ${beforeMembers + 1}，实际 ${afterCreate.body.agents.length}`);
}
log("✓", `成员列表已更新（${afterCreate.body.agents.length} 位）`);

// 校验：密钥没有泄漏到成员公开信息里
const createdPublic = afterCreate.body.agents.find((a) => a.id === memberId);
if (!createdPublic) fail("新成员没有出现在列表里");
if (JSON.stringify(createdPublic).includes("sk-fake-for-test")) fail("密钥泄漏到了成员公开信息里");
if (createdPublic.hasApiKey !== true) fail("hasApiKey 应为 true");
log("✓", "密钥未泄漏，hasApiKey=true");

// ── 2. 拉进群聊 ────────────────────────────────────────────────────────────
const rooms = await api("/api/state");
const groupRoom = rooms.body.rooms.find((room) => room.kind === "group");
if (!groupRoom) fail("没有找到群聊频道");

const added = await api(`/api/rooms/${groupRoom.id}/members`, {
  method: "POST",
  body: JSON.stringify({ members: [memberId] }),
});
if (!added.ok) fail(`拉入频道失败：${added.body.error}`);
if (!added.body.room.members.includes(memberId)) fail("拉入后成员不在频道名单里");
log("✓", `已拉入频道「${added.body.room.title}」（现 ${added.body.room.members.length} 位）`);

// ── 3. 派活给这位成员（预期失败，但失败要可读）──────────────────────────────
const target = `dm-${memberId}`;
const dmCreated = await api("/api/rooms", {
  method: "POST",
  body: JSON.stringify({ title: createdPublic.name, members: [memberId] }),
});
if (!dmCreated.ok) fail(`创建私人频道失败：${dmCreated.body.error}`);
const dmId = dmCreated.body.room.id;
log("✓", `私人频道已建：${dmId}`);

const events = [];
const controller = new AbortController();
const stream = (async () => {
  const response = await fetch(`${BASE}/api/rooms/${dmId}/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* 心跳 */
        }
      }
    }
  } catch {
    /* 主动中止 */
  }
})();

await new Promise((r) => setTimeout(r, 400));

const dispatched = await api(`/api/rooms/${dmId}/messages`, {
  method: "POST",
  body: JSON.stringify({ text: "回一句话证明你在线" }),
});
if (!dispatched.ok) fail(`派发失败：${dispatched.body.error}`);
log("✓", "指令已受理");

const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !events.some((e) => e.type === "agent_end")) {
  await new Promise((r) => setTimeout(r, 400));
}
controller.abort();
await stream.catch(() => {});

const end = events.find((e) => e.type === "agent_end");
if (!end) fail("等待超时：成员没有收工");
const errorEvent = events.find((e) => e.type === "error");
if (end.status !== "failed") {
  fail(`预期失败（端点不可达），实际状态为 ${end.status}`);
}
if (!errorEvent?.message) fail("失败了却没有可读的错误信息");
log("✓", `失败路径可读：${String(errorEvent.message).replace(/\s+/g, " ").slice(0, 110)}`);

// ── 4. 移出频道 + 删除成员 ──────────────────────────────────────────────────
const removedFromRoom = await api(`/api/rooms/${groupRoom.id}/members/${memberId}`, { method: "DELETE" });
if (!removedFromRoom.ok) fail(`移出频道失败：${removedFromRoom.body.error}`);
if (removedFromRoom.body.room.members.includes(memberId)) fail("移出后成员仍在名单里");
log("✓", "已移出群聊频道");

const deleted = await api(`/api/members/${memberId}`, { method: "DELETE" });
if (!deleted.ok) fail(`删除成员失败：${deleted.body.error}`);
log("✓", "成员已删除");

// 校验：成员数回到初始值，且没有残留
const final = await api("/api/state");
if (final.body.agents.length !== beforeMembers) {
  fail(`删除后成员数不对：期望 ${beforeMembers}，实际 ${final.body.agents.length}`);
}
if (final.body.agents.some((a) => a.id === memberId)) fail("删除后成员仍在列表里");
log("✓", `成员数已恢复（${final.body.agents.length} 位）`);

// ── 5. 校验种子成员可删（开源版：成员完全归用户所有）────────────────────────
// 不真的删用户的成员：只验证 HTTP 语义——删一个不存在的成员应返回 400。
const missingDelete = await api("/api/members/definitely-not-a-member", { method: "DELETE" });
if (missingDelete.ok) fail("删除不存在的成员竟然成功了");
log("✓", "删除不存在的成员被正确拒绝（任何成员都可删除，不再有内置特权）");

// 清理测试产生的私人频道
await api(`/api/rooms/${dmId}`, { method: "DELETE" }).catch(() => {});

console.log("\n✓ 全流程通过：新建 → 拉群 → 派活 → 失败可读 → 移出 → 删除 → 删除语义\n");
