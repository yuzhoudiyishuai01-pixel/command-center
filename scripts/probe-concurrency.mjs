#!/usr/bin/env node
/**
 * 并发探针：验证"多位成员同时开工"是否会触发沙箱的临时授权失败。
 *
 * 背景：指挥室让一位成员开工时，该成员进程需要向沙箱申请一份临时文件授权，
 * 而这份授权由 %TEMP%\dsh-acl-locks 下的锁保护。群聊里全员并行开工时，多个进程
 * 可能同时抢这把锁，从而出现：
 *   sandbox-local windows-acl temp grant materialization failed and its cleanup also failed
 *
 * 本探针用同一套"文件重定向取流"的方式并行拉起 N 位成员，并统计谁的输出里出现了
 * 该错误，从而把"是不是并发导致"变成可复现的事实而不是猜测。
 *
 * 用法：
 *   node scripts/probe-concurrency.mjs                  并发启动 4 位成员
 *   node scripts/probe-concurrency.mjs --stagger 3000   每位之间错开 3 秒
 *   node scripts/probe-concurrency.mjs --dry-run        只打印本轮将写入的归档路径与权限模式，不拉起成员
 *   node scripts/probe-concurrency.mjs --member-mode workspace-write
 *                                                       强制成员跑在受限沙箱里（不改 cc.config.json）
 *                                                       —— 用来检验 README 的核心论断：
 *                                                       「开关是会话权限，不是 cc.config.json」
 *
 * 取证纪律（2026-10-14 修订）：
 *   1. 每次运行写入**独立的带时间戳子目录**，不再覆盖上一轮的日志——
 *      旧版本在启动时 rmSync 同名日志，第二次运行会销毁第一次的证据（实测发生过）。
 *   2. 每轮把生效的权限模式写进 run.json。**权限模式决定了本轮有没有判别力**：
 *      README 记载「完全权限」下本就不会出现授权物化失败，因此在该模式下跑出
 *      "0 失败"属于 null result，不构成对竞态假说的证伪。旧版本会照旧打印
 *      "✓ 未复现"，读的人很容易把它误当成结论。
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";
import { resolveLauncher } from "../server/launcher.mjs";
import { AGENTS, profileNameFor } from "../server/agents.mjs";

const args = process.argv.slice(2);
const staggerIndex = args.indexOf("--stagger");
const STAGGER_MS = staggerIndex !== -1 ? Number(args[staggerIndex + 1]) : 0;
const DRY_RUN = args.includes("--dry-run");

const TASK = "执行一条命令：echo ok。如果命令失败，如实说失败，不要重试超过一次。";
const root = resolve(config.dataDir, "concurrency");

/** 成员进程的沙箱模式：默认取 cc.config.json，可用 --member-mode 临时覆盖（不改在线配置）。 */
const memberModeIndex = args.indexOf("--member-mode");
const MEMBER_MODE = memberModeIndex !== -1 ? args[memberModeIndex + 1] : config.permissionMode;
if (!["danger-full-access", "workspace-write"].includes(MEMBER_MODE)) {
  console.error(`--member-mode 取值非法：${MEMBER_MODE}（只接受 danger-full-access | workspace-write）`);
  process.exit(2);
}

