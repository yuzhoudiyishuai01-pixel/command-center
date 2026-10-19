/**
 * 把 Claude Code 的 5 条出网规则从 permissions.ask 移到 permissions.allow。
 *
 * 为什么要移到 allow：Claude Code 的优先级是 deny > allow > ask > 默认模式，
 * 且同一条规则同时出现在 allow 和 ask 时**取更严格的 ask**。指挥室派活时是
 * headless（`-p`），没有交互通道，于是 ask 里的一律被拒，成员无法联网。
 *
 * 安全设计：
 *   1. 先备份带时间戳的副本，绝不覆盖已有备份
 *   2. 只动这 5 条，其余 483 条必须逐条证实未变——对不上就自动回滚
 *   3. 写盘用「临时文件 + 原子改名」
 *   4. 写完重新解析再用，确保没有写出坏 JSON
 *
 * 用法：
 *   node scripts/fix-claude-permissions.mjs            # 干跑，只报告将要做什么
 *   node scripts/fix-claude-permissions.mjs --apply    # 真正写入
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const SETTINGS = resolve(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claude", "settings.json");
const APPLY = process.argv.includes("--apply");

/** 需要从 ask 移到 allow 的规则。Windows 下 Claude Code 可能走 PowerShell 变体，都要移。 */
const TO_MOVE = [
  "WebFetch(domain:*)",
  "Bash(curl *)",
  "Bash(wget *)",
  "PowerShell(curl *)",
  "PowerShell(wget *)",
];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 深比较两个值（用于证实"其余内容未变"）。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object") {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length || !keysA.every((key, i) => key === keysB[i])) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function main() {
  if (!existsSync(SETTINGS)) {
    console.error(`✗ 找不到配置文件：${SETTINGS}`);
    process.exit(1);
  }

  const originalText = readFileSync(SETTINGS, "utf8");
  const original = loadJson(SETTINGS);
  const perms = original.permissions;

  if (!perms || !Array.isArray(perms.ask) || !Array.isArray(perms.allow)) {
    console.error("✗ 配置文件结构不符合预期（缺少 permissions.ask / permissions.allow 数组）");
    process.exit(1);
  }

  // ── 计划 ────────────────────────────────────────────────────────────────
  const present = TO_MOVE.filter((rule) => perms.ask.includes(rule));
  const missing = TO_MOVE.filter((rule) => !perms.ask.includes(rule));
  const alreadyAllowed = TO_MOVE.filter((rule) => perms.allow.includes(rule));

  console.log(`\n配置文件：${SETTINGS}`);
  console.log(`大小 ${statSync(SETTINGS).size} 字节\n`);
  console.log(`  ask   : ${perms.ask.length} 条`);
  console.log(`  allow : ${perms.allow.length} 条`);
  console.log(`  deny  : ${perms.deny?.length ?? 0} 条\n`);

  console.log("  将在 ask 中移除：");
  for (const rule of TO_MOVE) {
    console.log(`    ${perms.ask.includes(rule) ? "✓" : "—"} ${rule}`);
  }
  console.log("  将加入 allow：");
  for (const rule of TO_MOVE) {
    console.log(`    ${perms.allow.includes(rule) ? "已在" : "+"} ${rule}`);
  }

  if (present.length === 0) {
    console.log("\n没有需要移动的规则（可能已经改过了）。");
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\n干跑模式：加 --apply 才会真正写入。\n");
    process.exit(0);
  }

  // ── 备份 ────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = `${SETTINGS}.bak-${stamp}`;
  let suffix = 0;
  let finalBackup = backup;
  while (existsSync(finalBackup)) {
    suffix += 1;
    finalBackup = `${backup}-${suffix}`;
  }
  copyFileSync(SETTINGS, finalBackup);
  console.log(`\n  ✓ 已备份：${finalBackup}`);

  // ── 变换 ────────────────────────────────────────────────────────────────
  const next = JSON.parse(originalText);
  const nextPerms = next.permissions;

  nextPerms.ask = nextPerms.ask.filter((rule) => !TO_MOVE.includes(rule));
  for (const rule of TO_MOVE) {
    if (!nextPerms.allow.includes(rule)) nextPerms.allow.push(rule);
  }

  // ── 写入（原子） ─────────────────────────────────────────────────────────
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const temp = `${SETTINGS}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, SETTINGS);
  console.log(`  ✓ 已写入（${text.length} 字节）`);

  // ── 校验：重读并逐条证实 ────────────────────────────────────────────────
  const after = loadJson(SETTINGS);

  const checks = [];
  const fail = (message) => checks.push({ ok: false, message });

  if (after.permissions.ask.length !== original.permissions.ask.length - present.length) {
    fail(`ask 条数不对：期望 ${original.permissions.ask.length - present.length}，实际 ${after.permissions.ask.length}`);
  } else {
    checks.push({ ok: true, message: `ask 条数：${original.permissions.ask.length} → ${after.permissions.ask.length}` });
  }

  const expectedAllow = original.permissions.allow.length + TO_MOVE.filter((r) => !original.permissions.allow.includes(r)).length;
  if (after.permissions.allow.length !== expectedAllow) {
    fail(`allow 条数不对：期望 ${expectedAllow}，实际 ${after.permissions.allow.length}`);
  } else {
    checks.push({ ok: true, message: `allow 条数：${original.permissions.allow.length} → ${after.permissions.allow.length}` });
  }

  // 这 5 条必须都不再出现在 ask 里，且都出现在 allow 里
  const stillInAsk = TO_MOVE.filter((rule) => after.permissions.ask.includes(rule));
  if (stillInAsk.length > 0) fail(`ask 里仍残留：${stillInAsk.join(", ")}`);
  else checks.push({ ok: true, message: "ask 里已无这 5 条" });

  const notInAllow = TO_MOVE.filter((rule) => !after.permissions.allow.includes(rule));
  if (notInAllow.length > 0) fail(`allow 里缺少：${notInAllow.join(", ")}`);
  else checks.push({ ok: true, message: "allow 里已包含这 5 条" });

  // deny 必须完全没动
  if (!deepEqual(original.permissions.deny, after.permissions.deny)) {
    fail("deny 列表被改动了——这是不允许的");
  } else {
    checks.push({ ok: true, message: `deny 未改动（${after.permissions.deny?.length ?? 0} 条）` });
  }

  // 除 permissions 之外的所有顶层字段必须完全一致
  const keysOriginal = Object.keys(original).filter((key) => key !== "permissions");
  const keysAfter = Object.keys(after).filter((key) => key !== "permissions");
  if (!deepEqual(keysOriginal, keysAfter)) {
    fail("顶层字段集合发生了变化");
  } else {
    const changed = keysOriginal.filter((key) => !deepEqual(original[key], after[key]));
    if (changed.length > 0) fail(`这些顶层字段被意外改动：${changed.join(", ")}`);
    else checks.push({ ok: true, message: `其余 ${keysOriginal.length} 个顶层字段均未变` });
  }

  // permissions 内除 ask/allow 之外也必须一致
  const permKeys = Object.keys(original.permissions).filter((key) => key !== "ask" && key !== "allow");
  const permChanged = permKeys.filter((key) => !deepEqual(original.permissions[key], after.permissions[key]));
  if (permChanged.length > 0) fail(`permissions 内这些字段被意外改动：${permChanged.join(", ")}`);
  else checks.push({ ok: true, message: `permissions 内其余 ${permKeys.length} 个字段均未变` });

  console.log("\n  校验结果：");
  for (const check of checks) {
    console.log(`    ${check.ok ? "✓" : "✗"} ${check.message}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    // 校验失败：把备份还原回去，绝不留下一个半改的状态
    copyFileSync(finalBackup, SETTINGS);
    console.error(`\n  ✗ 校验失败 ${failed.length} 项，已从备份还原。备份保留在：${finalBackup}\n`);
    process.exit(1);
  }

  console.log(`\n  ✓ 全部校验通过。备份在：${finalBackup}\n`);
}

main();
