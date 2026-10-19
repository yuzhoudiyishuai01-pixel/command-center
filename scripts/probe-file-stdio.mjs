#!/usr/bin/env node
/**
 * 针对"输出重定向到文件"这一运行策略的验证探针。
 *
 * 背景：当前环境的沙箱禁止子进程使用管道（piped stdio）——连 spawn node 自身都会
 * EPERM；但 stdio 继承与文件重定向可用。因此指挥室改用"子进程写文件、父进程增量读
 * 文件"的方式取回成员的 JSON 事件流。
 *
 * 本脚本验证该策略在两个层面都成立：
 *   1. 能否把成员进程的 stdout/stderr 重定向到文件
 *   2. 能否增量读到输出，并确认进程正常结束
 *
 * 用法：node scripts/probe-file-stdio.mjs [成员id]
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";
import { profileNameFor } from "../server/agents.mjs";

const LAUNCHER = "C:\\Users\\sexyboy\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const agentId = process.argv[2] ?? "deepseek";

const logDir = resolve(config.dataDir, "probe");
mkdirSync(logDir, { recursive: true });
const outPath = resolve(logDir, `probe-${agentId}.out.log`);
const errPath = resolve(logDir, `probe-${agentId}.err.log`);
for (const path of [outPath, errPath]) if (existsSync(path)) rmSync(path, { force: true });

console.log("\n文件重定向策略验证\n");
console.log(`  输出文件  ${outPath}`);
console.log(`  错误文件  ${errPath}`);
console.log("");

const outFd = openSync(outPath, "a");
const errFd = openSync(errPath, "a");

const started = Date.now();
const stamp = () => `[+${String(Date.now() - started).padStart(6)}ms]`;

const child = spawn(LAUNCHER, [profileNameFor(agentId), "--json", "--", "只回复两个字：收到"], {
  cwd: config.workspace,
  windowsHide: true,
  // 关键：不用管道，直接写文件描述符。
  stdio: ["ignore", outFd, errFd],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DSH_HOME: config.dshHome,
    DSH_PERMISSION_MODE: config.permissionMode,
    DSH_TELEMETRY_DISABLED: "1",
  },
});

closeSync(outFd);
closeSync(errFd);
console.log(`${stamp()} spawned pid=${child.pid}`);

let offset = 0;
let sawOutput = false;
const poller = setInterval(() => {
  let text;
  try {
    text = readFileSync(outPath, "utf8");
  } catch {
    return;
  }
  if (text.length <= offset) return;
  const fresh = text.slice(offset);
  offset = text.length;
  sawOutput = true;
  for (const line of fresh.split("\n")) {
    if (line.trim()) console.log(`${stamp()} OUT  ${line.slice(0, 240)}`);
  }
}, 400);

const finish = (verdict, note) => {
  clearInterval(poller);
  const err = existsSync(errPath) ? readFileSync(errPath, "utf8").trim() : "";
  console.log(`${stamp()} ${verdict} — ${note}`);
  if (err) console.log(`   stderr 摘要：${err.split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  console.log("");
  if (verdict === "✓ 通过" && sawOutput) {
    console.log("  结论：文件重定向策略可用——成员进程能启动、能产出事件、能被增量读取。\n");
    process.exit(0);
  }
  console.log("  结论：该策略在当前环境不可行。\n");
  process.exit(1);
};

child.on("error", (error) => finish("✗ 失败", `${error.code} ${error.message}`));
child.on("close", (code) => finish(code === 0 ? "✓ 通过" : "△ 结束", `退出码 ${code}`));

setTimeout(() => {
  child.kill();
  finish("✗ 超时", "120 秒内未结束");
}, 120_000);
