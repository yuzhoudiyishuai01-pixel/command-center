/**
 * 指挥室配置加载。
 *
 * 配置文件 cc.config.json 是可选的：缺失字段一律回落默认值，所以克隆下来
 * 直接 `npm start` 也能跑（只是没有可用的成员，需要你在界面里添加）。
 *
 * 优先级：环境变量 > cc.config.json > 内置默认值。
 * 路径统一解析成绝对路径，子进程可以直接用。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findExecutable, IS_WINDOWS } from "./which.mjs";

/** 项目根目录（本文件位于 <root>/server/）。 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_PATH = process.env.CC_CONFIG
  ? resolve(process.env.CC_CONFIG)
  : resolve(PROJECT_ROOT, "cc.config.json");

const FALLBACK = {
  host: "127.0.0.1",
  port: 8787,
  workspace: process.env.CC_WORKSPACE ?? process.cwd(),
  dshHome: "",
  dshCli: "",
  dshCliJs: "",
  dshExecutable: "",
  credentialsSource: "",
  permissionMode: "danger-full-access",
  defaultModel: "deepseek-flash",
  turnTimeoutMs: 30 * 60 * 1000,
  maxConcurrentTurns: 4,
  perMemberQueue: true,
  historyCharBudget: 24_000,
  auth: true,
  token: "",
  optionalBackends: {},
  backends: {},
};

const BACKEND_DEFAULTS = {
  proxy: "",
  claudeUseProxy: false,
  claudeEnv: {},
  claudeCliPath: "",
  claudeModel: "",
  claudePermissionMode: "bypassPermissions",
  codexUseProxy: false,
  codexEnv: {},
  codexCliPath: "",
  codexModel: "",
  codexBypassSandbox: true,
  codexSandbox: "workspace-write",
};

function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_PATH} 解析失败：${error.message}`);
  }
}

function envBool(name, fallbackValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackValue;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function envNumber(name, fallbackValue, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackValue;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallbackValue;
}

function loadConfig() {
  const raw = readConfigFile();
  const merged = { ...FALLBACK, ...raw, backends: { ...BACKEND_DEFAULTS, ...raw.backends } };

  // 环境变量覆盖（方便容器/CI 使用）。
  merged.host = process.env.CC_HOST || merged.host;
  merged.port = envNumber("CC_PORT", merged.port, { min: 1 });
  merged.workspace = process.env.CC_WORKSPACE || merged.workspace;
  // CC_DSH_CLI=off/none 表示明确禁用 DSH 后端（纯 API 成员部署，或测试用）。
  const dshEnv = process.env.CC_DSH_CLI;
  if (dshEnv !== undefined) {
    merged.dshCli = /^(off|none|0|false)$/i.test(dshEnv.trim()) ? "" : dshEnv;
    merged.dshDisabled = /^(off|none|0|false)$/i.test(dshEnv.trim());
  }
  merged.dshHome = process.env.CC_DSH_HOME || merged.dshHome;
  merged.token = process.env.CC_TOKEN || merged.token;
  merged.auth = envBool("CC_AUTH", merged.auth);
  merged.turnTimeoutMs = envNumber("CC_TURN_TIMEOUT_MS", merged.turnTimeoutMs, { min: 1000 });
  merged.maxConcurrentTurns = envNumber("CC_MAX_CONCURRENT_TURNS", merged.maxConcurrentTurns, { min: 1 });
  merged.perMemberQueue = envBool("CC_PER_MEMBER_QUEUE", merged.perMemberQueue);
  merged.historyCharBudget = envNumber("CC_HISTORY_CHAR_BUDGET", merged.historyCharBudget, { min: 1000 });
  merged.permissionMode = process.env.CC_PERMISSION_MODE || merged.permissionMode;
  if (process.env.CC_PROXY) merged.backends.proxy = process.env.CC_PROXY;

  // ── 路径解析 ──────────────────────────────────────────────────────────────
  const abs = (value) => resolve(PROJECT_ROOT, value);
  merged.dataDir = resolve(process.env.CC_DATA_DIR ? resolve(process.env.CC_DATA_DIR) : joinRoot("data"));
  merged.publicDir = joinRoot("public");
  merged.projectRoot = PROJECT_ROOT;
  merged.workspace = abs(merged.workspace);

  // dshHome：默认放 <root>/runtime/dsh-home。放在项目内是刻意的——DSH 的
  // file sandbox 只允许写工作区，$DSH_HOME 落在这里成员进程才能正常启动。
  merged.dshHome = merged.dshHome ? abs(merged.dshHome) : joinRoot("runtime", "dsh-home");

  // DSH CLI：没配置就从 PATH 自动探测（Windows 上会命中 dsh.cmd）。
  if (!merged.dshCli) {
    if (!merged.dshDisabled) merged.dshCli = findExecutable(["dsh"], { extraDirs: dshHintDirs() }) ?? "";
  } else {
    merged.dshCli = abs(merged.dshCli);
  }
  if (merged.dshExecutable) merged.dshExecutable = abs(merged.dshExecutable);
  if (merged.dshCliJs) merged.dshCliJs = abs(merged.dshCliJs);

  // 登录凭据来源：默认 DSH 桌面版的 home（Windows %USERPROFILE%\.dsh）。
  if (!merged.credentialsSource) {
    merged.credentialsSource = resolve(homedir(), ".dsh");
  } else {
    merged.credentialsSource = abs(merged.credentialsSource);
  }

  // 可选 backend 的 CLI 路径同样支持自动探测。
  merged.backends.claudeCliPath =
    merged.backends.claudeCliPath
      ? abs(merged.backends.claudeCliPath)
      : (findExecutable(["claude"], { extraDirs: claudeHintDirs() }) ?? "");
  merged.backends.codexCliPath =
    merged.backends.codexCliPath
      ? abs(merged.backends.codexCliPath)
      : (findExecutable(["codex"], { extraDirs: codexHintDirs() }) ?? "");

  return merged;
}

function joinRoot(...parts) {
  return resolve(PROJECT_ROOT, ...parts);
}

/** 桌面版安装位置的常见提示目录（找不到就返回空，不影响 PATH 探测）。 */
function dshHintDirs() {
  if (!IS_WINDOWS) return ["/usr/local/bin", "/opt/homebrew/bin"];
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      resolve(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin"),
    );
  }
  if (process.env.ProgramFiles) {
    candidates.push(resolve(process.env.ProgramFiles, "DeepSeek Harness", "resources", "runtime", "cli", "bin"));
  }
  return candidates;
}

