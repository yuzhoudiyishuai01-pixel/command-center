/**
 * 成员后端。
 *
 * 一位成员"由谁提供智力"是可替换的，这就是后端的含义：
 *
 *   dsh        —— DeepSeek Harness 的一次性任务运行器（默认，零配置）
 *   claude-cli —— 真实 Claude Code CLI（需要本机已 `claude /login`）
 *   codex-cli  —— 真实 Codex CLI（需要本机已 `codex login`）
 *
 * 三种后端对外暴露同一个事件契约，所以编排层、存储层、前端都不需要知道差别：
 *
 *   { type: "session",   sessionId }
 *   { type: "step",      turn, step }
 *   { type: "thinking",  text }
 *   { type: "text",      text }
 *   { type: "tool_call", callId, tool, label, detail, input }
 *   { type: "tool_result", callId, status, result }
 *   { type: "usage",     usage }
 *   { type: "final",     text }
 *   { type: "error",     message }
 *   { type: "notice",    text }
 *
 * runTurn 的返回值统一为：
 *   { sessionId, finalText, exitCode, aborted, error, stderr }
 */
import { statSync, readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { delimiter, dirname, join } from "node:path";

import { config } from "./config.mjs";

/** 事件里工具名 -> 展示文案；三种后端共用同一套，界面表现才一致。 */
export const TOOL_PRESENTATION = {
  read: { label: "读取文件", detail: (input) => input?.file_path ?? input?.path },
  read_file: { label: "读取文件", detail: (input) => input?.file_path ?? input?.path },
  write: { label: "写入文件", detail: (input) => input?.file_path ?? input?.path },
  write_file: { label: "写入文件", detail: (input) => input?.file_path ?? input?.path },
  edit: { label: "修改文件", detail: (input) => input?.file_path ?? input?.path },
  edit_file: { label: "修改文件", detail: (input) => input?.file_path ?? input?.path },
  str_replace: { label: "修改文件", detail: (input) => input?.file_path ?? input?.path },
  multiedit: { label: "批量修改", detail: (input) => input?.file_path ?? input?.path },
  glob: { label: "查找文件", detail: (input) => input?.pattern ?? input?.glob_pattern },
  grep: { label: "搜索内容", detail: (input) => input?.pattern },
  ls: { label: "列目录", detail: (input) => input?.path },
  bash: { label: "执行命令", detail: (input) => input?.command },
  shell: { label: "执行命令", detail: (input) => input?.command ?? input?.command_line },
  pwsh: { label: "执行命令", detail: (input) => input?.command },
  powershell: { label: "执行命令", detail: (input) => input?.command },
  web_search: { label: "联网检索", detail: (input) => input?.query ?? input?.queries?.join?.(" / ") },
  web_fetch: { label: "抓取网页", detail: (input) => input?.url },
  webfetch: { label: "抓取网页", detail: (input) => input?.url },
  todo_write: { label: "更新任务清单", detail: () => null },
  update_plan: { label: "更新计划", detail: () => null },
  task: { label: "派发子任务", detail: (input) => input?.description },
  present: { label: "交付文件", detail: (input) => input?.files?.map?.((f) => f.path ?? f)?.join?.(", ") },
};

/** 把工具名与入参翻译成界面可读的 { tool, label, detail }。 */
export function describeTool(name, input) {
  const spec = TOOL_PRESENTATION[name];
  let detail = null;
  try {
    detail = spec?.detail?.(input) ?? null;
  } catch {
    detail = null;
  }
  if (typeof detail === "string" && detail.length > 220) detail = `…${detail.slice(-220)}`;
  return {
    tool: name,
    label: spec?.label ?? name,
    detail: typeof detail === "string" ? detail : null,
  };
}

/** 工具输出可能极大，进前端前先截断。 */
export function truncate(text, limit = 6000) {
  if (typeof text !== "string") return "";
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text;
}

/**
 * 在 PATH 以及常见安装位置里定位一个可执行文件。
 *
 * @param {string[]} names 候选可执行名（不含扩展名）
 * @param {string[]} extraDirs 额外搜索目录
 * @returns {string|null}
 */
export function whichAny(names, extraDirs = []) {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const dirs = [...extraDirs, ...pathDirs];
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir, `${name}${ext}`);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          /* 不存在就继续找 */
        }
      }
    }
  }
  return null;
}

/** 读取 backends 段的配置，缺失时给安全默认值。 */
export function backendConfig() {
  return config.backends ?? {};
}

/** 把 Windows 下常见的 npm 全局 bin 目录也算进搜索范围。 */
export function npmGlobalDirs() {
  const appData = process.env.APPDATA ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return [
    appData ? join(appData, "npm") : "",
    localAppData ? join(localAppData, "Programs") : "",
  ].filter(Boolean);
}

/** 某位成员使用的后端名。 */
export function backendNameFor(agent) {
  return agent?.backend ?? "dsh";
}

