/**
 * 指挥室配置加载。
 *
 * 配置来自 cc.config.json；缺失的字段回落到内置默认值，所以删掉配置文件也能跑。
 * 所有路径都解析成绝对路径，方便子进程直接使用。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录（本文件位于 <root>/server/）。 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_PATH = resolve(PROJECT_ROOT, "cc.config.json");

const FALLBACK = {
  host: "127.0.0.1",
  port: 8787,
  workspace: process.cwd(),
  dshHome: resolve(PROJECT_ROOT, "runtime", "dsh-home"),
  dshCli: process.env.DSH_CLI ?? "",
  dshExecutable: process.env.DSH_EXECUTABLE ?? "",
  dshCliJs: process.env.DSH_CLI_JS ?? "",
  credentialsSource: "",
  permissionMode: "workspace-write",
  defaultModel: "deepseek-flash",
  turnTimeoutMs: 1_800_000,
  optionalBackends: {},
};

function loadConfig() {
  let raw = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (error) {
      throw new Error(`cc.config.json 解析失败：${error.message}`);
    }
  }
  const merged = { ...FALLBACK, ...raw };

  // 相对路径按项目根解析，避免受启动时的 cwd 影响。
  const abs = (value) => resolve(PROJECT_ROOT, value);
  merged.dshHome = abs(merged.dshHome);
  merged.workspace = abs(merged.workspace);
  if (merged.dshCli) merged.dshCli = abs(merged.dshCli);
  if (merged.dshExecutable) merged.dshExecutable = abs(merged.dshExecutable);
  if (merged.dshCliJs) merged.dshCliJs = abs(merged.dshCliJs);
  merged.dataDir = resolve(PROJECT_ROOT, "data");
  merged.publicDir = resolve(PROJECT_ROOT, "public");
  // 项目根：secrets.json 等相对位置在这里解析。
  merged.projectRoot = PROJECT_ROOT;

  // 登录凭据的来源目录。默认取 DeepSeek Harness 桌面版自己的 home
  // （Windows 为 %USERPROFILE%\.dsh），启动时会把凭据同步进 dshHome，
  // 这样 $DSH_HOME 落在工作区内也不会丢登录态。
  if (!merged.credentialsSource) {
    merged.credentialsSource = resolve(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
  }

  return merged;
}

export const config = loadConfig();

/** 配置里必须存在的可执行入口，启动时自检用。 */
export function missingPrerequisites() {
  const missing = [];
  if (!config.dshCli) {
    missing.push("cc.config.json 缺少 dshCli：找不到 DeepSeek Harness 的 dsh 命令行入口。");
  } else if (!existsSync(config.dshCli)) {
    missing.push(`dshCli 指向的路径不存在：${config.dshCli}`);
  }
  return missing;
}
