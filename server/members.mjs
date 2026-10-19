/**
 * 成员注册表：成员不再是写死的常量，而是可持久化的数据。
 *
 * 分两层：
 *   - 内置成员（BUILTIN_MEMBERS）：随项目发布，带完整人格，不可删除。
 *   - 自定义成员（data/members.json）：由指挥官在界面上新建，可增可删。
 *
 * 为什么这样拆：内置成员的人格是项目的一部分（要进版本控制），而新建成员是
 * 运行期数据（属于这台机器）。混在一起会让"升级代码"和"保留我的成员"打架。
 *
 * 后端类型（backend）：
 *   dsh        —— 内置 DeepSeek Harness 一次性运行器（有工具能力）
 *   claude-cli —— 真实 Claude Code CLI（有工具能力）
 *   codex-cli  —— 真实 Codex CLI（有工具能力）
 *   openai-api —— OpenAI 兼容 Chat Completions（纯对话）
 *   anthropic-api —— Anthropic Messages（纯对话）
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config } from "./config.mjs";
import { persistApiKey, removeApiKey } from "./secrets-store.mjs";

const STORE_PATH = resolve(config.dataDir, "members.json");

/** 允许的后端类型，以及它是否具备"动手"能力。 */
export const BACKEND_KINDS = {
  dsh: { label: "DSH 内置", toolCapable: true, kind: "cli" },
  "claude-cli": { label: "Claude Code", toolCapable: true, kind: "cli" },
  "codex-cli": { label: "Codex", toolCapable: true, kind: "cli" },
  "openai-api": { label: "OpenAI 兼容 API", toolCapable: false, kind: "api" },
  "anthropic-api": { label: "Anthropic API", toolCapable: false, kind: "api" },
};

/** 内置成员：与项目一起发布，人格写在这里便于版本控制。 */
export const BUILTIN_MEMBERS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    role: "总执行 · 快反",
    accent: "#4d8dff",
    avatar: "DS",
    backend: "dsh",
    capabilities: ["files", "shell", "web"],
    webSearch: false,
    builtin: true,
    persona: `你是指挥室的**总执行者**，执行力优先。

你的风格：
- 直接、干脆、动手能力强。指挥官下达任务后，先动手，再汇报。
- 用工具文档里的真实能力完成任务：读文件、写文件、改代码、跑命令、检索资料。
- 汇报格式固定为三段：**做了什么** → **产出在哪（真实路径）** → **有什么风险或未决项**。
- 不确定的地方宁可先快速验证一下，也不要凭印象回答。做错了要立刻承认并纠正。

你是整个指挥室跑得最快的成员，负责把任务真正落地。`,
  },
  {
    id: "claude",
    name: "Claude",
    role: "审阅官 · 深度分析",
    accent: "#d97757",
    avatar: "CL",
    backend: "claude-cli",
    capabilities: ["files", "shell", "web"],
    webSearch: false,
    builtin: true,
    persona: `你是指挥室的**审阅官与技术分析者**，负责深度与严谨。

你的风格：
- 先想清楚再动手。动手前明确说出你打算怎么做、为什么这么做。
- 善于发现别人漏掉的问题：边界条件、错误处理、安全隐患、可维护性、以及"看起来对但其实错"的地方。
- 审阅代码或方案时，按**严重程度排序**列出问题，每条给出：问题是什么、为什么是问题、具体怎么改。
- 不为了显得厉害而堆砌意见。没有实质问题时，就明确说"这里没问题"，并说清你检查了哪些方面。
- 语言精确克制，避免空洞的赞美。

当指挥官要你审阅、复核、找问题时，你是最后一道防线。`,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    role: "工程实现 · 方案设计",
    accent: "#10a37f",
    avatar: "GPT",
    backend: "dsh",
    capabilities: ["files", "shell"],
    webSearch: false,
    builtin: true,
    persona: `你是指挥室的**工程实现者与方案设计者**。

你的风格：
- 把模糊需求变成可执行的技术方案：技术选型、目录结构、模块划分、接口定义、实施步骤。
- 写代码时追求能直接运行、结构清晰、命名达意，而不是伪代码或示意片段。
- 给出方案时说明取舍：为什么选 A 不选 B，代价是什么，什么情况下该推翻这个决定。
- 动手实现时，用工具真正把代码写进文件并验证它跑得起来，不要只贴代码到对话里。
- 汇报时讲清楚：改了哪些文件、核心设计是什么、怎么验证的。

你是把想法变成能跑的软件的那个人。`,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    role: "情报官 · 联网检索",
    accent: "#20b8cd",
    avatar: "PPLX",
    backend: "dsh",
    capabilities: ["web"],
    webSearch: true,
    builtin: true,
    persona: `你是指挥室的**情报官**，唯一职责是基于联网检索给出有出处的答案。

你的铁律：
- 回答任何需要外部事实的问题前，**必须先调用联网检索工具**。禁止凭记忆回答时效性问题。
- 每一条关键事实后面都要给出**真实来源链接**，格式为 Markdown 链接：[来源标题](完整URL)。
- 检索结果不足以支撑结论时，如实说"现有检索结果不足以确认"，并说明你查了什么、还缺什么。**绝不编造链接或数据**。
- 区分清楚：哪些是检索到的原话/事实，哪些是你自己的推断。推断必须标注为推断。
- 如果多个来源互相矛盾，把矛盾本身汇报出来，而不是挑一个顺眼的。

你的输出结构：**结论** → **支撑证据（带链接）** → **不确定之处**。

没有来源，就没有情报。`,
  },
];

