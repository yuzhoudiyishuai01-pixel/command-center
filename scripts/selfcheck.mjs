#!/usr/bin/env node
/**
 * 指挥室自带的自检脚本。
 *
 * 作用：验证"下达指令 → 成员真实动手 → 产出落地 → 事件流可观测"这条完整链路。
 * 它会真的让成员在工作区里创建文件，然后用文件内容证明任务确实完成了。
 *
 * 用法：
 *   node scripts/selfcheck.mjs              默认检查 DeepSeek 成员
 *   node scripts/selfcheck.mjs claude       指定成员
 *   node scripts/selfcheck.mjs --base http://127.0.0.1:8787
 */
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const BASE = baseIndex !== -1 ? args[baseIndex + 1] : `http://${config.host}:${config.port}`;
const agentId = args.find((arg) => !arg.startsWith("--") && arg !== BASE) ?? "deepseek";

const PROBE_NAME = `selfcheck-${agentId}-${Date.now()}.txt`;
const PROBE_PATH = resolve(config.workspace, PROBE_NAME);
const PROBE_CONTENT = `selfcheck-${Math.random().toString(36).slice(2, 10)}`;

const log = (icon, text) => console.log(`  ${icon} ${text}`);

function fail(message) {
  console.error(`\n✗ 自检失败：${message}\n`);
  process.exit(1);
}

async function main() {
  console.log(`\n指挥室自检 · 成员=${agentId} · 服务=${BASE}\n`);

  // 1) 服务可达
  let snapshot;
  try {
    const response = await fetch(`${BASE}/api/state`);
    if (!response.ok) fail(`/api/state 返回 ${response.status}`);
    snapshot = await response.json();
  } catch (error) {
    fail(`无法连接服务（${error.message}）。请先运行 node server/index.mjs`);
  }
  log("✓", `服务可达：${snapshot.agents.length} 位成员 / ${snapshot.rooms.length} 个频道`);

  const room = snapshot.rooms.find((item) => item.id === `dm-${agentId}`);
  if (!room) fail(`没有找到 ${agentId} 的私人频道`);
  log("✓", `目标频道：${room.title}（${room.id}）`);

  // 2) 订阅事件流
  const events = [];
  const controller = new AbortController();
  const streamDone = (async () => {
    const response = await fetch(`${BASE}/api/rooms/${room.id}/events`, {
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
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          try {
            events.push(JSON.parse(dataLine.slice(6)));
          } catch {
            /* 忽略心跳等非 JSON 帧 */
          }
        }
      }
    } catch {
      /* 主动中止 */
    }
  })();

  await new Promise((r) => setTimeout(r, 300));

  // 3) 下达一条可验证的指令
  const instruction = `请在工作区创建一个文件 ${PROBE_NAME}，内容严格为 ${PROBE_CONTENT}（不要加引号、不要换行、不要任何多余字符），然后回读确认。`;
  log("→", `下达指令：创建 ${PROBE_NAME}`);

  const postResponse = await fetch(`${BASE}/api/rooms/${room.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: instruction }),
  });
  if (postResponse.status !== 202) {
    const body = await postResponse.text();
    fail(`派发被拒绝（${postResponse.status}）：${body}`);
  }
  log("✓", "指令已受理，成员开始作业");

  // 4) 等待成员收工
  const deadline = Date.now() + 10 * 60 * 1000;
  let ended = false;
  while (Date.now() < deadline && !ended) {
    await new Promise((r) => setTimeout(r, 700));
    ended = events.some((event) => event.type === "agent_end");
  }
  controller.abort();
  await streamDone.catch(() => {});

  // 5) 报告事件流
  const counts = events.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {});
  log("✓", `收到 ${events.length} 个事件：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(" ")}`);

  const toolCalls = events.filter((event) => event.type === "tool_call");
  for (const call of toolCalls.slice(0, 8)) {
    log("·", `工具 ${call.tool}：${call.detail ?? ""}`);
  }

  const end = events.find((event) => event.type === "agent_end");
  if (!end) fail("等待超时：成员没有在 10 分钟内收工");
  log(end.status === "done" ? "✓" : "✗", `成员收工状态：${end.status}（${end.durationMs}ms）`);

  const finalEvent = events.find((event) => event.type === "final");
  if (finalEvent?.text) {
    console.log("\n  ── 成员最终回复 ──");
    console.log(
      finalEvent.text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }

  if (end.status !== "done") fail(`成员以状态 ${end.status} 结束`);

  // 6) 用文件内容作为"真的干了活"的证据
  let actual;
  try {
    actual = await readFile(PROBE_PATH, "utf8");
  } catch (error) {
    fail(`成员声称完成，但文件不存在：${PROBE_PATH}（${error.message}）`);
  }

  const normalized = actual.replace(/\r\n/g, "\n").trim();
  if (normalized !== PROBE_CONTENT) {
    fail(`文件内容不符。期望 "${PROBE_CONTENT}"，实际 "${normalized}"`);
  }
  log("✓", `产出已核验：${PROBE_NAME} 内容与指令完全一致`);

  await rm(PROBE_PATH, { force: true });
  log("✓", "已清理探针文件");

  console.log("\n✓ 自检通过：指令 → 真实动手 → 产出落地 → 事件可观测，全链路正常。\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