/** 归档目录名：本地时间戳 + 生效权限模式，两者都在名字里，便于事后比对。 */
function stampDirName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-member-${MEMBER_MODE}${STAGGER_MS ? `-stagger${STAGGER_MS}` : ""}`;
}

/**
 * 本轮有没有判别力。
 * 判据不是"跑了没有"，而是"这一轮的条件下，故障有没有可能出现"：
 *   · 成员为完全权限 → 按 README 前置条件表，本就不该失败，0 失败是预期结果，属 null result；
 *   · 成员为受限沙箱 → 具备复现条件。若此时仍 0 失败，才是对 README「cc.config.json 的
 *     permissionMode 不是开关（会话才是）」这条论断的有效支持。
 */
function discriminatingPower() {
  if (MEMBER_MODE === "workspace-write") {
    return {
      usable: true,
      hypothesis: "受限成员沙箱下，四位成员并发开工是否会触发授权物化失败；同时检验 README 的「会话权限才是开关」论断。",
      reason: "本轮成员被强制为 workspace-write，具备复现条件。",
    };
  }
  return {
    usable: false,
    hypothesis: "（无）",
    reason:
      "本轮成员为 danger-full-access。按 README 的前置条件表，该模式下成员本就应全部正常，\n" +
      "    因此即使 0 失败也不能证伪「并发竞态」假说——这是一次 null result，不是结论。\n" +
      "    要拿到有判别力的数据，加 --member-mode workspace-write 再跑一次。",
  };
}

const dir = resolve(root, stampDirName());
const launcher = resolveLauncher();
const power = discriminatingPower();

const meta = {
  startedAt: new Date().toISOString(),
  memberPermissionMode: MEMBER_MODE,
  memberModeSource: memberModeIndex !== -1 ? "--member-mode 覆盖" : "cc.config.json",
  shellPermissionMode: process.env.CC_PERMISSION_MODE ?? null,
  shellWorkspace: process.env.CC_WORKSPACE ?? null,
  staggerMs: STAGGER_MS,
  task: TASK,
  launchHow: launcher.how,
  nodeVersion: process.version,
  lockDir: `${process.env.TEMP}\\dsh-acl-locks`,
  archiveDir: dir,
  hypothesis: power.hypothesis,
  discriminatingPower: power.usable,
};

console.log(`\n并发探针 · 成员 ${AGENTS.length} 位 · 错峰 ${STAGGER_MS}ms`);
console.log(`  启动方式   ${launcher.how}`);
console.log(`  锁目录     ${meta.lockDir}`);
console.log(`  成员权限   ${meta.memberPermissionMode}（${meta.memberModeSource}）`);
console.log(`  本会话权限 ${meta.shellPermissionMode ?? "（未注入 CC_PERMISSION_MODE）"}`);
console.log(`  归档目录   ${dir}`);
if (power.usable) console.log(`  检验命题   ${power.hypothesis}`);
else console.log(`  ⚠ 判别力   ${power.reason}`);
console.log("");

if (DRY_RUN) {
  console.log("  --dry-run：不拉起成员，仅确认归档路径与权限模式标记。");
  console.log(`  将写入     ${resolve(dir, "run.json")}`);
  console.log(`  成员日志   ${resolve(dir, "<agent>.out.log | <agent>.err.log")}`);
  console.log("");
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

function launch(agent, index) {
  const outPath = resolve(dir, `${agent.id}.out.log`);
  const errPath = resolve(dir, `${agent.id}.err.log`);

  return new Promise((resolvePromise) => {
    setTimeout(() => {
      const outFd = openSync(outPath, "a");
      const errFd = openSync(errPath, "a");
      const started = Date.now();
      const child = spawn(
        launcher.command,
        [...launcher.prefixArgs, profileNameFor(agent.id), "--json", "--", TASK],
        {
          cwd: config.workspace,
          windowsHide: true,
          stdio: ["ignore", outFd, errFd],
          env: {
            ...process.env,
            ...launcher.env,
            DSH_HOME: config.dshHome,
            DSH_PERMISSION_MODE: MEMBER_MODE,
            DSH_TELEMETRY_DISABLED: "1",
          },
        },
      );
      closeSync(outFd);
      closeSync(errFd);
      console.log(`  [+${String(Date.now() - t0).padStart(5)}ms] ${agent.name} 启动 pid=${child.pid}`);

      child.on("error", (error) => resolvePromise({ agent, error: error.message, ms: Date.now() - started }));
      child.on("close", (code) =>
        resolvePromise({
          agent,
          code,
          ms: Date.now() - started,
          out: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
          err: existsSync(errPath) ? readFileSync(errPath, "utf8") : "",
        }),
      );
    }, index * STAGGER_MS);
  });
}

const t0 = Date.now();
const results = await Promise.all(AGENTS.map((agent, index) => launch(agent, index)));

const ACL_ERROR = /windows-acl temp grant materialization failed/i;
const SPAWN_ERROR = /spawn (EPERM|EINVAL)/i;

console.log("\n结果：\n");
let aclFailures = 0;
for (const result of results) {
  const blob = `${result.out ?? ""}\n${result.err ?? ""}`;
  const acl = ACL_ERROR.test(blob);
  const spawnErr = SPAWN_ERROR.test(blob);
  if (acl) aclFailures += 1;

  const finalLine = (result.out ?? "")
    .split("\n")
    .find((line) => line.includes('"type":"final"'));
  let summary = "无 final 事件";
  if (finalLine) {
    try {
      summary = String(JSON.parse(finalLine).text ?? "").replace(/\s+/g, " ").slice(0, 90);
    } catch {
      /* 忽略 */
    }
  }

  const verdict = acl ? "✗ 授权失败" : spawnErr ? "✗ 启动被拒" : result.code === 0 ? "✓ 正常" : `△ 退出码 ${result.code}`;
  console.log(`  ${result.agent.name.padEnd(11)} ${verdict.padEnd(12)} ${String(result.ms).padStart(6)}ms  ${summary}`);
}

const verdict = {
  aclFailures,
  total: results.length,
  usable: power.usable,
  conclusion:
    aclFailures > 0
      ? `复现：${aclFailures}/${results.length} 位成员出现临时授权失败。`
      : power.usable
        ? `未复现（受限模式下 ${results.length} 位成员全部正常）——本次证据不支持「并发必然触发」，但样本量 1 轮，不足以宣称竞态不存在。`
        : "无判别力：本轮成员拥有完全权限，0 失败是预期结果，不能作为竞态假说的证据。",
};
writeFileSync(resolve(dir, "run.json"), `${JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), verdict }, null, 2)}\n`, "utf8");

// 指针文件，不是副本：既保住"一眼看到最新一轮在哪"的习惯，又不会变成下一次运行的销毁对象。
try {
  writeFileSync(resolve(root, "LATEST.txt"), `${dir}\n`, "utf8");
} catch {
  /* 忽略 */
}

console.log("");
if (aclFailures > 0) {
  console.log(`✗ ${aclFailures} / ${results.length} 位成员出现临时授权失败（错峰 ${STAGGER_MS}ms）——并发是诱因。`);
} else if (power.usable) {
  console.log(`△ 未复现临时授权失败（受限模式，错峰 ${STAGGER_MS}ms）。样本量 1 轮，尚不足以宣称竞态不存在。`);
} else {
  console.log("○ 无判别力：本轮以 danger-full-access 运行，0 失败是预期结果。");
  console.log("  要检验竞态假说，请让成员运行在受限沙箱下再跑本探针。");
}
console.log(`\n  本轮证据已归档：${dir}`);
console.log("  （每次运行独立目录，不再覆盖上一轮——旧版本会销毁上一次的证据。）\n");
process.exit(aclFailures > 0 ? 1 : 0);
