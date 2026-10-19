#!/usr/bin/env node
/**
 * 事件通道探针：订阅一个频道的事件流，派发一条指令，把收到的每一帧原样打印。
 *
 * 用于确认"服务端产生的事件是否真的送达了客户端"。典型用途是排查
 * 成员干完了活、但界面一直显示"作业中"这类问题。
 *
 * 用法：node scripts/probe-events.mjs [房间id] [指令]
 */
const roomId = process.argv[2] ?? "dm-deepseek";
const text = process.argv[3] ?? "只回复两个字：收到";
const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";

const started = Date.now();
const stamp = () => `[+${String(Date.now() - started).padStart(6)}ms]`;

console.log(`\n事件通道探针 · 房间=${roomId}\n`);

const controller = new AbortController();
let frames = 0;
let sawEnd = false;

const readerDone = (async () => {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(roomId)}/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  console.log(`${stamp()} 已订阅，HTTP ${response.status} content-type=${response.headers.get("content-type")}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`${stamp()} 流被服务端关闭`);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!frame.trim()) continue;
        if (frame.startsWith(":")) {
          console.log(`${stamp()} 心跳`);
          continue;
        }
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        frames += 1;
        let parsed;
        try {
          parsed = JSON.parse(dataLine.slice(6));
        } catch {
          console.log(`${stamp()} 无法解析：${dataLine.slice(0, 120)}`);
          continue;
        }
        const summary =
          parsed.type === "tool_call"
            ? `${parsed.label} ${parsed.detail ?? ""}`
            : parsed.type === "text" || parsed.type === "thinking"
              ? String(parsed.text ?? "").slice(0, 60).replace(/\n/g, " ")
              : JSON.stringify(parsed).slice(0, 140);
        console.log(`${stamp()} #${frames} ${parsed.type}  ${summary}`);
        if (parsed.type === "agent_end") sawEnd = true;
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") console.log(`${stamp()} 读取失败：${error.message}`);
  }
})();

await new Promise((r) => setTimeout(r, 900));

console.log(`${stamp()} 派发指令：${text}`);
const post = await fetch(`${BASE}/api/rooms/${encodeURIComponent(roomId)}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
console.log(`${stamp()} POST 返回 HTTP ${post.status}`);

// 最多观察 4 分钟，或直到收到 agent_end 后再多等 3 秒。
const deadline = Date.now() + 240_000;
let endSeenAt = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300));
  if (sawEnd && endSeenAt === null) endSeenAt = Date.now();
  if (endSeenAt !== null && Date.now() - endSeenAt > 3000) break;
}

controller.abort();
await readerDone.catch(() => {});

console.log(`\n共收到 ${frames} 帧；agent_end ${sawEnd ? "已收到 ✓" : "未收到 ✗"}\n`);
process.exit(sawEnd ? 0 : 1);
