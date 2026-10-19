// Measure UI "flicker" during a real turn: count CSS animation restarts and DOM
// churn in the transcript / live feed. Used to prove the cause before fixing it.
// Usage: node scripts/measure-flicker.mjs
const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const waitMs = Number(process.env.WAIT_MS ?? 26000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cc-flick-"));
const port = 9400 + Math.floor(Math.random() * 300);

const child = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let target = null;
for (let i = 0; i < 120; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((item) => item.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) throw new Error("no CDP page target");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });
await sleep(3500);

const expression = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  const anim = {};
  const onAnim = (e) => { anim[e.animationName] = (anim[e.animationName] || 0) + 1; };
  document.addEventListener('animationstart', onAnim, true);
  let tx = 0, feed = 0, txNodes = 0;
  const moTx = new MutationObserver((list) => {
    tx += list.length;
    for (const m of list) txNodes += m.addedNodes.length + m.removedNodes.length;
  });
  const moFeed = new MutationObserver((list) => { feed += list.length; });
  moTx.observe(document.querySelector('#transcript'), { childList: true, subtree: true });
  moFeed.observe(document.querySelector('#live-feed'), { childList: true, subtree: true });
  const longTasks = [];
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch {}

  // ── 基线：空闲时背景动画本身的开销（开 / 关各 2.5s）──────────────────
  // 关掉背景后如果长任务消失，说明主线程是被 bg.js 吃掉的；如果"闪烁"仍在，
  // 那就是 DOM 重绘的问题，与背景无关。两个方向分开量才知道该修哪边。
  await wait(700);
  longTasks.length = 0;
  await wait(2500);
  const bgOnTasks = longTasks.slice();
  window.__ccBg?.pause();
  await wait(400);
  longTasks.length = 0;
  await wait(2500);
  const bgOffTasks = longTasks.slice();
  // KEEP_BG_PAUSED=1：整轮作业都关着背景动画，用来分开"canvas 重绘"和"DOM 更新"
  // 各自贡献了多少长任务（关掉后还剩多少 = DOM/渲染管线的成本）。
  if (${process.env.KEEP_BG_PAUSED ? "true" : "false"}) {
    window.__ccBg?.pause();
  } else {
    window.__ccBg?.resume();
  }
  await wait(300);

  // ── 真实一轮作业 ────────────────────────────────────────────────────
  const input = document.querySelector('#input');
  if (!input) return JSON.stringify({ error: 'no input' });
  longTasks.length = 0;
  input.focus();
  input.value = ${JSON.stringify(process.env.PROMPT ?? "@DeepSeek 只回复两个字：收到。不要调用任何工具。")};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(${waitMs});
  document.removeEventListener('animationstart', onAnim, true);
  moTx.disconnect();
  moFeed.disconnect();
  return JSON.stringify({
    anim,
    transcriptMutations: tx,
    transcriptNodes: txNodes,
    feedMutations: feed,
    bgOnLongTasks: bgOnTasks,
    bgOffLongTasks: bgOffTasks,
    longTasks,
    bg: window.__ccBg?.stats?.() ?? null,
    seconds: Math.round((performance.now() - t0) / 1000),
  });
})()`;

const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(result.result?.value ?? JSON.stringify(result));

socket.close();
child.kill();
await sleep(400);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
