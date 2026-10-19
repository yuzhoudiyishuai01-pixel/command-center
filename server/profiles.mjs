/**
 * 把成员名册编译成 DSH profile。
 *
 * 每位成员需要一份独立的 DSH profile，才能拥有各自的系统提示（人格）。DSH 的
 * profile 由若干文件组成，这里在启动时按名册重新生成，保证配置始终与 agents.mjs
 * 一致——手改 profile 目录会在下次启动时被覆盖，这是有意为之。
 *
 * 生成的 profile 继承官方 headless 组合（dsh-base + dsh-headless），只覆盖三行：
 *   1. agent-default-model —— 走已登录的 DeepSeek 账号路由，而不是需要 API Key 的路由
 *   2. system-prompt       —— 注入该成员的人格
 *   3. hmr                 —— 一次性运行不需要热重载
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { config } from "./config.mjs";
import { agents, profileNameFor, systemPromptFor } from "./agents.mjs";
import { backendNameFor } from "./backends.mjs";

function writeIfChanged(path, content) {
  if (existsSync(path)) {
    return;
  }
  writeFileSync(path, content, "utf8");
}

function overwrite(path, content) {
  writeFileSync(path, content, "utf8");
}

/**
 * 生成 YAML 块标量。用显式缩进指示符（`|-2`）保留原文的换行，避免 YAML
 * 折叠换行后人格文本粘连成一整行。
 */
function blockScalar(text, indent) {
  const pad = " ".repeat(indent);
  const lines = text.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const body = lines.map((line) => (line.length > 0 ? `${pad}${line}` : "")).join("\n");
  return `|-2\n${body}`;
}

/** 为单个成员生成 profile 目录。 */
function writeProfile(agent) {
  const profileDir = resolve(config.dshHome, "profiles", profileNameFor(agent.id));
  mkdirSync(profileDir, { recursive: true });

  // 官方 headless 组合：dsh-base 提供核心与工具，dsh-headless 提供一次性任务运行器。
  overwrite(
    resolve(profileDir, "package.json"),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profileNameFor(agent.id)}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
      },
      null,
      2,
    )}\n`,
  );

  // pnpm-workspace.yaml 标记该目录为独立 workspace 根，与官方生成的 profile 保持一致。
  overwrite(resolve(profileDir, "pnpm-workspace.yaml"), "packages: []\n");

  // 空 profile 根；真正的配置全部来自 bundle + 本 patch 层。
  writeIfChanged(
    resolve(profileDir, "cordis.yml"),
    [
      "# dsh profile root — 空的条目列表。配置由 bundle 与 cordis.patch.yml 组合而成。",
      "[]",
      "",
    ].join("\n"),
  );

  overwrite(
    resolve(profileDir, "cordis.patch.yml"),
    `# 由指挥室自动生成 — 请勿手改，改动会在服务下次启动时被覆盖。
# 成员：${agent.name}（${agent.role}）
# 要调整人格，请编辑 server/agents.mjs。

# 走已登录的 DeepSeek 账号路由（dsh-base 同时挂载了账号版与 API-Key 版适配器，
# 默认指向 API-Key 版，这里改指账号版，因此无需任何 API Key）。
- id: agent-default-model
  config:
    provider: deepseek-account
    model: ${config.defaultModel}
    reasoningEffort: high

# 注入该成员的人格 + 运行环境事实（权限模式等，成员无法自行查询，必须由这里给定）。
- id: system-prompt
  config:
    personaPrefix: ${blockScalar(
      systemPromptFor(agent, { permissionMode: config.permissionMode, workspace: config.workspace }),
      6,
    )}

# 一次性运行，无需热重载。
- id: hmr
  disabled: true
`,
  );

  return profileDir;
}

/** 为名册中所有成员生成 profile，返回 id -> profile 名称的映射。 */
export function ensureProfiles() {
  mkdirSync(config.dshHome, { recursive: true });
  const map = new Map();
  for (const agent of agents()) {
    // 只有走内置 DSH 路由的成员才需要 profile；真实厂商 CLI 有各自的状态目录。
    if (backendNameFor(agent) !== "dsh") continue;
    writeProfile(agent);
    map.set(agent.id, profileNameFor(agent.id));
  }
  return map;
}

/**
 * 确保某一成员（可能刚刚被创建）的 profile 存在。
 *
 * 为什么需要：profile 原本只在服务启动时按名册生成。新建的成员没有 profile，
 * 派活时 DSH 会以 `exit 1` 失败——实测确认过。这里在派发前补一次，
 * 让"新建成员后无需重启即可使用"成立。
 *
 * @param {object} agent 成员定义
 * @returns {boolean} 是否适用于 DSH 后端
 */
export function ensureProfileFor(agent) {
  if (!agent || backendNameFor(agent) !== "dsh") return false;
  mkdirSync(config.dshHome, { recursive: true });
  writeProfile(agent);
  return true;
}

/** 需要跟随登录态的凭据文件。 */
const CREDENTIAL_FILES = [".credentials.yaml", ".anonymous-user-id"];

/**
 * 把 DeepSeek Harness 桌面版的登录凭据同步进我们的 dshHome。
 *
 * 为什么需要：成员的模型算力来自"已登录的 DeepSeek 账号路由"，而登录态存在
 * $DSH_HOME 下的凭据文件里。我们把 $DSH_HOME 指向工作区（沙箱所限），所以必须
 * 把凭据带过来，否则每个成员都会以 ACCOUNT_SIGN_IN_REQUIRED 失败。
 *
 * 已是本目录内的同一个文件时跳过，避免自我覆盖。
 *
 * @returns {{synced: string[], missing: string[]}}
 */
export function syncCredentials() {
  const source = config.credentialsSource;
  const synced = [];
  const missing = [];

  for (const name of CREDENTIAL_FILES) {
    const from = resolve(source, name);
    const to = resolve(config.dshHome, name);
    if (resolve(from) === resolve(to)) continue;
    if (!existsSync(from)) {
      // 目标里已经有就不算缺失：用户可能手工配置过。
      if (!existsSync(to)) missing.push(name);
      continue;
    }
    try {
      copyFileSync(from, to);
      synced.push(name);
    } catch (error) {
      missing.push(`${name}（复制失败：${error.message}）`);
    }
  }

  return { synced, missing };
}

/**
 * 计算某成员 profile 的指纹（patch 文件内容的哈希）。
 *
 * 用途：system prompt 一旦注入会话就固化了，改配置不会自动生效。启动时比对指纹，
 * 发现变化就让该成员重新开始会话，避免它带着旧提示继续回答。
 */
export function profileSignature(agent) {
  const patchPath = resolve(config.dshHome, "profiles", profileNameFor(agent.id), "cordis.patch.yml");
  if (!existsSync(patchPath)) return "missing";
  try {
    return createHash("sha256").update(readFileSync(patchPath, "utf8")).digest("hex").slice(0, 16);
  } catch {
    return "unreadable";
  }
}