function claudeHintDirs() {
  return IS_WINDOWS ? [resolve(homedir(), ".local", "bin")] : [resolve(homedir(), ".local", "bin")];
}

function codexHintDirs() {
  return IS_WINDOWS ? [resolve(homedir(), "AppData", "Roaming", "npm")] : [resolve(homedir(), ".local", "bin")];
}

export const config = loadConfig();

/** DSH CLI 是否可用（决定 DSH 成员能不能跑）。 */
export function dshAvailable() {
  return Boolean(config.dshCli) && existsSync(config.dshCli);
}

export function configPath() {
  return CONFIG_PATH;
}

/**
 * 致命问题：只有这些会让服务拒绝启动。
 * 缺 CLI 不算致命——用户完全可以只用 API 成员。
 */
export function missingPrerequisites() {
  const problems = [];
  if (!existsSync(config.projectRoot)) problems.push(`项目根目录不存在：${config.projectRoot}`);
  if (!process.version || Number(process.versions.node.split(".")[0]) < 20) {
    problems.push(`需要 Node.js 20 或更高版本（当前 ${process.versions.node}）。`);
  }
  return problems;
}

/** 非致命提示：启动横幅里如实告诉用户哪些成员不可用。 */
export function startupWarnings() {
  const warnings = [];
  if (!dshAvailable()) {
    warnings.push(
      "未检测到 DeepSeek Harness CLI（dsh）：DSH 成员不可用。" +
        "可在 cc.config.json 里填写 dshCli，或改用 API 成员（OpenAI / Anthropic 兼容）。",
    );
  }
  if (!config.backends.claudeCliPath) warnings.push("未检测到 claude CLI：Claude Code 成员不可用。");
  if (!config.backends.codexCliPath) warnings.push("未检测到 codex CLI：Codex 成员不可用。");
  if (!config.auth) warnings.push("鉴权已关闭（auth=false）：局域网内任何人都能访问并派活。");
  if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost" && config.auth === false) {
    warnings.push(`服务对 ${config.host} 开放且没有鉴权，风险很高，建议只监听 127.0.0.1。`);
  }
  return warnings;
}
