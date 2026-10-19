#!/usr/bin/env node
/**
 * 产物署名工具：给自己的产出盖章，并校验全工作区的署名合规性。
 *
 * 解决的问题：四位成员共用一个工作区，靠文件名猜归属会撞车。
 * 现在要求**每条痕迹都带自己的标识**，两道：文件名带成员 id（或放进 members/<id>/），
 * 以及文件内的署名块（见 server/signature.mjs 的格式说明）。
 *
 * 用法：
 *   node scripts/artifact-sign.mjs sign --file readiness-chatgpt.md [--self chatgpt]
 *   node scripts/artifact-sign.mjs sign --file a.md --file b.md
 *   node scripts/artifact-sign.mjs check            # 扫描并报告违规
 *   node scripts/artifact-sign.mjs check --json
 *
 * 退出码：check 有违规 → 1。
 */
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { config } from "../server/config.mjs";
import { AGENTS } from "../server/agents.mjs";
import { SIGNABLE_EXTENSIONS, readAnySignature, signText, verifyText, signatureFromName } from "../server/signature.mjs";

const args = process.argv.slice(2);
const command = args[0];
const MEMBER_IDS = AGENTS.map((a) => a.id);

/** 取某个开关的全部值：支持重复出现（`--file a.md --file b.md`）。 */
function flag(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== `--${name}`) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j += 1) values.push(args[j]);
  }
  return values;
}

const SELF =
  (flag("self")[0] ?? String(process.env.DSH_PROFILE ?? "").replace(/^cc-/, "")) || null;
const SELF_AGENT = AGENTS.find((a) => a.id === SELF) ?? null;

const JSON_ONLY = args.includes("--json");

// ---------------------------------------------------------------- 扫工作区产物

/** 公共设施与运行数据不要求成员署名：它们是共享/自动生成的，改动留痕走归属台账。 */
const SKIP_PREFIXES = ["command-center/server/", "command-center/public/", "command-center/scripts/", "command-center/README.md", "command-center/cc.config.json", "command-center/启动指挥室.cmd"];

