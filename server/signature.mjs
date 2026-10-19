/**
 * 产物署名（成员标识）的唯一实现。
 *
 * 为什么需要：四位成员共用一个工作区，"这个文件是谁的"此前只能靠文件名猜。
 * 2026-10-14 真的差点出事：同一轮的两个 ChatGPT 回合各写各的报告，互不知情。
 * 文件名相似就会撞车；而**署名块写在文件里**，改名、复制、移动都无法伪造归属。
 *
 * 署名格式（HTML 注释，Markdown 渲染时不可见，原文里可检索）：
 *
 *   <!-- cc-sign
 *   member: chatgpt
 *   name: ChatGPT
 *   role: 工程实现 · 方案设计
 *   session: session-xxxx
 *   turn: turn-xxxx
 *   signed-at: 2026-10-14T13:02:11.123Z
 *   body-sha256: 1a2b3c4d5e6f7788
 *   -->
 *
 * `body-sha256` 是**去掉署名块之后的正文**的哈希：因此"署名之后又被别人改过"
 * 是可检测的——这正是署名要防的事。
 *
 * 用法（其他脚本 / 成员工具复用本模块，不要在别处重复实现）：
 *   import { signText, verifyText, readSignature, stripSignature } from "../server/signature.mjs";
 */
import { createHash } from "node:crypto";

/** 允许被签名的文本类型；二进制/JSON 走文件名标识，不写注释块。 */
export const SIGNABLE_EXTENSIONS = [".md", ".txt", ".tsv", ".log", ".yml", ".yaml", ".mjs", ".js", ".jsonc"];

export const SIGNATURE_FIELDS = ["member", "name", "role", "session", "turn", "signed-at", "body-sha256"];

const BLOCK = /<!--\s*cc-sign\r?\n([\s\S]*?)\r?\n-->\r?\n?/;

export function stripSignature(text) {
  return String(text).replace(BLOCK, "");
}

export function readSignature(text) {
  const match = String(text).match(BLOCK);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

/** 正文指纹：始终基于"去掉署名块"的内容，因此重复签名是幂等的。 */
export function bodyHash(text) {
  return createHash("sha256").update(stripSignature(text), "utf8").digest("hex").slice(0, 16);
}

export function buildSignature(fields) {
  const lines = SIGNATURE_FIELDS.filter((key) => fields[key] !== undefined && fields[key] !== null && fields[key] !== "").map(
    (key) => `${key}: ${fields[key]}`,
  );
  return `<!-- cc-sign\n${lines.join("\n")}\n-->\n`;
}

/** 盖章：署名块一律放在文件最前面，正文原样保留。重复调用不会叠加署名块。 */
export function signText(text, fields) {
  const body = stripSignature(text);
  return buildSignature({ ...fields, "body-sha256": bodyHash(body) }) + body;
}

/**
 * 验章。返回 { ok, code, signature }：
 *   NO_SIGNATURE   没有署名块
 *   MEMBER_MISMATCH 署名成员与期望成员不符
 *   BODY_CHANGED   署名之后正文被改过（body-sha256 不符）
 *   OK             通过
 */
export function verifyText(text, { member } = {}) {
  const signature = readSignature(text);
  if (!signature) return { ok: false, code: "NO_SIGNATURE", signature: null };
  if (member && signature.member !== member) return { ok: false, code: "MEMBER_MISMATCH", signature };
  if (signature["body-sha256"] !== bodyHash(text)) return { ok: false, code: "BODY_CHANGED", signature };
  return { ok: true, code: "OK", signature };
}

/**
 * 基础格式：YAML 头里的 `author:`（DeepSeek 在 `AGENT-CONVENTIONS.md` 里起草的方案）。
 *
 * 为什么要认它：2026-10-14 指挥官下令"每条痕迹都要有署名"之后，**两位成员各自起草了格式**——
 * 本模块的 `<!-- cc-sign -->`（带正文指纹）与 YAML 头（不带）。硬推自己那一套 = 制造新冲突。
 * 所以本工具**两种都认**，只在能力上如实区分：
 *
 *   强格式（cc-sign）：能检测"署名之后被改动"（body-sha256）
 *   基础格式（front-matter）：只能证明"谁声称是自己写的"，**无法检测后续篡改**
 *
 * 新产物建议用强格式；已有 YAML 头的文件**不要求改写**。
 */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function readFrontMatterAuthor(text) {
  const match = String(text).match(FRONT_MATTER);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (!fields.author) return null;
  return { member: fields.author, format: "front-matter", fields };
}

/** 统一读章：返回 { member, format, ... }，兼容两种格式；都没有则 null。 */
export function readAnySignature(text) {
  const strong = readSignature(text);
  if (strong) {
    const verify = verifyText(text, {});
    return {
      member: strong.member,
      format: "cc-sign",
      tamperProof: true,
      intact: verify.code !== "BODY_CHANGED",
      code: verify.code,
      signedAt: strong["signed-at"] ?? null,
      raw: strong,
    };
  }
  const basic = readFrontMatterAuthor(text);
  if (basic) {
    return {
      member: basic.member,
      format: "front-matter",
      tamperProof: false,
      intact: null,
      code: "OK_BASIC",
      signedAt: basic.fields.created ?? null,
      raw: basic.fields,
    };
  }
  return null;
}

/** 从文件名判断署名标识：文件名里含成员 id，或位于 members/<id>/ 下。 */export function signatureFromName(relPath, memberIds) {
  const normalized = String(relPath).replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").at(-1) ?? "";
  const inNamespace = memberIds.find((id) => normalized.startsWith(`members/${id}/`) || normalized.includes(`/members/${id}/`));
  if (inNamespace) return { ok: true, member: inNamespace, how: "命名空间目录" };
  const inName = memberIds.find((id) => base.includes(id));
  if (inName) return { ok: true, member: inName, how: "文件名" };
  return { ok: false, member: null, how: null };
}
