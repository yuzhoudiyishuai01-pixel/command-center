#!/usr/bin/env node
/**
 * 归属审计：谁的工作区产物是谁的。
 *
 * 为什么需要它：四位成员共用同一个工作区，而"这是谁的文件"此前**没有任何记录**——
 * 全靠自觉。2026-10-14 已经真的出过事：同一轮的**两个 ChatGPT 回合**各自写报告，
 * 一个用了 `readiness-chatgpt-r2.md`、另一个用 `readiness-chatgpt.md`，
 * 谁都不知道对方存在，差一步就互相覆盖。
 *
 * 本脚本不靠记忆、不靠猜：**从证据推导归属**。
 * 证据源是 `command-center/data/store.json` —— 它记录了每一位成员每一次
 * `write` / `edit` 工具调用的目标路径与发生时刻。
 *
 * 用法：
 *   node scripts/audit-ownership.mjs            # 审计并重写 ownership-ledger.md
 *   node scripts/audit-ownership.mjs --json     # 只输出 JSON
 *
 * 输出：
 *   <workspace>/ownership-ledger.md   人读的台账（本脚本生成，请勿手改）
 *   <dataDir>/ownership.json          机读的台账
 */
import { existsSync, readFileSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, join, basename, extname } from "node:path";

import { config, PROJECT_ROOT } from "../server/config.mjs";
import { AGENTS, CAPABILITY_LABELS } from "../server/agents.mjs";
import { readAnySignature, signText } from "../server/signature.mjs";

const JSON_ONLY = process.argv.includes("--json");

/**
 * 调用者自己的成员 id。
 * 本回合用 write/edit 产出的文件，在回合结束前还不会进 store.json，会被判成"未归属"——
 * 那会让**自己**的产物看起来像别人的。显式声明自己是谁，就能把这批文件正确标注。
 * 默认从 DSH_PROFILE（如 cc-chatgpt）推导，也可用 --self 覆盖。
 */
const selfIndex = process.argv.indexOf("--self");
const SELF =
  (selfIndex !== -1 ? process.argv[selfIndex + 1] : String(process.env.DSH_PROFILE ?? "").replace(/^cc-/, "")) || null;
const SELF_ID = AGENTS.some((a) => a.id === SELF) ? SELF : null;
const SELF_AGENT = AGENTS.find((a) => a.id === SELF_ID) ?? null;

/** 路径归一化：Windows 上 resolve() 给反斜杠，比较时统一成正斜杠小写。 */
const norm = (s) => String(s).toLowerCase().replace(/\\/g, "/");

/** 本工具自己的产物：它当然不属于任何成员，别让它显示成"未归属"。 */
const OUTPUTS = [
  resolve(config.workspace, "ownership-ledger.md"),
  resolve(config.dataDir, "ownership.json"),
].map(norm);

/**
 * 显式申报：`--claim a.md,command-center/data/某个目录`
 * 用于"本回合刚写、证据还没落账"或"用 pwsh 写的"这类没有 write/edit 证据的文件；
 * **给目录即申报该目录下全部内容**。
 * 台账里会标成"（声明）"——**声明与证据是两回事，不混同**。
 */
