/**
 * 成员注册表：成员是**数据**，不是代码。
 *
 * 开源版本里这条线很重要：项目不再内置"不可删除的成员"，而是在首次启动时
 * 把 seeds/members.seed.json 播种到 data/members.json，之后一切以数据文件为准。
 * 用户可以随意增删改——包括把默认那四位删光，换成自己的成员。
 *
 * 为什么默认名册仍然随项目发布：新用户克隆下来总得有东西可试，"四张白纸"
 * 的学习成本太高。但它是**种子**，不是特权：删掉不会再自动长回来。
 *
 * 后端类型（backend）：
 *   dsh        —— 内置 DeepSeek Harness 一次性运行器（有工具能力，需 dsh CLI）
 *   claude-cli —— Claude Code CLI（有工具能力，需 claude CLI）
 *   codex-cli  —— Codex CLI（有工具能力，需 codex CLI）
 *   openai-api —— OpenAI 兼容 Chat Completions（纯对话）
 *   anthropic-api —— Anthropic Messages（纯对话）
 *
 * 密钥永远不进 data/members.json：它们存在 secrets.json（gitignored）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config } from "./config.mjs";
import { persistApiKey, removeApiKey } from "./secrets-store.mjs";

const STORE_PATH = resolve(config.dataDir, "members.json");
const SEED_PATH = resolve(config.projectRoot, "seeds", "members.seed.json");
const FILE_VERSION = 2;

/** 允许的后端类型，以及它是否具备"动手"能力。 */
export const BACKEND_KINDS = {
  dsh: { label: "DSH 内置", toolCapable: true, kind: "cli" },
  "claude-cli": { label: "Claude Code", toolCapable: true, kind: "cli" },
  "codex-cli": { label: "Codex", toolCapable: true, kind: "cli" },
  "openai-api": { label: "OpenAI 兼容 API", toolCapable: false, kind: "api" },
  "anthropic-api": { label: "Anthropic API", toolCapable: false, kind: "api" },
};

let cache = null;

function readSeedMembers() {
  try {
    const parsed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
    return Array.isArray(parsed?.members) ? parsed.members : [];
  } catch {
    // 种子文件坏了不该阻塞启动：空名册也能用（界面里会引导添加成员）。
    return [];
  }
}

/**
 * 读 data/members.json；不存在时按种子播种。
 *
 * 播种只发生一次。之后即使名册被删空，也不会再自动长回来——这是用户的决定。
 */
function loadMembers() {
  if (cache !== null) return cache;

  if (!existsSync(STORE_PATH)) {
    const seeded = readSeedMembers().map((member) => ({ ...member, seed: true }));
    cache = seeded;
    try {
      saveMembers(seeded);
    } catch (error) {
      console.error(`[members] 播种默认名册失败：${error.message}`);
    }
    return cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    // 兼容早期版本：数组形式 / {members:[...]}
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.members) ? parsed.members : [];

    // 老版本把"内置成员"写在代码里，members.json 只存自定义成员。升级到开源版
    // 之后内置不再存在，如果只读文件，用户会突然失去默认那四位成员。
    // 所以 version < 2 时做一次合并：种子成员 + 旧自定义成员（同 id 以旧自定义为准）。
    if (!Array.isArray(parsed) && parsed?.version !== FILE_VERSION) {
      const seed = readSeedMembers().map((member) => ({ ...member, seed: true }));
      const custom = list.map((member) => ({ ...member, seed: member.seed ?? Boolean(member.builtin), builtin: undefined }));
      const merged = new Map(seed.map((member) => [member.id, member]));
      for (const member of custom) merged.set(member.id, member);
      const result = [...merged.values()];
      console.log(`  ▸ 成员迁移  旧版名册已升级：种子 ${seed.length} 位 + 自定义 ${custom.length} 位`);
      saveMembers(result);
      return cache;
    }

    cache = list.map((member) => ({
      ...member,
      // 老数据里的 builtin 标记统一改成 seed（只表示"来自种子"，不再有特权）
      seed: member.seed ?? Boolean(member.builtin),
      builtin: undefined,
    }));
  } catch (error) {
    const broken = `${STORE_PATH}.broken-${Date.now()}`;
    try {
      renameSync(STORE_PATH, broken);
      console.error(`[members] members.json 解析失败，已备份到 ${broken}：${error.message}`);
    } catch {
      console.error(`[members] members.json 解析失败：${error.message}`);
    }
    cache = [];
  }
  return cache;
}