function collect(dir, { depth = 1 } = {}) {
  const out = [];
  const walk = (current, level) => {
    if (!existsSync(current)) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (level < depth) walk(full, level + 1);
        continue;
      }
      out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

const files = [
  ...collect(config.workspace, { depth: 0 }),
  ...collect(config.dataDir, { depth: 0 }),
  ...collect(resolve(config.dataDir, "concurrency"), { depth: 2 }),
];

const artifacts = files
  .map((full) => ({ path: full, rel: relative(config.workspace, full).replace(/\\/g, "/") }))
  .filter((a) => !SKIP_PREFIXES.some((p) => a.rel === p || a.rel.startsWith(p)))
  .filter((a) => !a.rel.startsWith("command-center/runtime/"))
  .sort((a, b) => a.rel.localeCompare(b.rel));

// ---------------------------------------------------------------- sign

function doSign() {
  const targets = flag("file");
  if (targets.length === 0) {
    console.error("用法：node scripts/artifact-sign.mjs sign --file <路径> [--self chatgpt]");
    process.exit(2);
  }
  if (!SELF_AGENT) {
    console.error(`未识别成员身份：请用 --self <${MEMBER_IDS.join("|")}> 指定。`);
    process.exit(2);
  }

  for (const target of targets) {
    const full = resolve(config.workspace, target);
    if (!existsSync(full)) {
      console.error(`  ✗ 不存在：${target}`);
      process.exitCode = 1;
      continue;
    }
    if (!SIGNABLE_EXTENSIONS.includes(extname(full).toLowerCase())) {
      console.error(`  ✗ 不支持署名的类型（${extname(full)}）：${target}——这类文件靠文件名带成员标识。`);
      process.exitCode = 1;
      continue;
    }
    const before = readFileSync(full, "utf8");
    const nameCheck = signatureFromName(relative(config.workspace, full).replace(/\\/g, "/"), MEMBER_IDS);
    const signed = signText(before, {
      member: SELF_AGENT.id,
      name: SELF_AGENT.name,
      role: SELF_AGENT.role,
      session: process.env.DSH_SESSION_ID ?? "",
      turn: flag("turn")[0] ?? "",
      "signed-at": new Date().toISOString(),
    });
    writeFileSync(full, signed, "utf8");
    const verify = verifyText(readFileSync(full, "utf8"), { member: SELF_AGENT.id });
    console.log(`  ✓ 已署名 ${target}`);
    console.log(`      署名成员  ${SELF_AGENT.name}（${SELF_AGENT.id}） · 正文指纹 ${verify.signature["body-sha256"]}`);
    if (!nameCheck.ok) {
      console.log(
        `      ⚠ 文件名里没有成员标识：建议改名为含「${SELF_AGENT.id}」的形式，或放进 members/${SELF_AGENT.id}/。` +
          `\n        （不强制改名为的是不破坏别人已引用的路径；新产物请从一开始就带标识。）`,
      );
    }
  }
}

// ---------------------------------------------------------------- check

/**
 * 分层策略——一刀切只会刷屏，没人会看：
 *   doc  （.md/.txt）：成员文档，**必须**有署名块；文件名标识缺失只告警（不强制改名，见 sign 的说明）
 *   code （.mjs/.ps1/.py/.js/.cmd）：源码，文件名标识缺失告警；不要求在代码里塞注释块
 *   数据/工具产物（data/ 下、.log/.tsv/.json/.yml/.out/.err）：**不适用**——它们的归属靠归档目录名与归属台账
 */
function policyFor(rel, ext) {
  if (rel.startsWith("command-center/data/")) return { bucket: "na", reason: "运行数据/证据产物（归属见归档目录名与台账）" };
  if ([".md", ".txt"].includes(ext)) return { bucket: "doc" };
  if ([".mjs", ".js", ".cjs", ".ps1", ".py", ".cmd", ".bat"].includes(ext)) return { bucket: "code" };
  if ([".log", ".tsv", ".json", ".yml", ".yaml", ".out", ".err"].includes(ext)) return { bucket: "na", reason: "工具/数据产物" };
  return { bucket: "na", reason: "非文档类型" };
}

function doCheck() {
  const results = artifacts.map((artifact) => {
    const ext = extname(artifact.path).toLowerCase();
    const policy = policyFor(artifact.rel, ext);
    const nameCheck = signatureFromName(artifact.rel, MEMBER_IDS);

    let signature = null;
    if (policy.bucket !== "na") {
      try {
        signature = readAnySignature(readFileSync(artifact.path, "utf8"));
      } catch {
        /* 读不了就只报文件名问题 */
      }
    }

    const violations = [];
    const warnings = [];
    if (policy.bucket === "doc") {
      if (!signature) violations.push("成员文档缺少署名块");
      else if (signature.format === "cc-sign" && signature.intact === false) violations.push("署名之后正文被改动");
      else if (signature.format === "front-matter") {
        warnings.push("用的是 YAML 头署名（基础格式，无正文指纹，检测不出署名后的篡改）");
      }
      if (signature && nameCheck.ok && signature.member !== nameCheck.member) {
        violations.push(`署名(${signature.member}) 与文件名标识(${nameCheck.member}) 不一致`);
      }
      if (!nameCheck.ok) warnings.push("文件名不含成员标识（建议；不强制改名以免打断已引用该路径的同伴）");
    } else if (policy.bucket === "code") {
      if (!nameCheck.ok) warnings.push("文件名不含成员标识");
    }

    return {
      rel: artifact.rel,
      bucket: policy.bucket,
      reason: policy.reason ?? null,
      bytes: statSync(artifact.path).size,
      nameMember: nameCheck.member,
      signedBy: signature?.member ?? null,
      signatureFormat: signature?.format ?? null,
      signedAt: signature?.signedAt ?? null,
      signatureOk: signature ? signature.code === "OK" || signature.code === "OK_BASIC" : null,
      violations,
      warnings,
    };
  });

  const violations = results.filter((r) => r.violations.length > 0);
  const warnings = results.filter((r) => r.violations.length === 0 && r.warnings.length > 0);
  const na = results.filter((r) => r.bucket === "na");
  const clean = results.filter((r) => r.violations.length === 0 && r.warnings.length === 0 && r.bucket !== "na");

  if (JSON_ONLY) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), self: SELF, results }, null, 2));
  } else {
    console.log(`\n署名校验 · ${results.length} 项产物`);
    console.log(
      `  合规 ${clean.length} · 违规 ${violations.length} · 告警 ${warnings.length} · 不适用 ${na.length}`,
    );
    console.log(`  校验者：${SELF_AGENT ? `${SELF_AGENT.name}（${SELF_AGENT.id}）` : "未识别"}\n`);

    if (violations.length > 0) {
      console.log("  ✗ 违规（必须处理）：");
      for (const item of violations) console.log(`      ${item.rel}\n        ${item.violations.join(" · ")}`);
    }
    if (warnings.length > 0) {
      console.log("\n  ⚠ 告警（建议，不阻断）：");
      for (const item of warnings) console.log(`      ${item.rel.padEnd(48)} ${item.warnings.join(" · ")}`);
    }
    if (clean.length > 0) {
      console.log("\n  ✓ 合规：");
      for (const item of clean) {
        const who = item.signedBy
          ? `署名=${item.signedBy}${item.signatureFormat === "front-matter" ? "（基础格式）" : ""}`
          : `文件名标识=${item.nameMember}`;
        console.log(`      ${item.rel.padEnd(48)} ${who}${item.signedAt ? ` @${item.signedAt.slice(0, 19)}` : ""}`);
      }
    }
    if (na.length > 0) {
      console.log(`\n  － 不适用 ${na.length} 项（工具/数据产物，归属走归档目录名与归属台账）`);
    }
    console.log("");
  }

  if (violations.length > 0) process.exitCode = 1;
}

if (command === "sign") doSign();
else if (command === "check") doCheck();
else {
  console.error("用法：node scripts/artifact-sign.mjs <sign|check> [...]");
  process.exit(2);
}
