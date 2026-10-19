#!/usr/bin/env node
/**
 * 能力探针：在当前运行环境里，找出"怎样才能成功拉起一个成员进程"。
 *
 * DSH 的沙箱会限制子进程的执行与管道使用，具体边界随环境而异，因此这里不靠猜测，
 * 而是把各种 spawn 组合都试一遍，逐一报告结果。结果用于选择运行策略。
 *
 * 用法：node scripts/probe-spawn.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { config } from "../server/config.mjs";

const LAUNCHER = "C:\\Users\\sexyboy\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const CMD = config.dshCli;
const NODE = process.execPath;

/** 每个变体：跑一条极短、不需要模型的命令，只验证"能否启动并取到输出"。 */
const variants = [
  {
    name: "A. 直接 spawn 启动器 .exe（ELECTRON_RUN_AS_NODE=1，piped）",
    command: LAUNCHER,
    args: ["-e", "console.log('ok')"],
    options: { env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  },
  {
    name: "B. spawn .cmd + shell:true（piped）",
    command: CMD,
    args: ["--version"],
    options: { shell: true, stdio: ["ignore", "pipe", "pipe"] },
  },
  {
    name: "C. spawn .cmd 不加 shell（预期 EINVAL）",
    command: CMD,
    args: ["--version"],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  },
  {
    name: "D. 直接 spawn 启动器 .exe，stdio inherit",
    command: LAUNCHER,
    args: ["-e", "console.log('ok')"],
    options: { env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "inherit", "inherit"] },
  },
  {
    name: "E. spawn 当前 node 自身（piped）— 验证管道本身是否可用",
    command: NODE,
    args: ["-e", "console.log('ok')"],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  },
  {
    name: "F. spawn cmd.exe /c 启动器（piped）",
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `set ELECTRON_RUN_AS_NODE=1&&"${LAUNCHER}" -e "console.log('ok')"`],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  },
];

function attempt(variant, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let child;
    let settled = false;

    const done = (verdict, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {}
      resolve({ verdict, note, ms: Date.now() - started, stdout: stdout.trim(), stderr: stderr.trim() });
    };

    const timer = setTimeout(() => done("TIMEOUT", `${timeoutMs}ms 内无结果`), timeoutMs);

    try {
      child = spawn(variant.command, variant.args, {
        cwd: config.workspace,
        windowsHide: true,
        ...variant.options,
        env: { ...process.env, ...(variant.options.env ?? {}) },
      });
    } catch (error) {
      done("THROWN", `${error.code ?? ""} ${error.message}`);
      return;
    }

    child.on("error", (error) => done("ERROR", `${error.code ?? ""} ${error.message}`));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => done(code === 0 ? "OK" : "EXIT", `退出码 ${code}`));
  });
}

console.log("\n执行能力探针\n");
console.log(`  平台         ${process.platform}`);
console.log(`  启动器存在   ${existsSync(LAUNCHER)}`);
console.log(`  dshCli 存在  ${existsSync(CMD)}`);
console.log(`  当前 node    ${NODE}`);
console.log("");

const results = [];
for (const variant of variants) {
  process.stdout.write(`  ${variant.name} … `);
  const result = await attempt(variant);
  results.push({ variant, result });
  const label = { OK: "✓ 可用", EXIT: "△ 能启动", ERROR: "✗ 被拒", THROWN: "✗ 抛错", TIMEOUT: "✗ 卡死" }[result.verdict];
  console.log(`${label}（${result.ms}ms，${result.note}）`);
}

console.log("\n详细结果：");
for (const { variant, result } of results) {
  console.log(`\n  ── ${variant.name}`);
  console.log(`     判定：${result.verdict} · ${result.note}`);
  if (result.stdout) console.log(`     输出：${result.stdout.split("\n").slice(0, 3).join(" | ").slice(0, 200)}`);
  if (result.stderr) console.log(`     错误：${result.stderr.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
}

const usable = results.filter(({ result }) => result.verdict === "OK" || result.verdict === "EXIT");
console.log(
  `\n结论：${usable.length} / ${results.length} 个变体可用` +
    (usable.length > 0 ? ` → 建议采用：${usable[0].variant.name}` : " → 当前环境无法派发子进程"),
);
console.log("");
