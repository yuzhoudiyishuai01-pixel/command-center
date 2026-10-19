#!/usr/bin/env node
/**
 * 端到端测试：鉴权、状态接口、搜索、统计、SSE 握手续传。
 *
 * 会真的起一个独立实例（独立端口 + 临时数据目录），不碰你正在用的服务。
 * 沙箱限制：子进程必须用 stdio: "ignore" 或 "inherit"，不能走管道。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8799 + Math.floor(Math.random() * 60);
const TOKEN = "test-token-0123456789";
const dataDir = mkdtempSync(join(tmpdir(), "cc-e2e-"));
const dshHome = mkdtempSync(join(tmpdir(), "cc-dsh-"));

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

function waitForPort(host, port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const attempt = () => {
      const socket = connect({ host, port }, () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolvePromise(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [resolve(ROOT, "server", "index.mjs")], {
  cwd: ROOT,
  stdio: "ignore",
  env: {
    ...process.env,
    CC_PORT: String(PORT),
    CC_HOST: "127.0.0.1",
    CC_AUTH: "1",
    CC_TOKEN: TOKEN,
    CC_DATA_DIR: dataDir,
    CC_DSH_HOME: dshHome,
    CC_DSH_CLI: "none",
  },
});

const cleanup = () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(dshHome, { recursive: true, force: true });
};
process.on("exit", cleanup);

const ready = await waitForPort("127.0.0.1", PORT);
if (!ready) {
  console.error("服务没有在 40 秒内就绪，测试中止。");
  cleanup();
  process.exit(1);
}

try {
  console.log("[1] 鉴权");
  const unauth = await fetch(`${base}/`);
  check("无 token 访问页面被拒绝", unauth.status === 401, `status=${unauth.status}`);
  const apiUnauth = await fetch(`${base}/api/state`);
  check("无 token 访问 API 被拒绝", apiUnauth.status === 401);

  const wrong = await fetch(`${base}/?token=nope`);
  check("错误 token 被拒绝", wrong.status === 401);

  const bootstrap = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
  const setCookie = bootstrap.headers.get("set-cookie") ?? "";
  check("正确 token 触发 cookie 引导", bootstrap.status === 302, `status=${bootstrap.status}`);
  check("cookie 带 HttpOnly", /HttpOnly/i.test(setCookie), setCookie.slice(0, 60));
  const cookie = setCookie.split(";")[0];

  console.log("[2] 状态 / 搜索 / 统计");
  const bearer = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const state = await bearer.json();
  check("Bearer 头可用", bearer.status === 200);
  check("初始名册为空（不预置成员）", Array.isArray(state.agents) && state.agents.length === 0, `agents=${state.agents?.length}`);
  check("返回房间列表", Array.isArray(state.rooms) && state.rooms.length > 0);

  // 添加第一位成员：应自动进「指挥部」并建私人频道，否则界面有成员但派活无效。
  const created = await fetch(`${base}/api/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "测试成员", role: "自检", backend: "dsh" }),
  });
  const createdBody = await created.json();
  check("可以添加 CLI 成员（无需 API key）", created.status === 201, `status=${created.status} ${createdBody.error ?? ""}`);
  check("新成员自动加入指挥部", createdBody.rooms?.group === true);

  const afterCreate = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  const group = afterCreate.rooms.find((room) => room.id === "group");
  check("指挥部包含新成员", Boolean(group?.members.includes(createdBody.member?.id)), group?.members?.join(","));
  check("为新成员建了私人频道", afterCreate.rooms.some((room) => room.id === `dm-${createdBody.member?.id}`));
  check("返回队列状态", typeof state.queue?.active === "number");
  check("返回存储摘要", typeof state.storage?.rooms === "number");

  const byCookie = await fetch(`${base}/api/state`, { headers: { cookie } });
  check("Cookie 可用", byCookie.status === 200);

  const search = await fetch(`${base}/api/search?q=${encodeURIComponent("不存在的内容")}`, {
    headers: { cookie },
  });
  const searchBody = await search.json();
  check("搜索接口可用", search.status === 200 && Array.isArray(searchBody.results));
  check("空结果 total 为 0", searchBody.total === 0);

  const stats = await fetch(`${base}/api/stats`, { headers: { cookie } });
  const statsBody = await stats.json();
  check("统计接口可用", stats.status === 200 && typeof statsBody.turns?.total === "number");
  check("统计包含队列", typeof statsBody.queue?.maxConcurrent === "number");

  console.log("[3] SSE 与断线续传");
  const controller = new AbortController();
  const sse = await fetch(`${base}/api/rooms/group/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  check("SSE 返回事件流", sse.status === 200 && (sse.headers.get("content-type") ?? "").includes("text/event-stream"));

  const reader = sse.body.getReader();
  const first = await reader.read();
  const chunk = new TextDecoder().decode(first.value);
  check("收到 hello 事件", chunk.includes('"type":"hello"'));
  controller.abort();

  console.log("[4] 数据落地位置");
  const metaExists = readFileSync(join(dataDir, "meta.json"), "utf8").includes("group");
  check("生成 meta.json", metaExists);
  check("不再使用单文件 store.json", !readFileSync(join(dataDir, "meta.json"), "utf8").includes("messages"));
} catch (error) {
  failed += 1;
  console.error(`  ✗ 测试过程中抛出异常：${error.message}`);
} finally {
  cleanup();
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 项通过，${failed} 项失败`);

// 不要用 process.exit：Windows 上还有未关闭的 socket 时会触发 libuv 断言。
process.exitCode = failed === 0 ? 0 : 1;
