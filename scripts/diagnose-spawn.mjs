#!/usr/bin/env node
/**
 * 诊断脚本：在一个受控环境里直接 spawn 成员进程，观察它到底卡在哪。
 *
 * 用法：node scripts/diagnose-spawn.mjs [成员id]
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config } from "../server/config.mjs";
import { profileNameFor } from "../server/agents.mjs";

const agentId = process.argv[2] ?? "deepseek";
const profile = profileNameFor(agentId);

/** 与 runner.mjs 相同的启动器推导逻辑，单独写一份便于对照排查。 */
function resolveLauncher() {
  const cli = config.dshCli;
  if (config.dshExecutable && existsSync(config.dshExecutable)) {
    return { command: config.dshExecutable, env: { ELECTRON_RUN_AS_NODE: "1" }, how: "config" };
  }
  if (/\.(cmd|bat)$/i.test(cli)) {
    try {
      const text = readFileSync(cli, "latin1");
      const exe = text.match(/[\w .\-]+\.exe/i);
      if (exe) {
        const candidate = resolve(dirname(cli), exe[0]);
        if (existsSync(candidate)) {
          return { command: candidate, env: { ELECTRON_RUN_AS_NODE: "1" }, how: `cmd 内首个子进程 ${exe[0]}` };
        }
      }
    } catch {}
    let dir = resolve(dirname(cli));
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(dir, "DeepSeek Harness.exe");
      if (existsSync(candidate)) {
        return { command: candidate, env: { ELECTRON_RUN_AS_NODE: "1" }, how: `向上第 ${depth} 级找到启动器` };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { command: cli, env: {}, how: "原路径（未推导）" };
}

const launcher = resolveLauncher();
console.log("启动器解析：");
console.log(`  方式      ${launcher.how}`);
console.log(`  command   ${launcher.command}`);
console.log(`  存在      ${existsSync(launcher.command)}`);
console.log(`  dshCli    ${config.dshCli}`);
console.log(`  dshHome   ${config.dshHome}`);
console.log(`  workspace ${config.workspace}`);
console.log("");

const started = Date.now();
const stamp = () => `[+${String(Date.now() - started).padStart(6)}ms]`;

const child = spawn(launcher.command, [profile, "--json", "--", "只回复两个字：收到"], {
  cwd: config.workspace,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ...launcher.env,
    DSH_HOME: config.dshHome,
    DSH_PERMISSION_MODE: config.permissionMode,
    DSH_TELEMETRY_DISABLED: "1",
  },
});

console.log(`${stamp()} spawned pid=${child.pid}`);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (line.trim()) console.log(`${stamp()} OUT  ${line.slice(0, 300)}`);
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (line.trim()) console.log(`${stamp()} ERR  ${line.slice(0, 300)}`);
  }
});

child.on("error", (error) => console.log(`${stamp()} ERROR ${error.code ?? ""} ${error.message}`));
child.on("spawn", () => console.log(`${stamp()} event: spawn`));
child.on("exit", (code, signal) => console.log(`${stamp()} event: exit code=${code} signal=${signal}`));
child.on("close", (code) => console.log(`${stamp()} event: close code=${code}`));

setTimeout(() => {
  console.log(`${stamp()} 90 秒无结论，判定为卡死，杀掉子进程`);
  child.kill();
  setTimeout(() => process.exit(2), 500);
}, 90_000);
