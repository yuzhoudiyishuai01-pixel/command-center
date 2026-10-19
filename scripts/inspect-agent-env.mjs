#!/usr/bin/env node
/**
 * 检查成员进程实际能看到的环境变量。
 *
 * 用途：核实"成员无法自查权限模式"这个问题是否存在，以及修复后是否生效。
 * 成员只能读到继承给它的环境，所以这里用同样的方式拉起它，让它把自己
 * 看到的 DSH_* 变量原样打印出来。
 *
 * 用法：node scripts/inspect-agent-env.mjs [agentId]
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";
import { resolveLauncher } from "../server/launcher.mjs";
import { profileNameFor } from "../server/agents.mjs";

const agentId = process.argv[2] ?? "claude";
const dir = resolve(config.dataDir, "envcheck");
mkdirSync(dir, { recursive: true });
const outPath = resolve(dir, `${agentId}.out.log`);
const errPath = resolve(dir, `${agentId}.err.log`);
for (const p of [outPath, errPath]) if (existsSync(p)) rmSync(p, { force: true });

const launcher = resolveLauncher();
const task =
  "执行这条命令并把输出原样贴回来，不要做别的：Get-ChildItem env: | Where-Object { $_.Name -like 'DSH*' -or $_.Name -like 'CC_*' } | ForEach-Object { \"$($_.Name)=$($_.Value)\" }";

const outFd = openSync(outPath, "a");
const errFd = openSync(errPath, "a");

console.log(`\n检查 ${agentId} 进程可见的 DSH_* / CC_* 环境变量\n`);
console.log(`  指挥室传给成员的权限模式: ${config.permissionMode}\n`);

const child = spawn(launcher.command, [...launcher.prefixArgs, profileNameFor(agentId), "--json", "--", task], {
  cwd: config.workspace,
  windowsHide: true,
  stdio: ["ignore", outFd, errFd],
  env: {
    ...process.env,
    ...launcher.env,
    DSH_HOME: config.dshHome,
    DSH_PERMISSION_MODE: config.permissionMode,
    // 与 server/runner.mjs 保持一致，否则本探针测的不是真实派发路径。
    CC_PERMISSION_MODE: config.permissionMode,
    CC_WORKSPACE: config.workspace,
    DSH_TELEMETRY_DISABLED: "1",
  },
});
closeSync(outFd);
closeSync(errFd);

const started = Date.now();
await new Promise((resolvePromise) => {
  const timer = setTimeout(() => {
    child.kill();
    resolvePromise();
  }, 5 * 60 * 1000);
  child.on("close", () => {
    clearTimeout(timer);
    resolvePromise();
  });
  child.on("error", () => {
    clearTimeout(timer);
    resolvePromise();
  });
});

const out = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
const events = out
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log(`  耗时 ${Date.now() - started}ms，收到 ${events.length} 个事件\n`);

// 找出工具输出里的环境变量行
for (const event of events) {
  if (event.type === "tool_result" && typeof event.result === "string" && /DSH_/.test(event.result)) {
    console.log("  成员看到的环境变量：");
    for (const line of event.result.split("\n")) {
      if (/DSH_/.test(line)) console.log(`    ${line.trim()}`);
    }
  }
}

const final = events.find((e) => e.type === "final");
if (final?.text) {
  console.log("\n  成员回复：");
  console.log(
    final.text
      .split("\n")
      .slice(0, 20)
      .map((l) => `    ${l}`)
      .join("\n"),
  );
}
console.log("");