/** 原子写盘，避免进程被杀时留下半个文件。 */
function saveMembers(members) {
  mkdirSync(config.dataDir, { recursive: true });
  const temp = `${STORE_PATH}.${randomUUID().slice(0, 8)}.tmp`;
  const payload = { version: FILE_VERSION, members: members.map((member) => ({ ...member, builtin: undefined })) };
  writeFileSync(temp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(temp, STORE_PATH);
  cache = members;
}

/** 全部成员。顺序即界面顺序。 */
export function allMembers() {
  return loadMembers();
}

/** 按 id 取成员。 */
export function memberById(id) {
  return allMembers().find((member) => member.id === id);
}

/** 某成员使用的后端类型。 */
export function backendOf(member) {
  return member?.backend ?? "openai-api";
}

/**
 * 把名称转成 **ASCII 安全** 的 id。
 *
 * 为什么强制 ASCII：id 会进 URL 路径、文件名，以及（对 DSH 后端）profile 目录名。
 * 纯中文名称会被转成 `member-<短哈希>`：既保持唯一，又不含不可控字符。
 */
export function slugify(name) {
  const raw = String(name ?? "").trim();
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (ascii.length >= 2) return ascii.slice(0, 24);

  let hash = 0;
  for (const char of raw) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `member-${hash.toString(36).slice(0, 6)}`;
}

/** 校验并规范化一个新成员的输入。返回 { member, apiKey } 或 { error }。 */
export function normalizeNewMember(input) {
  const name = String(input?.name ?? "").trim();
  if (!name) return { error: "成员名称不能为空。" };
  if (name.length > 24) return { error: "成员名称最多 24 个字符。" };

  const backend = String(input?.backend ?? "openai-api");
  if (!BACKEND_KINDS[backend]) {
    return { error: `未知的后端类型 "${backend}"。可用：${Object.keys(BACKEND_KINDS).join("、")}。` };
  }

  let id = slugify(input?.id || name);
  const taken = new Set(allMembers().map((member) => member.id));
  if (taken.has(id)) id = `${id}-${randomUUID().slice(0, 4)}`;

  const avatar = String(input?.avatar ?? name.slice(0, 3)).toUpperCase().slice(0, 4) || "AI";
  const accent = /^#[0-9a-fA-F]{6}$/.test(input?.accent ?? "") ? input.accent : "#8b96a5";

  const member = {
    id,
    name,
    role: String(input?.role ?? "自定义成员").trim().slice(0, 32) || "自定义成员",
    accent,
    avatar,
    backend,
    seed: false,
    capabilities: Array.isArray(input?.capabilities) ? input.capabilities : [],
    webSearch: Boolean(input?.webSearch),
    persona: String(input?.persona ?? "").trim() || `你是指挥室成员 ${name}。认真完成指挥官交代的任务，不确定就说不确定。`,
  };

  if (BACKEND_KINDS[backend].kind === "api") {
    const baseUrl = String(input?.baseUrl ?? "").trim();
    const model = String(input?.model ?? "").trim();
    const apiKey = String(input?.apiKey ?? "").trim();

    if (!baseUrl) return { error: "API 成员必须填写接口地址（baseUrl）。" };
    if (!/^https?:\/\//i.test(baseUrl)) return { error: "接口地址必须以 http:// 或 https:// 开头。" };
    if (!model) return { error: "API 成员必须填写模型名（model）。" };
    if (!apiKey && !input?.reuseKey) return { error: "API 成员必须填写密钥，或选择复用已有密钥。" };

    member.api = {
      baseUrl,
      model,
      temperature: Number.isFinite(Number(input?.temperature)) ? Number(input.temperature) : undefined,
      maxTokens: Number.isFinite(Number(input.maxTokens)) ? Number(input.maxTokens) : undefined,
    };
  }

  return { member, apiKey: member.api ? String(input?.apiKey ?? "").trim() || null : null };
}

/**
 * 新建成员。密钥先落 secrets 再落成员定义，任一失败都清理干净。
 */
export function createMember(input) {
  const normalized = normalizeNewMember(input);
  if (normalized.error) return normalized;

  const { member, apiKey } = normalized;

  let wroteKey = false;
  if (apiKey) {
    try {
      persistApiKey(member.id, apiKey);
      wroteKey = true;
    } catch (error) {
      return { error: `无法保存 API 密钥：${error.message}` };
    }
  }

  try {
    saveMembers([...allMembers(), member]);
  } catch (error) {
    if (wroteKey) {
      try {
        removeApiKey(member.id);
      } catch {
        /* 清理失败也不能掩盖原始错误 */
      }
    }
    return { error: `无法保存成员定义：${error.message}` };
  }

  return { member };
}

/** 删除成员（任何成员都可删，包括种子成员）。 */
export function deleteMember(id) {
  const members = allMembers();
  const target = members.find((member) => member.id === id);
  if (!target) return { error: "成员不存在。" };
  saveMembers(members.filter((member) => member.id !== id));
  return { ok: true, member: target };
}

/** 更新成员的可编辑字段。 */
export function updateMember(id, patch) {
  const members = allMembers();
  const index = members.findIndex((member) => member.id === id);
  if (index === -1) return { error: "成员不存在。" };

  const current = members[index];
  const next = { ...current };

  if (typeof patch?.name === "string" && patch.name.trim()) next.name = patch.name.trim().slice(0, 24);
  if (typeof patch?.role === "string") next.role = patch.role.trim().slice(0, 32) || next.role;
  if (typeof patch?.persona === "string" && patch.persona.trim()) next.persona = patch.persona.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(patch?.accent ?? "")) next.accent = patch.accent;
  if (typeof patch?.avatar === "string") next.avatar = patch.avatar.toUpperCase().slice(0, 4) || next.avatar;
  if (Array.isArray(patch?.capabilities)) next.capabilities = patch.capabilities;

  if (next.api) {
    if (typeof patch?.baseUrl === "string" && patch.baseUrl.trim()) next.api.baseUrl = patch.baseUrl.trim();
    if (typeof patch?.model === "string" && patch.model.trim()) next.api.model = patch.model.trim();
  }

  members[index] = next;
  saveMembers(members);
  return { member: next };
}

/** 测试用：清掉缓存，强制重新从磁盘读。 */
export function _resetCache() {
  cache = null;
}

/** 数据文件路径（测试/文档用）。 */
export function membersPath() {
  return STORE_PATH;
}

export function seedPath() {
  return SEED_PATH;
}
