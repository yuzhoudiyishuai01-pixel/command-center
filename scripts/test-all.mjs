#!/usr/bin/env node
/**
 * 默认测试集：语法 + 存储 + 保留策略 + 鉴权端到端。
 *
 * 这些都不需要模型、不需要网络，克隆下来 `npm test` 就能跑——CI 用同一套。
 * 需要真实模型/CLI 的检查（selfcheck、member-flow）是单独的脚本，手动跑。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const STEPS = [
  ["语法检查", "scripts/check-syntax.mjs"],
  ["存储层", "scripts/test-store.mjs"],
  ["作业队列", "scripts/test-queue.mjs"],
  ["体量保留", "scripts/test-retention.mjs"],
  ["鉴权与接口", "scripts/test-auth.mjs"],
];

let failed = 0;
for (const [label, script] of STEPS) {
  console.log(`\n══ ${label}（${script}）`);
  try {
    execFileSync(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, stdio: "inherit" });
  } catch {
    failed += 1;
    console.error(`✗ ${label} 失败`);
  }
}

console.log(`\n${failed === 0 ? "全部测试通过" : `${failed} 组测试失败`}`);
process.exitCode = failed === 0 ? 0 : 1;
