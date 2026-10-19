#!/usr/bin/env node
/**
 * 用 Edge/Chrome 的 DevTools 协议给界面截图。
 *
 * 为什么不直接用 `msedge --headless --screenshot`：指挥室挂了一条永不结束的 SSE 连接，
 * 那种一次性截图模式会一直等"页面加载完成"，实测直接挂死。这里改成显式走 CDP：
 * 打开页面 → 按毫秒数等渲染稳定 → Page.captureScreenshot，然后自己关浏览器。
 *
 * 用法：
 *   node scripts/screenshot.mjs <out.png> [--url http://127.0.0.1:8787] [--width 1600]
 *                               [--height 1000] [--wait 2500] [--scale 1] [--click <选择器>]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// 第一个位置参数是输出图片；只做调试取值（--eval）时可以不给。
const positional = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
const evalExpr = flag("eval", "");
const out = positional || (evalExpr ? "" : "");
if (!out && !evalExpr) {
  console.error("用法: node scripts/screenshot.mjs <out.png> [--url URL] [--width N] [--height N] [--wait MS] [--scale N] [--click CSS] [--eval EXPR]");
  process.exit(1);
}

const url = flag("url", "http://127.0.0.1:8787");
const width = Number(flag("width", 1600));
const height = Number(flag("height", 1000));
const waitMs = Number(flag("wait", 2500));
const scale = Number(flag("scale", 1));
const clickSel = flag("click", "");
const port = Number(flag("port", 9333));

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error("找不到 Edge/Chrome 可执行文件");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "cc-shot-"));
const child = spawn(
  browser,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--force-color-profile=srgb",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* 还在启动 */
    }
    await sleep(150);
  }
  throw new Error("DevTools 端口没有起来");
}

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = (seq += 1);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
    }, 20000);
  });
}

function cleanup(code) {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔还被占用，留给系统临时目录 */
  }
  process.exit(code);
}

try {
  await waitForDevtools();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用的 page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  await send("Page.navigate", { url });
  await sleep(waitMs);

  if (clickSel) {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(clickSel)}); if (!el) return "missing"; el.click(); return "ok"; })()`,
      returnByValue: true,
    });
    console.log(`click ${clickSel}: ${result.value}`);
    await sleep(900);
  }

  if (evalExpr) {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression: evalExpr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "求值异常");
    console.log(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
    if (!out) cleanup(0);
  }

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`wrote ${out} (${width}x${height} @${scale}x)`);
  cleanup(0);
} catch (err) {
  console.error(`截图失败: ${err.message}`);
  cleanup(1);
}
