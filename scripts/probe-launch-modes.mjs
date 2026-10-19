#!/usr/bin/env node
/**
 * 启动方式探针：在"必须用文件重定向、不能用管道"的前提约束下，
 * 找出哪种方式能正确拉起成员进程。
 *
 * 候选：
 *   G. exe 默认模式（不加 ELECTRON_RUN_AS_NODE），直接把 profile 当应用参数
 *   H. exe + ELECTRON_RUN_AS_NODE=1，复刻 dsh.cmd：第一个参数是 CLI 脚本路径
 *
 * 用法：node scripts/probe-launch-modes.mjs [成员id]
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";
import { profileNameFor } from "../server/agents.mjs";

const LAUNCHER = "C:\\Users\\sexyboy\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const CLI_JS = "C:\\Users\\sexyboy\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";
const agentId = process.argv[2] ?? "deepseek";

const logDir = resolve(config.dataDir, "probe");
mkdirSync(logDir, { recursive: true });

function run({ name, args, env }, timeoutMs = 100_000) {
  return new Promise((resolvePromise) => {
    const outPath = resolve(logDir, `${name}.out.log`);
    const errPath = resolve(logDir, `${name}.err.log`);
    for (const path of [outPath, errPath]) if (existsSync(path)) rmSync(path, { force: true });

    const outFd = openSync(outPath, "a");
    const errFd = openSync(errPath, "a");
    const started = Date.now();

    let child;
    try {
      child = spawn(LAUNCHER, args, {
        cwd: config.workspace,
        windowsHide: true,
        stdio: ["ignore", outFd, errFd],
        env: { ...process.env, ...env, DSH_HOME: config.dshHome, DSH_PERMISSION_MODE: config.permissionMode, DSH_TELEMETRY_DISABLED: "1" },
      });
    } catch (error) {
      closeSync(outFd);
      closeSync(errFd);
      resolvePromise({ name, verdict: "THROWN", note: `${error.code} ${error.message}`, outPath, errPath, ms: 0 });
      return;
    }
    closeSync(outFd);
    closeSync(errFd);

    const finish = (verdict, note) => {
      clearTimeout(timer);
      const out = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
      const err = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
      resolvePromise({ name, verdict, note, outPath, errPath, out, err, ms: Date.now() - started });
    };

    child.on("error", (error) => finish("ERROR", `${error.code} ${error.message}`));
    const timer = setTimeout(() => {
      child.kill();
      finish("TIMEOUT", `${timeoutMs}ms 未结束`);
    }, timeoutMs);
    child.on("close", (code) => finish(code === 0 ? "OK" : "EXIT", `退出码 ${code}`));
  });
}

const profile = profileNameFor(agentId);
console.log(`\n启动方式探针 · 成员=${agentId} · profile=${profile}\n`);

const candidates = [
  {
    key: "G-default-mode",
    name: "G. exe 默认模式（profile 作为应用参数）",
    args: [profile, "--json", "--", "只回复两个字：收到"],
    env: {},
  },
  {
    key: "H-node-mode-clijs",
    name: "H. exe 以 Node 模式运行 CLI 脚本（复刻 dsh.cmd）",
    args: [CLI_JS, profile, "--json", "--", "只回复两个字：收到"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  },
];

for (const candidate of candidates) {
  process.stdout.write(`  ${candidate.name} … `);
  const result = await run({ name: candidate.key, args: candidate.args, env: candidate.env });
  const label = { OK: "✓ 可用", EXIT: "△ 结束但非 0", ERROR: "✗ 被拒", THROWN: "✗ 抛错", TIMEOUT: "✗ 卡死" }[result.verdict];
  console.log(`${label}（${result.ms}ms，${result.note}）`);

  const outLines = (result.out ?? "").split("\n").filter(Boolean);
  if (result.verdict === "OK") {
    const finalLine = outLines.find((line) => line.includes('"type":"final"'));
    console.log(`      产出 ${outLines.length} 行事件；${finalLine ? `最终答复：${JSON.parse(finalLine).text}` : "无 final 事件"}`);
  } else {
    const errTail = (result.err ?? "").split("\n").filter(Boolean).slice(0, 3).join(" | ");
    if (errTail) console.log(`      错误：${errTail.slice(0, 260)}`);
  }
}

console.log("");