const claimIndex = process.argv.indexOf("--claim");
const CLAIMS = (claimIndex !== -1 ? String(process.argv[claimIndex + 1] ?? "") : "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => norm(resolve(config.workspace, s)));

/** 公共设施：共享代码与文档。改动规则见台账抬头，归属不归任何单个成员。 */
const SHARED = [
  "command-center/README.md",
  "command-center/cc.config.json",
  "command-center/启动指挥室.cmd",
  "command-center/server/",
  "command-center/public/",
  "command-center/scripts/",
];

// ---------------------------------------------------------------- 证据：谁写过什么

const storePath = resolve(config.dataDir, "store.json");
const store = JSON.parse(readFileSync(storePath, "utf8"));

/** path(小写) -> [{ agent, at, tool, room, turn }] */
const writeEvidence = new Map();
/** path(小写) -> [{ agent, at }] —— pwsh 里推断出的写入，证据强度较低 */
const inferredEvidence = new Map();
/** path(小写) -> [{ agent, at, tool, error }] —— 调用过但**失败**了，对文件没有实际影响 */
const failedAttempts = new Map();

const PWSH_WRITE_HINT = /\b(Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Move-Item|Copy-Item)\b/i;
const PATH_LIKE = /[A-Za-z]:\\[^"'|<>;)\r\n]+|(?:\.{0,2}[\\/])[\w\u4e00-\u9fa5.-]+(?:[\\/][\w\u4e00-\u9fa5.-]+)*/g;

function record(map, path, entry) {
  const key = String(path).trim().toLowerCase();
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

let scannedMessages = 0;
let scannedBlocks = 0;

for (const room of store.rooms ?? []) {
  for (const message of room.messages ?? []) {
    if (message.role !== "agent" || !Array.isArray(message.blocks)) continue;
    scannedMessages += 1;
    for (const block of message.blocks) {
      if (block?.kind !== "tool") continue;
      scannedBlocks += 1;
      const detail = typeof block.detail === "string" ? block.detail.trim() : "";
      if (!detail) continue;

      const base = {
        agent: message.agentId ?? "?",
        at: message.at ?? null,
        room: room.title ?? room.id ?? "?",
        turn: message.turnId ?? null,
      };

      if (block.tool === "write" || block.tool === "edit") {
        // 只把**成功**的调用算作归属证据。
        // 实证教训：2026-10-14 20:59 有一条 deepseek 对 probe-concurrency.mjs 的 edit 记录，
        // 但它的 status 是 error（文件未读取，改动根本没发生）。若把失败调用也算成"最后写入者"，
        // 台账就会**冤枉人**——这恰恰是这套工具最不该犯的错。
        if (block.status === "completed") record(writeEvidence, detail, { ...base, tool: block.tool });
        else record(failedAttempts, detail, { ...base, tool: block.tool, error: String(block.result ?? "").slice(0, 120) });
      } else if (block.tool === "pwsh" && PWSH_WRITE_HINT.test(detail)) {
        for (const hit of detail.match(PATH_LIKE) ?? []) {
          const cleaned = hit.replace(/[",']+$/, "").trim();
          if (cleaned.length < 4) continue;
          if (block.status === "completed") record(inferredEvidence, cleaned, { ...base, tool: "pwsh(推断)" });
          else record(failedAttempts, cleaned, { ...base, tool: "pwsh(推断)", error: String(block.result ?? "").slice(0, 120) });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 现场：工作区里实际有什么

/**
 * 最新一条写入证据的时刻。
 * 用途：**正在进行的回合**，它的 write 调用还没被写进 store.json（回话落账发生在回合结束时），
 * 于是刚产出的文件会显示"未归属"。那不是无主，是"还在飞"——必须区分开，
 * 否则别人可能把这个文件当成无主物处理掉。
 */
const newestEvidenceAt = [...writeEvidence.values(), ...inferredEvidence.values()]
  .flat()
  .map((e) => String(e.at ?? ""))
  .sort()
  .at(-1) ?? null;

function sha256(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function collect(dir, { depth = 1, filter = () => true } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current, level) => {
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
      if (!filter(full)) continue;
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      out.push({
        path: full,
        rel: relative(config.workspace, full).replace(/\\/g, "/"),
        bytes: info.size,
        mtime: info.mtime.toISOString(),
        sha256: sha256(full),
      });
    }
  };
  walk(dir, 0);
  return out;
}

const artifacts = [
  ...collect(config.workspace, { depth: 0 }),
  ...collect(config.dataDir, { depth: 0 }),
  ...collect(resolve(config.dataDir, "concurrency"), {
    depth: 2,
    filter: (p) => !basename(p).endsWith(".err.log"),
  }),
];

// ---------------------------------------------------------------- 判定

function isShared(rel) {
  return SHARED.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

function judge(artifact) {
  const candidates = [
    artifact.path,
    artifact.path.replace(/\//g, "\\"),
    artifact.rel,
    `command-center/${artifact.rel}`,
  ].map((p) => p.toLowerCase());

  let evidence = [];
  let strength = "无";
  for (const key of candidates) {
    if (writeEvidence.has(key)) {
      evidence = writeEvidence.get(key);
      strength = "强（write/edit 直接记录）";
      break;
    }
  }
  if (evidence.length === 0) {
    for (const key of candidates) {
      if (inferredEvidence.has(key)) {
        evidence = inferredEvidence.get(key);
        strength = "弱（pwsh 命令里推断）";
        break;
      }
    }
  }

  const agents = [...new Set(evidence.map((e) => e.agent))];
  const last = evidence    .slice()
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .at(-1);

  const selfPath = norm(artifact.path);
  const claimed = CLAIMS.some((c) => selfPath === c || selfPath.startsWith(c.endsWith("/") ? c : `${c}/`));

  let status;
  if (OUTPUTS.includes(selfPath)) status = "本工具生成";
  else if (isShared(artifact.rel)) status = "公共设施";
  else if (agents.length > 1) status = "⚠ 多人写过（争议）";
  else if (agents.length === 1) status = `归属 ${agents[0]}`;
  // 申报只在**没有工具证据**时生效：证据优先于声明，声明不得盖过证据。
  else if (claimed) status = `归属 ${SELF_ID ?? "声明者"}（声明）`;
  else status = "未归属";

  // 产出时间晚于最新写入证据 → 大概率是某个还在跑的回合刚写的，不是无主物。
  const inFlight = status === "未归属" && newestEvidenceAt !== null && artifact.mtime > newestEvidenceAt;
  if (inFlight) status = "未归属（回合进行中）";

  // 调用者自己的在飞产出：文件名带自己的 id 前缀时认领，避免"自己的东西看起来像别人的"。
  const mine = inFlight && SELF_ID !== null && artifact.rel.toLowerCase().includes(SELF_ID);
  if (mine) status = `归属 ${SELF_ID}（在飞，证据未落账）`;

  // 署名：正文里的成员标识（见 server/signature.mjs）。这是**自证**，与工具证据互为交叉校验。
  // 两种格式都认：cc-sign（带正文指纹，可检测篡改）与 YAML 头 author（基础格式）。
  let signedBy = null;
  let signatureCode = null;
  let signatureFormat = null;
  if ([".md", ".txt"].includes(extname(artifact.path).toLowerCase())) {
    try {
      const signature = readAnySignature(readFileSync(artifact.path, "utf8"));
      signedBy = signature?.member ?? null;
      signatureCode = signature?.code ?? null;
      signatureFormat = signature?.format ?? null;
    } catch {
      /* 读不了就不报署名状态 */
    }
  }

  return {
    ...artifact,
    status,
    inFlight,
    mine,
    evidenceStrength: strength,
    lastWriter: last?.agent ?? null,
    lastWriteAt: last?.at ?? null,
    writers: agents,
    signedBy,
    signatureCode,
    // 交叉校验：署名成员与工具证据/文件名标识是否指向同一个人。
    signatureMismatch:
      signedBy !== null && agents.length === 1 && agents[0] !== signedBy
        ? `${agents[0]} → 署名却是 ${signedBy}`
        : null,
  };
}

const judged = artifacts.map(judge).sort((a, b) => b.mtime.localeCompare(a.mtime));

/** 公共设施的改动记录：共享代码也要留痕，否则没人知道谁刚动过它。 */
const sharedPrefixes = SHARED.map((s) => resolve(config.workspace, s).toLowerCase().replace(/\\/g, "/"));
const sharedChanges = new Map();
for (const [key, entries] of writeEvidence) {
  const normalized = key.replace(/\\/g, "/");
  if (!sharedPrefixes.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || normalized.startsWith(prefix))) {
    continue;
  }
  // 同一回合里对同一文件的多次 edit 共用回合时间戳，逐条列出只会刷屏。
  // 按「文件 + 成员 + 回合」折叠，只保留该回合的最后一次。
  for (const entry of entries) {
    const dedupeKey = `${key}|${entry.agent}|${entry.turn}`;
    const previous = sharedChanges.get(dedupeKey);
    if (!previous || String(entry.at) >= String(previous.at)) sharedChanges.set(dedupeKey, { path: key, ...entry });
  }
}
const recentSharedChanges = [...sharedChanges.values()]
  .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  .slice(0, 12);

/**
 * 失败的改动尝试：**对文件没有实际影响**，但值得记一笔——
 * 它说明有人想动这个文件却没成功（多半是拿旧内容去 edit）。
 * 单列出来，是为了避免两种误读：既不冤枉人（失败≠改了），也不漏掉冲突意图。
 */
const failedList = [...failedAttempts.entries()]
  .flatMap(([path, entries]) => entries.map((entry) => ({ path, ...entry })))
  .sort((a, b) => String(b.at).localeCompare(String(a.at)));
const recentFailed = [];
const seenFailed = new Set();
for (const item of failedList) {
  const key = `${item.path}|${item.agent}|${item.turn}`;
  if (seenFailed.has(key)) continue;
  seenFailed.add(key);
  recentFailed.push(item);
  if (recentFailed.length >= 8) break;
}

// ---------------------------------------------------------------- 输出

const ledgerPath = resolve(config.workspace, "ownership-ledger.md");
const jsonPath = resolve(config.dataDir, "ownership.json");

const payload = {
  generatedAt: new Date().toISOString(),
  generatedBy: SELF_ID,
  evidence: { store: storePath, messagesScanned: scannedMessages, toolBlocksScanned: scannedBlocks },
  sharedPaths: SHARED,
  artifacts: judged,
};

writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const line = (a) => {
  const signature = a.signedBy
    ? a.signatureCode === "BODY_CHANGED"
      ? `⚠ ${a.signedBy}（署名后被改动）`
      : a.signatureFormat === "front-matter"
        ? `✔ ${a.signedBy}（基础格式）`
        : `✔ ${a.signedBy}`
    : a.rel.endsWith(".md") || a.rel.endsWith(".txt")
      ? "✖ 无署名"
      : "－";
  return `| \`${a.rel}\` | ${a.status} | ${signature} | ${a.lastWriter ?? "—"} | ${(a.lastWriteAt ?? "—").replace("T", " ").slice(0, 19)} | ${a.bytes} B | ${a.sha256 ?? "—"} |`;
};

const md = `# 工作区归属台账

> **本文件由 \`command-center/scripts/audit-ownership.mjs\` 生成，请勿手改**——改了也会被下一次审计覆盖。
> 生成时间：${payload.generatedAt}
> 证据源：\`store.json\`（已扫描 ${scannedMessages} 条成员回话、${scannedBlocks} 次工具调用）
> 归属从**工具调用记录**推导，不是凭印象；"未归属"= 没有 write/edit 证据，**不等于无主**。

---

## 一、成员名册（名册来源：\`server/agents.mjs\`）

| 成员 | 定位 | 能力 |
| --- | --- | --- |
${AGENTS.map(
  (a) => `| **${a.name}** | ${a.role} | ${(a.capabilities ?? []).map((c) => CAPABILITY_LABELS[c] ?? c).join(" · ")} |`,
).join("\n")}

**成员之间没有直接对话通道**（当前由指挥官显式派发）。所以"认识同僚"只能靠共享文件：
名册看这里，归属看第三节，边界看下面的公约。

---

## 二、协作边界公约（四位成员共同遵守）

1. **每条痕迹都要带自己的标识（署名）**，两道一起：
   - **文件名带成员 id**：\`readiness-<你的名字>.md\`、\`<你的名字>-*\`，或放进 \`members/<你的名字>/\`；
   - **文件内盖章**：成员文档（\`.md\` / \`.txt\`）开头必须有署名块。
     盖章命令：\`node scripts/artifact-sign.mjs sign --file <你的文件>\`（自动写入成员、会话、正文指纹）。
     自查：\`node scripts/artifact-sign.mjs check\`。
   **不覆盖他人的同名产出**：同一轮多次产出用 \`-r2\` / \`-r3\` 后缀——**历史本身是证据，不覆盖历史**。
   > 署名块里的 \`body-sha256\` 是正文指纹：**署名之后被别人改动是可检测的**。这就是署名要防的事。
2. **"未归属"的文件一律当作他人的**：只读。不删、不改、不移动。
   要清理先在指挥部点名申请，得到授权再动手。
3. **公共设施**（\`server/\`、\`public/\`、\`scripts/\`、\`cc.config.json\`、\`README.md\`、\`启动指挥室.cmd\`）
   是共享代码：改动前在指挥部声明，改动后留**可回滚说明 + 验证证据**。
4. **证据目录只增不删**：\`data/runs/\`、\`data/concurrency/\`。
   已经被别人引用过哈希的文件，**不要移动或改名**（移动会让对方的引用失效）。
5. **探针/临时文件带成员名前缀**，用完自删；不要在工作区根目录留无主探针。

---

## 三、公共设施（改动需声明）

${SHARED.map((s) => `- \`${s}\``).join("\n")}

### 最近有证据的公共设施改动（最后 ${recentSharedChanges.length} 条）

${
  recentSharedChanges.length === 0
    ? "无记录。"
    : `| 文件 | 成员 | 时间（UTC） | 工具 |\n| --- | --- | --- | --- |\n${recentSharedChanges
        .map(
          (c) =>
            `| \`${relative(config.workspace, c.path).replace(/\\/g, "/")}\` | ${c.agent} | ${String(c.at).replace("T", " ").slice(0, 19)} | ${c.tool} |`,
        )
        .join("\n")}`
}

> 注意：这里只含 \`write\`/\`edit\` **成功**调用的证据。**用 \`pwsh\` 改的文件不会出现在此表**——
> 那类改动没有可信归属，需要改动者自己声明。这也是公约第 3 条要求"改动前先声明"的原因。

### 失败的改动尝试（对文件没有实际影响，只作记录）

${
  recentFailed.length === 0
    ? "无。"
    : `| 文件 | 成员 | 时间（UTC） | 工具 | 失败原因（截断） |\n| --- | --- | --- | --- | --- |\n${recentFailed
        .map(
          (c) =>
            `| \`${relative(config.workspace, c.path).replace(/\\/g, "/")}\` | ${c.agent} | ${String(c.at).replace("T", " ").slice(0, 19)} | ${c.tool} | ${(c.error ?? "").replace(/\|/g, "/").slice(0, 60)} |`,
        )
        .join("\n")}`
}

> 记账口径：**只有 \`status=completed\` 的调用才算"写入证据"**。失败调用改动没有落地，
> 把它算成"最后写入者"会**冤枉人**——本表就是为此单列出来的。

---

## 四、产物台账（按最后修改时间倒序）

| 文件 | 判定 | 署名 | 最后写入者 | 最后写入（UTC） | 大小 | SHA256(前16) |
| --- | --- | --- | --- | --- | --- | --- |
${judged.map(line).join("\n")}

---

## 五、需要人看一眼的

${
  judged.filter((a) => a.status.startsWith("⚠") || a.status.startsWith("未归属") || a.signatureMismatch).length === 0
    ? "无。所有产物都有单一证据归属。"
    : judged
        .filter((a) => a.status.startsWith("⚠") || a.status.startsWith("未归属") || a.signatureMismatch)
        .map((a) => {
          if (a.signatureMismatch) {
            return `- \`${a.rel}\` —— **署名与归属不一致**：工具证据指向 ${a.signatureMismatch}。这是"张冠李戴"的典型形态，请当事人核实。`;
          }
          if (a.inFlight) {
            return `- \`${a.rel}\` —— **回合进行中**：产出时间晚于最新一条写入证据（${String(newestEvidenceAt).replace("T", " ").slice(0, 19)} UTC）。这是**某个还在跑的回合**刚写的，**不是无主物，别动**；本回合结束后重新生成台账即可看到归属。`;
          }
          if (a.writers.length > 1) {
            return `- \`${a.rel}\` —— **⚠ 多人写过**（${a.writers.join("、")}），属潜在互相覆盖，建议确认谁才是它的主人。`;
          }
          return `- \`${a.rel}\` —— **未归属**：没有 \`write\`/\`edit\` 证据（可能是 \`pwsh\` 生成的）。按公约第 2 条，**当他人产物处理**。`;
        })
        .join("\n")
}

> **在飞产出 / 无证据产出**：回合结束前，本回合的 \`write\`/\`edit\` 还没进 \`store.json\`，会被判成"未归属"；
> 用 \`pwsh\` 生成的文件则**永远没有**可信证据。两种情况都用显式申报落名：
> \`node scripts/audit-ownership.mjs --self <成员 id> --claim <你的文件>[,<更多>]\`
> —— \`--self\` 默认可从 \`DSH_PROFILE\` 推导；\`--claim\` 是**声明**，台账标"（声明）"，
> 与工具证据严格区分，**不冒充证据**。
> 本次调用者身份：**${SELF_ID ?? "未识别（请用 --self 指定）"}**${CLAIMS.length ? ` · 已申报 ${CLAIMS.length} 项` : ""}

未经署名的成员文档共 **${judged.filter((a) => a.signedBy === null && (a.rel.endsWith(".md") || a.rel.endsWith(".txt"))).length}** 份
（逐项原因跑 \`node scripts/artifact-sign.mjs check\`）。这些是**旧产物，不强制改名或补章**——
补章请由**作者本人**执行，别人代盖就是伪造归属。

---

*重新生成：\`node scripts/audit-ownership.mjs\`（在 \`command-center/\` 下运行）*
`;

// 台账自己也要署名：它是"谁在什么时候做的这次审计"，没有署名就又是一份无主产物。
if (!JSON_ONLY) {
  writeFileSync(
    ledgerPath,
    signText(md, {
      member: SELF_ID ?? "unattributed",
      name: SELF_AGENT?.name ?? "归属审计器",
      role: SELF_AGENT?.role ?? "工具生成",
      session: process.env.DSH_SESSION_ID ?? "",
      "signed-at": new Date().toISOString(),
    }),
    "utf8",
  );
}

const tally = judged.reduce((acc, a) => {
  const key = a.status.startsWith("⚠") ? "争议" : a.status;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

console.log(`\n归属审计完成 · 证据源 ${basename(storePath)}（${scannedMessages} 条回话 / ${scannedBlocks} 次工具调用）`);
console.log(`  台账  ${JSON_ONLY ? "（仅 JSON）" : ledgerPath}`);
console.log(`  机读  ${jsonPath}\n`);
for (const artifact of judged.slice(0, 24)) {
  console.log(
    `  ${artifact.rel.padEnd(46)} ${artifact.status.padEnd(18)} ${(artifact.lastWriter ?? "—").padEnd(11)} ${artifact.bytes} B`,
  );
}
console.log(`\n  合计 ${judged.length} 项：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ")}\n`);
