#!/usr/bin/env node
/**
 * 跨平台启动器：启动服务 → 等服务就绪 → 打开带 token 的界面网址。
 *
 *   npx command-center            # 正常启动并打开浏览器
 *   npx command-center --no-open  # 只启动服务（服务器/容器里用）
 *   npx command-center --port 9000 --host 0.0.0.0
 *
 * 为什么单独一层：server/index.mjs 是纯服务端入口（不依赖浏览器），
 * 而"双击就能用"需要打开浏览器这件事按平台走不同命令。分开之后，
 * 容器/CI 里可以直接 `npm run serve`，桌面用户用 `npm start`。
 *
 * 注意：子进程用 stdio: "inherit"。沙箱环境禁止管道 stdio（EPERM），
 * inherit 既避开这个限制，也让用户直接看到服务端日志。
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { open: true, port: null, host: null, data: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--no-open":
        options.open = false;
        break;
      case "--port":
        options.port = argv[++index];
        break;
      case "--host":
        options.host = argv[++index];
        break;
      case "--data":
        options.data = argv[++index];
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
        else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
        else if (arg.startsWith("--data=")) options.data = arg.slice("--data=".length);
        break;
    }
  }
  return options;
}

function printHelp() {
  console.log(`指挥室 / Command Center

用法：
  command-center [选项]

选项：
  --port <n>      监听端口（默认 8787，也可用 CC_PORT）
  --host <addr>   监听地址（默认 127.0.0.1；对外暴露前务必开启鉴权）
  --data <dir>    数据目录（默认 ./data）
  --no-open       不自动打开浏览器
  -h, --help      显示帮助
`);
}

/** 等服务真正 accept 连接（最多 30 秒）。 */
function waitForPort(host, port, timeoutMs = 30_000) {
  const target = ["0.0.0.0", "::", ""].includes(host) ? "127.0.0.1" : host;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const attempt = () => {
      const socket = connect({ host: target, port }, () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolvePromise(false);
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** 各平台打开默认浏览器。 */
function openBrowser(url) {
  const commands = {
    win32: ["cmd", ["/c", "start", "", url]],
    darwin: ["open", [url]],
  };
  const [command, args] = commands[process.platform] ?? ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => console.log(`（无法自动打开浏览器，请手动访问 ${url}）`));
    child.unref();
  } catch {
    console.log(`（无法自动打开浏览器，请手动访问 ${url}）`);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.port) process.env.CC_PORT = String(options.port);
if (options.host) process.env.CC_HOST = String(options.host);
if (options.data) process.env.CC_DATA_DIR = String(resolve(options.data));

const { config } = await import("../server/config.mjs");
const { ensureToken, tokenizedUrl } = await import("../server/auth.mjs");

// 端口上已经有服务（比如开机自启的那个）就别再起一个：直接打开界面。
// 否则子进程会 EADDRINUSE，而外层因为端口是通的会误报"启动成功"。
const alreadyRunning = await waitForPort(config.host, config.port, 800);
if (alreadyRunning) {
  const existingUrl = config.auth
    ? tokenizedUrl(config.host, config.port)
    : `http://${config.host}:${config.port}/`;
  console.log(`\n  指挥室已经在运行：${existingUrl}\n`);
  if (options.open) openBrowser(existingUrl);
  process.exit(0);
}

const child = spawn(process.execPath, [resolve(ROOT, "server", "index.mjs")], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});

const shutdown = () => {
  if (!child.killed) child.kill(process.platform === "win32" ? undefined : "SIGTERM");
};
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

const ready = await waitForPort(config.host, config.port);
if (!ready) {
  console.error("服务在 30 秒内没有就绪，请检查上面的启动日志。");
  process.exit(1);
}

const url = config.auth ? tokenizedUrl(config.host, config.port) : `http://${config.host}:${config.port}/`;
console.log(`\n  界面地址：${url}\n`);
ensureToken();
if (options.open) openBrowser(url);