/**
 * 厂商 CLI 需要的代理环境变量。
 *
 * 为什么必须有：Claude Code 与 Codex **都不读系统代理设置**，只认环境变量。
 * 而 Anthropic 官方对不受支持地区返回 `403 forbidden`（注意不是 401），
 * 所以走官方时必须靠代理。实测：带上代理后，同一个命令从
 * "Unable to connect: Status 403" 变成 "Not logged in"。
 *
 * 同理，**维基百科国内直连不通（实测 000），经代理才是 200**。成员用内置
 * 联网工具抓维基时也必须走代理；实测注入后成员成功取到条目（"量子糾纏"）。
 * 所以 DSH 内置后端默认也带上它。
 *
 * **但注入一个已经关掉的代理比不注入更糟**：成员的所有联网请求会去连一个死端口，
 * 连本来能直连的站点也会失败（实测：代理关了以后，维基与 DeepSeek 双双 000）。
 * 因此这里会先看 startProxyWatch() 维护的存活标记，代理不在就返回空——
 * 宁可让成员直连，也不要把死代理塞给它。
 *
 * @param {"claude"|"codex"|null} [forBackend]
 *   可选：按后端决定是否注入代理。**走国内兼容端点时必须排除**，
 *   否则国内流量被绕到境外，反而更慢甚至失败。
 * @returns {Record<string,string>} 可直接并进子进程 env 的键值对
 */
export function proxyEnv(forBackend = null) {
  const cfg = backendConfig();

  if (forBackend) {
    const flag = cfg[`${forBackend}UseProxy`];
    if (flag === false) return {};
  }

  const proxy = cfg.proxy;
  if (!proxy || typeof proxy !== "string" || !proxy.trim()) return {};
  // 代理没在监听就不注入，避免把成员的联网能力一起拖下水。
  if (!proxyAlive) return {};

  const value = proxy.trim();
  return {
    HTTPS_PROXY: value,
    HTTP_PROXY: value,
    // 小写形式一并给出：部分 Node/Go 程序只认小写。
    https_proxy: value,
    http_proxy: value,
  };
}

/** 代理是否在监听。由 startProxyWatch() 周期性更新。 */
let proxyAlive = false;

/** 最近一次探测结果的记录，供日志与界面显示。 */
export const proxyStatus = { alive: false, checkedAt: null, target: null, error: null };

/** 从代理 URL 里取出 host 与 port。 */
function parseProxy(proxy) {
  try {
    const url = new URL(proxy);
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

/** 探测一次代理是否可连接。 */
function probeProxy(proxy) {
  return new Promise((resolvePromise) => {
    const target = parseProxy(proxy);
    if (!target) {
      resolvePromise(false);
      return;
    }
    const socket = netConnect({ host: target.host, port: target.port });
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ok);
      proxyStatus.error = ok ? null : (error ?? "连接失败");
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "超时"));
    socket.once("error", (error) => done(false, error.code ?? error.message));
  });
}

/**
 * 启动代理存活监控。
 *
 * 每 20 秒探测一次配置里的代理端口。这比"每次派发都探"省事，也比"永不探测"安全：
 * 用户开/关代理后，最多 20 秒成员的联网行为就会跟着变。
 *
 * @returns {() => void} 停止监控
 */
export function startProxyWatch() {
  const proxy = backendConfig().proxy;
  if (!proxy) return () => {};

  proxyStatus.target = proxy;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const ok = await probeProxy(proxy);
    proxyAlive = ok;
    proxyStatus.alive = ok;
    proxyStatus.checkedAt = new Date().toISOString();
  };

  // 立刻探一次，别等第一个 20 秒
  void tick();
  const timer = setInterval(() => void tick(), 20_000);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * 读取某后端额外需要的环境变量。
 *
 * 典型用途：把 Claude Code 指向 Anthropic 兼容的第三方端点
 * （如 https://api.deepseek.com/anthropic）。这样能保住真实 Claude Code 的
 * 完整工具能力，同时用上另一个模型。
 *
 * 密钥来源有两条，后者覆盖前者：
 *   1. cc.config.json 的 <backend>Env —— 放非敏感项，如 ANTHROPIC_BASE_URL
 *   2. secrets.json 的 <backend>Env   —— 放密钥。该文件被 .gitignore 忽略，
 *      不进版本控制；密钥只经环境变量传递，不会出现在进程命令行里。
 */
export function backendEnv(forBackend) {
  const out = {};
  for (const source of [backendConfig()[`${forBackend}Env`], secrets()[`${forBackend}Env`]]) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
  }
  return out;
}

/**
 * 读取 secrets.json（密钥文件）。
 *
 * **不缓存**：界面上新建成员时会立刻写入新密钥，如果这里缓存了旧内容，
 * `hasApiKey` 会读到过期结果（实测因此误判过）。文件很小，每次读盘的成本可以忽略。
 *
 * 读不到就返回空对象——**绝不抛错**。缺密钥只应让那位成员不可用，
 * 不该拖垮整个服务启动。
 */
export function secrets() {
  const path = join(config.projectRoot ?? process.cwd(), "secrets.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** 该项目工作目录下的相对路径展示，用于日志。 */
export function shortPath(path) {
  if (typeof path !== "string") return "";
  return path.replace(`${dirname(config.workspace)}\\`, "");
}
