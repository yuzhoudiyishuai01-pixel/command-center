#!/usr/bin/env node
/**
 * Codex CLI 可用性探针。
 *
 * 目的：确定在"文件重定向取流 + 硬超时"这套约束下，Codex 能不能被当作成员后端拉起。
 * 之前直接在前台跑 codex exec 会一直不返回（超过 5 分钟），必须带超时并观察它到底
 * 卡在哪一步。用文件收 stdout/stderr，避免沙箱的管道限制。
 *
 * 用法：node scripts/probe-codex.mjs
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";

const CODEX = "C:\\Users\\sexyboy\\AppData\\Local\\OpenAI\\Codex\\bin\\9614f1d9b40d9c4f\\codex.exe";
const dir = resolve(config.dataDir, "codexprobe");
mkdirSync(dir, { recursive: true });

const TASK = "Reply with exactly: CODEX_OK";

/** 每个变体跑一次，带各自超时。 */
const variants = [
  {
    key: "a-basic",
    label: "A. exec --json --skip-git-repo-check（默认沙箱）",
    args: ["exec", "--json", "--skip-git-repo-check", "--cd", config.workspace, TASK],
    timeoutMs: 90_000,
  },
  {
    key: "b-bypass",
    label: "B. 同上 + --dangerously-bypass-approvals-and-sandbox",
    args: [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd",
      config.workspace,
      TASK,
    ],
    timeoutMs: 90_000,
  },
];

function run(variant) {
  return new Promise((resolvePromise) => {
    const outPath = resolve(dir, `${variant.key}.out.log`);
    const errPath = resolve(dir, `${variant.key}.err.log`);
    for (const p of [outPath, errPath]) if (existsSync(p)) rmSync(p, { force: true });

    const outFd = openSync(outPath, "a");
    const errFd = openSync(errPath, "a");
    const started = Date.now();

    let child;
    try {
      child = spawn(CODEX, variant.args, {
        cwd: config.workspace,
        windowsHide: true,
        stdio: ["ignore", outFd, errFd],
      });
    } catch (error) {
      closeSync(outFd);
      closeSync(errFd);
      resolvePromise({ variant, verdict: "THROWN", note: error.message, ms: 0, out: "", err: "" });
      return;
    }
    closeSync(outFd);
    closeSync(errFd);

    const finish = (verdict, note) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      resolvePromise({
        variant,
        verdict,
        note,
        ms: Date.now() - started,
        out: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
        err: existsSync(errPath) ? readFileSync(errPath, "utf8") : "",
      });
    };

    const timer = setTimeout(() => finish("TIMEOUT", `${variant.timeoutMs / 1000}s 未返回`), variant.timeoutMs);
    child.on("error", (error) => finish("ERROR", `${error.code ?? ""} ${error.message}`));
    child.on("close", (code) => finish(code === 0 ? "OK" : "EXIT", `退出码 ${code}`));
  });
}

console.log(`\nCodex CLI 探针 · 工作区 ${config.workspace}\n`);

const results = [];
for (const variant of variants) {
  process.stdout.write(`  ${variant.label} … `);
  const result = await run(variant);
  results.push(result);
  const label = { OK: "✓ 可用", EXIT: "△ 结束但非 0", ERROR: "✗ 被拒", THROWN: "✗ 抛错", TIMEOUT: "✗ 超时" }[result.verdict];
  console.log(`${label}（${result.ms}ms，${result.note}）`);
}

console.log("\n详细结果：");
for (const r of results) {
  console.log(`\n  ── ${r.variant.label}`);
  console.log(`     判定：${r.verdict} · ${r.note}`);
  const outLines = (r.out ?? "").split("\n").filter(Boolean);
  console.log(`     stdout ${outLines.length} 行`);
  // codex --json 是 JSONL，试着抽出事件类型
  const types = new Set();
  for (const line of outLines) {
    try {
      const o = JSON.parse(line);
      types.add(o.type ?? o.msg?.type ?? "?");
    } catch {
      /* 非 JSON 行 */
    }
  }
  if (types.size > 0) console.log(`     事件类型：${[...types].join(", ")}`);
  if (outLines.length > 0) console.log(`     尾部：${outLines.slice(-2).join(" | ").slice(0, 300)}`);
  const errTail = (r.err ?? "").split("\n").filter(Boolean).slice(-4).join(" | ");
  if (errTail) console.log(`     stderr：${errTail.slice(0, 400)}`);
}

console.log("");
