#!/usr/bin/env node
/**
 * 给某位成员补一条"环境状态更正"，然后打印它的回复。
 *
 * 用途：成员的会话上下文里可能留着基于旧环境得出的自评（例如沙箱受限期间
 * 它判定自己"半残"）。环境修复后它无从得知，会继续按旧前提回答。这里把变更
 * 事实直接送进它的会话，让它自我更正。
 *
 * 用法：node scripts/tell-agent.mjs <agentId> "<要传达的内容>"
 */
const agentId = process.argv[2] ?? "claude";
const text = process.argv[3];
if (!text) {
  console.error('用法: node scripts/tell-agent.mjs <agentId> "<内容>"');
  process.exit(2);
}

const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";
const roomId = `dm-${agentId}`;

const events = [];
const controller = new AbortController();

const stream = (async () => {
  const response = await fetch(`${BASE}/api/rooms/${roomId}/events`, {
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

const post = await fetch(`${BASE}/api/rooms/${roomId}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
console.log(`派发 → HTTP ${post.status}`);

const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 600));
  if (events.some((e) => e.type === "agent_end")) break;
}
controller.abort();
await stream.catch(() => {});

const final = events.find((e) => e.type === "final");
const end = events.find((e) => e.type === "agent_end");
console.log(`状态: ${end?.status ?? "未知"}  耗时: ${end?.durationMs ?? "?"}ms`);
console.log("\n───── 成员回复 ─────\n");
console.log(final?.text ?? "（没有 final 事件）");
