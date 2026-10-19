// Which layer is eating the main thread? Measures long tasks while the page idles
// with the animated background running, then disables one suspect layer at a time.
//
// The suspects (each costs a full-screen pass every frame):
//   - mix-blend-mode on .bg-scan / .bg-grain  -> forces the whole canvas group to
//     re-blend in software raster
//   - backdrop-filter on .sidebar / .stage-head -> re-blur a region over the canvas
//   - the .bg-sweep background-position animation -> full-screen repaint per frame
//
// Usage: node scripts/probe-paint.mjs
const BASE = process.env.CC_BASE ?? "http://127.0.0.1:8787";
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cc-paint-"));
const port = 9700 + Math.floor(Math.random() * 200);

const child = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

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
    pending.set(id, (message) =>
      message.error ? reject(new Error(message.error.message)) : resolve(message.result),
    );
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });
await sleep(3500);

const PROBE = `
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tasks = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push(Math.round(e.duration)); })
    .observe({ entryTypes: ["longtask"] });
  window.__probe = { tasks };
  return "ready";
})()`;
await evaluate(PROBE);

const scenarios = [
  ["baseline", ""],
  ["scan+grain normal blend", ".bg-scan,.bg-grain{mix-blend-mode:normal!important}"],
  ["no backdrop-filter", ".sidebar,.stage-head{backdrop-filter:none!important}"],
  ["sweep animation off", ".bg-sweep{animation:none!important}"],
  ["all three off", ".bg-scan,.bg-grain{mix-blend-mode:normal!important}.sidebar,.stage-head{backdrop-filter:none!important}.bg-sweep{animation:none!important}"],
  ["bg.js paused", ""],
];

const report = [];
for (const [name, css] of scenarios) {
  await evaluate(`
    (() => {
      // 清掉上一个场景注入的样式
      document.getElementById("__probe_style")?.remove();
      window.__ccBg?.resume();
      if (${JSON.stringify(css)}) {
        const style = document.createElement("style");
        style.id = "__probe_style";
        style.textContent = ${JSON.stringify(css)};
        document.head.append(style);
      }
      if (${JSON.stringify(name)} === "bg.js paused") window.__ccBg?.pause();
      window.__probe.tasks.length = 0;
      return true;
    })()`);
  await sleep(3200);
  const tasks = await evaluate("window.__probe.tasks.slice()");
  report.push({
    scenario: name,
    longTasks: tasks.length,
    totalMs: tasks.reduce((a, b) => a + b, 0),
    worst: tasks.length ? Math.max(...tasks) : 0,
  });
}

console.table(report);
console.log(JSON.stringify(report));

socket.close();
child.kill();
await sleep(400);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