let cache = null;

/** 读取 data/members.json（读不到就当作空）。 */
function loadCustom() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    cache = Array.isArray(parsed?.members) ? parsed.members : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** 原子写盘，避免进程被杀时留下半个文件。 */
function saveCustom(members) {
  mkdirSync(config.dataDir, { recursive: true });
  const temp = `${STORE_PATH}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, members }, null, 2), "utf8");
  renameSync(temp, STORE_PATH);
  cache = members;
}

/** 全部成员（内置在前，自定义在后）。 */
export function allMembers() {
  return [...BUILTIN_MEMBERS, ...loadCustom()];
}

/** 按 id 取成员。 */
export function memberById(id) {
  return allMembers().find((member) => member.id === id);
}

/** 某成员使用的后端类型。 */
export function backendOf(member) {
  return member?.backend ?? "dsh";
}

/**
 * 把名称转成 **ASCII 安全** 的 id。
 *
 * 为什么强制 ASCII：id 会进 URL 路径、文件名，以及（对 DSH 后端）profile 目录名。
 * 中文 id 虽然能跑通编码，但在文件系统、命令行、日志里都是隐患——出现过一次
 * 中文 id 让 URL 编码反复踩坑。
 *
 * 纯中文名称会被转成 `member-<短哈希>`：既保持唯一，又不含不可控字符。
 */
export function slugify(name) {
  const raw = String(name ?? "").trim();
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // 至少有 2 个字符才有可读性，否则用哈希兜底。
  if (ascii.length >= 2) return ascii.slice(0, 24);

  // 用名称的哈希生成稳定短 id：同样的名字得到同样的 id（便于人眼对应）。
  let hash = 0;
  for (const char of raw) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `member-${hash.toString(36).slice(0, 6)}`;
}

/** 校验并规范化一个新成员的输入。返回 { member } 或 { error }。 */
export function normalizeNewMember(input) {
  const name = String(input?.name ?? "").trim();
  if (!name) return { error: "成员名称不能为空。" };
  if (name.length > 24) return { error: "成员名称最多 24 个字符。" };

  const backend = String(input?.backend ?? "openai-api");
  if (!BACKEND_KINDS[backend]) {
    return { error: `未知的后端类型 "${backend}"。可用：${Object.keys(BACKEND_KINDS).join("、")}。` };
  }

  let id = slugify(input?.id || name);
  // 避免与内置或已有成员撞 id
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
    builtin: false,
    capabilities: [],
    webSearch: false,
    persona: String(input?.persona ?? "").trim() || `你是指挥室成员 ${name}。认真完成指挥官交代的任务，不确定就说不确定。`,
  };

  // API 后端的连接信息
  if (BACKEND_KINDS[backend].kind === "api") {
    const baseUrl = String(input?.baseUrl ?? "").trim();
    const model = String(input?.model ?? "").trim();
    const apiKey = String(input?.apiKey ?? "").trim();

    if (!baseUrl) return { error: "API 成员必须填写接口地址（baseUrl）。" };
    if (!/^https?:\/\//i.test(baseUrl)) return { error: "接口地址必须以 http:// 或 https:// 开头。" };
    if (!model) return { error: "API 成员必须填写模型名（model）。" };

    // 密钥只存进 secrets 侧（调用时读），这里检查是否给了
    if (!apiKey && !input?.reuseKey) return { error: "API 成员必须填写密钥，或选择复用已有密钥。" };

    member.api = {
      baseUrl,
      model,
      temperature: Number.isFinite(Number(input?.temperature)) ? Number(input.temperature) : undefined,
      maxTokens: Number.isFinite(Number(input?.maxTokens)) ? Number(input.maxTokens) : undefined,
    };
    // 密钥不进 members.json，单独返回给调用方存进 secrets
    member.__apiKey = apiKey || null;
  }

  // CLI 后端的 profile 覆盖（可选）
  if (backend === "dsh" && input?.extraDirs) {
    member.extraDirs = input.extraDirs;
  }

  return { member, apiKey: member.__apiKey ?? null };
}

/**
 * 新建一个自定义成员。
 *
 * 密钥处理：先落 secrets 再落成员定义，任一失败都要清理干净——不能出现
 * "成员建好了但密钥没存"这种半成品状态。
 */
export function createMember(input) {
  const normalized = normalizeNewMember(input);
  if (normalized.error) return normalized;

  const { member, apiKey } = normalized;
  // 密钥绝不写进 members.json
  delete member.__apiKey;

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
    saveCustom([...loadCustom(), member]);
  } catch (error) {
    // 成员没存成，把刚写的密钥撤掉，避免留下孤儿
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

/** 删除自定义成员（内置成员不可删）。 */
export function deleteMember(id) {
  const custom = loadCustom();
  const target = custom.find((member) => member.id === id);
  if (!target) return { error: "只能删除自定义成员；内置成员不可删除。" };
  saveCustom(custom.filter((member) => member.id !== id));
  return { ok: true, member: target };
}

/** 更新自定义成员的可编辑字段（名字、角色、人格、API 参数）。 */
export function updateMember(id, patch) {
  const custom = loadCustom();
  const index = custom.findIndex((member) => member.id === id);
  if (index === -1) return { error: "只能修改自定义成员；内置成员不可修改。" };

  const current = custom[index];
  const next = { ...current };

  if (typeof patch?.name === "string" && patch.name.trim()) next.name = patch.name.trim().slice(0, 24);
  if (typeof patch?.role === "string") next.role = patch.role.trim().slice(0, 32) || next.role;
  if (typeof patch?.persona === "string" && patch.persona.trim()) next.persona = patch.persona.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(patch?.accent ?? "")) next.accent = patch.accent;
  if (typeof patch?.avatar === "string") next.avatar = patch.avatar.toUpperCase().slice(0, 4) || next.avatar;

  if (next.api) {
    if (typeof patch?.baseUrl === "string" && patch.baseUrl.trim()) next.api.baseUrl = patch.baseUrl.trim();
    if (typeof patch?.model === "string" && patch.model.trim()) next.api.model = patch.model.trim();
  }

  custom[index] = next;
  saveCustom(custom);
  return { member: next };
}

/** 测试用：清掉缓存，强制重新从磁盘读。 */
export function _resetCache() {
  cache = null;
}
